let opened: Promise<IDBDatabase> | undefined;
function database() {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('moa-lite', 2);
    request.onupgradeneeded = () => { for (const name of ['accounts', 'locks']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('local-storage-unavailable'));
  });
}
export async function readState(accountId: string): Promise<any> {
  const db = await database();
  return new Promise((resolve, reject) => { const request = db.transaction('accounts').objectStore('accounts').get(accountId); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(new Error('local-storage-unavailable')); });
}
export async function writeState(accountId: string, state: any) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['accounts', 'locks'], 'readwrite'), owner = leases.get(accountId);
    if (owner) {
      const request = transaction.objectStore('locks').get(accountId);
      request.onsuccess = () => { if (request.result?.owner !== owner || request.result?.until < Date.now()) transaction.abort(); else transaction.objectStore('accounts').put(state, accountId); };
    } else transaction.objectStore('accounts').put(state, accountId);
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('local-storage-unavailable'));
  });
}
const leases = new Map<string, string>();
async function lease(accountId: string, owner: string, release = false): Promise<boolean> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('locks', 'readwrite'), store = transaction.objectStore('locks'), request = store.get(accountId); let acquired = false;
    request.onsuccess = () => { const row = request.result; if (release) { if (row?.owner === owner) store.delete(accountId); } else if (!row || row.until < Date.now() || row.owner === owner) { store.put({ owner, until: Date.now() + 45000 }, accountId); acquired = true; } };
    transaction.oncomplete = () => resolve(acquired); transaction.onerror = () => reject(new Error('local-storage-unavailable'));
  });
}
const queues = new Map<string, Promise<void>>();
export function accountLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(`moa-lite:${accountId}`, async () => await task()) as Promise<T>;
  // IDB transactions provide the fallback lease. Writes verify the owner to fence suspended tabs.
  const operation = (queues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const owner = crypto.randomUUID();
    while (!await lease(accountId, owner)) await new Promise(resolve => setTimeout(resolve, 100));
    leases.set(accountId, owner);
    const heartbeat = setInterval(() => { void lease(accountId, owner).catch(() => {}); }, 10000);
    try { return await task(); }
    finally { clearInterval(heartbeat); leases.delete(accountId); await lease(accountId, owner, true); }
  });
  const tail = operation.then(() => {}, () => {}); queues.set(accountId, tail);
  void tail.then(() => { if (queues.get(accountId) === tail) queues.delete(accountId); });
  return operation;
}
