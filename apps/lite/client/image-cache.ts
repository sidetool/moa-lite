export type ImageTicket = { url: string; expires: number };
const prefix = 'moa-lite.image-tickets.';
// Keep the same encrypted URLs across reloads/tabs so the browser HTTP image cache can hit.
export function restoreImageTickets(accountId: string, tickets: Map<string, ImageTicket>, storage = localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(prefix + accountId) ?? '[]');
    if (!Array.isArray(saved)) return;
    for (const [key, value] of saved.slice(-256)) if (typeof key === 'string' && typeof value?.url === 'string' && value.url.startsWith('/api/lite/image?ticket=') && value.expires > Date.now()) tickets.set(key, value);
  } catch { /* Storage may be disabled; normal image requests still work. */ }
}
export function persistImageTickets(accountId: string, tickets: Map<string, ImageTicket>, storage = localStorage) {
  try {
    const entries = [...tickets].filter(([, ticket]) => ticket.expires > Date.now()).slice(-256);
    let value = JSON.stringify(entries);
    while (value.length > 256 * 1024 && entries.length) { entries.shift(); value = JSON.stringify(entries); }
    storage.setItem(prefix + accountId, value);
  } catch { /* Quota or private browsing: cache is optional. */ }
}
export function clearImageTickets(accountId: string, storage = localStorage) {
  try { storage.removeItem(prefix + accountId); } catch {}
}
