export { getConnectorStatus, onConnectorStatusChange, type ConnectorStatus } from './connector';
import { PROFILE_HEADER, type Account } from '@moa/shared';
import { accountLock, readState, writeState } from './storage';
import { connectorAvailable, connectorHttp, prepareMedia, releaseMedia, releaseAllMedia } from './connector';
import { syncOrder } from '../sync-schema';
import { restoreImageTickets, persistImageTickets, clearImageTickets } from './image-cache';
let actor: Account | undefined, config: any, configAt = 0, sequence = 0, worker: Worker | undefined;
const jobs = new Map<string, AbortController>(), hostRequests = new Map<number, AbortController>();
const blobs = new Map<string, string>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('moa-lite') : undefined;
let active: { id: number; resolve: (value: any) => void; reject: (error: Error) => void; cancel: () => void; read: boolean } | undefined;
let bootstrap: Promise<void> | undefined;
let lastSync = 0, syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncRetryAt = 0, syncFailures = 0;
async function backgroundSync(force = false) {
  if (Date.now() < syncRetryAt || navigator.onLine === false) return;
  try { await synchronize(force); syncFailures = 0; syncRetryAt = 0; }
  catch { syncRetryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(syncFailures++, 4)); }
}
function scheduleSync(delay = 1500, force = true) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { void backgroundSync(force); }, delay);
}
export async function cloud(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<any> {
  const response = await fetch('/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal });
  if (response.status === 204) return;
  const value = await response.json();
  if (value.error === 'account-changed') { resetRuntime(); window.dispatchEvent(new Event('moa:profile-required')); }
  if (!response.ok) throw Object.assign(new Error(value.error ?? 'http-error'), { code: value.error, status: response.status, retryAfter: value.retryAfter });
  return value;
}
async function ready() {
  return bootstrap ??= (async () => {
    actor = await cloud('/me');
    const previous = localStorage.getItem('moa-lite.account');
    localStorage.setItem('moa-lite.account', actor!.id);
    channel?.postMessage({ activeAccountId: actor!.id });
    if (previous !== actor!.id) { const profile = localStorage.getItem(`moa-lite.profile.${actor!.id}`); if (profile) localStorage.setItem('moa.profile', profile); else localStorage.removeItem('moa.profile'); }
    config = await cloud('/lite/config'); configAt = Date.now();
    await synchronize().catch(() => {});
  })().catch(error => { bootstrap = undefined; throw error; });
}
async function serveHost(data: any, owner: Worker) {
  const abort = new AbortController(); hostRequests.set(data.id, abort);
  try {
    let value;
    if (data.method === 'api') value = await cloud(data.input.path, data.input.body, undefined, abort.signal);
    else if (data.method === 'http') {
      const installed = await connectorAvailable();
      if (installed) {
        try { value = await connectorHttp(data.input, abort.signal); }
        catch (error) { if (['host_permission_missing', 'connector_permission_required', 'connector_not_installed', 'connector_header_unsupported'].includes((error as Error).message)) value = await cloud('/lite/http', data.input, undefined, abort.signal); else throw error; }
      } else value = await cloud('/lite/http', data.input, undefined, abort.signal);
    } else throw new Error('invalid-host-method');
    if (worker === owner) owner.postMessage({ type: 'host-reply', id: data.id, value });
  } catch (error: any) { if (worker === owner) owner.postMessage({ type: 'host-reply', id: data.id, error: { code: error.code ?? error.message, status: error.status } }); }
  finally { if (hostRequests.get(data.id) === abort) hostRequests.delete(data.id); }
}
function getWorker() {
  if (worker) return worker;
  const created = worker = new Worker('/runtime/catalog-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (worker !== created) return;
    if (data.type === 'checkpoint') { void local('/lite/checkpoint', undefined, 'GET', undefined, null).catch(() => {}); return; }
    if (data.type === 'host') { void serveHost(data, created); return; }
    if (data.type === 'host-cancel') { hostRequests.get(data.id)?.abort(); return; }
    if (!active || data.id !== active.id) return;
    if (data.type === 'failure') active.reject(Object.assign(new Error(data.error.code), { status: data.error.status, code: data.error.code }));
    else if (data.type === 'result') active.resolve(data);
    active = undefined;
  };
  worker.onerror = () => { active?.reject(new Error('catalog-runtime-unavailable')); active = undefined; worker?.terminate(); worker = undefined; };
  return worker;
}
async function command(path: string, method: string, body: any, state: any, signal?: AbortSignal, cloudSync?: any, cloudShared?: any, profile: string | null = null) {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { status: 499 });
  return new Promise<any>((resolve, reject) => {
    const cancel = () => { signal?.removeEventListener('abort', cancel); for (const abort of hostRequests.values()) abort.abort(); hostRequests.clear(); worker?.terminate(); worker = undefined; active = undefined; reject(Object.assign(new Error('cancelled'), { status: 499 })); };
    signal?.addEventListener('abort', cancel, { once: true });
    const done = () => signal?.removeEventListener('abort', cancel);
    active = { id: ++sequence, cancel, read: !path.startsWith('/lite/') && (method === 'GET' || /\/browse(?:\?|$)|^\/playback$/.test(path)), resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); } };
    getWorker().postMessage({ type: 'request', id: active.id, path, method, body, state, actor, config, profile, cloudSync, cloudShared });
  });
}
export function cancelPendingReads() { if (active?.read) active.cancel(); }
let syncing: Promise<void> | undefined;
export async function synchronize(force = true): Promise<void> {
  if (!actor || !config) return;
  if (syncing) return syncing;
  const account = actor;
  const checkAccount = () => { if (actor?.id !== account.id || actor.role !== account.role) throw Object.assign(new Error('account-changed'), { status: 401 }); };
  return syncing = accountLock(account.id, async () => {
    checkAccount();
    let state = await readState(account.id);
    const pending = state?.sync?.pending ?? {};
    if (!force && !Object.keys(pending).length && !state?.shared?.pending && Date.now() - (state?.syncedAt ?? 0) < 60000) { lastSync = state.syncedAt; return; }
    for (let round = 0; round < 40; round++) {
      checkAccount();
      const changes = (Object.values(pending) as any[]).sort((a, b) => syncOrder(a.key) - syncOrder(b.key)).slice(0, 100);
      const response = await cloud('/lite/sync', { accountId: account.id, since: state?.sync?.revision ?? 0, changes, sharedRevision: state?.shared?.revision ?? 0 });
      checkAccount();
      const result = await command('/lite/sync-state', 'GET', {}, state, undefined, response, response.shared);
      state = result.state; await writeState(account.id, state);
      for (const change of changes as any[]) delete pending[change.key];
      if (changes.length < 100) break;
    }
    checkAccount();
    if (account.role === 'admin' && state.shared?.pending) {
      await cloud('/lite/shared', { revision: state.shared.revision, value: state.shared.pending }, 'PUT');
      state.shared = { revision: state.shared.revision + 1, value: state.shared.pending }; await writeState(account.id, state);
    }
    lastSync = state.syncedAt = Date.now(); await writeState(account.id, state); channel?.postMessage({ accountId: account.id });
  }).finally(() => { syncing = undefined; });
}
const imageTickets = new Map<string, {url: string; expires: number}>();
async function materializeImages(value: any) {
  restoreImageTickets(actor!.id, imageTickets);
  const missing = new Map<string, any>();
  const visit = (v: any) => { if (!v || typeof v !== 'object') return; if (v.__image) { const key = JSON.stringify(v.__image); if ((imageTickets.get(key)?.expires ?? 0) < Date.now()) missing.set(key, v.__image); } else for (const child of Object.values(v)) visit(child); };
  visit(value);
  const entries = [...missing];
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100), tickets = await cloud('/lite/images', {images: batch.map(([, image]) => image)});
    batch.forEach(([key], index) => imageTickets.set(key, tickets[index]));
  }
  if (entries.length) persistImageTickets(actor!.id, imageTickets);
  const output = materialize(value);
  while (imageTickets.size > 2048) imageTickets.delete(imageTickets.keys().next().value!);
  return output;
}
function materialize(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(materialize);
  if (value.__image) return imageTickets.get(JSON.stringify(value.__image))?.url;
  const result: any = {};
  if (typeof value.__content === 'string') {
    const key = actor!.id + ':' + value.id + ':' + value.__content;
    if (!blobs.has(key)) blobs.set(key, URL.createObjectURL(new Blob([value.__content], { type: value.format === 'ass' ? 'text/x-ssa' : 'text/vtt' })));
    result.url = blobs.get(key);
    while (blobs.size > 64) { const oldest = blobs.keys().next().value!; URL.revokeObjectURL(blobs.get(oldest)!); blobs.delete(oldest); }
  }
  for (const [key, field] of Object.entries(value)) if (key !== '__content' && (key !== 'url' || !result.url)) result[key] = materialize(field);
  return result;
}
async function local(path: string, body?: any, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal, profile: string | null = localStorage.getItem('moa.profile')) {
  const account = actor;
  if (!account) throw Object.assign(new Error('login-required'), { status: 401 });
  return accountLock(account.id, async () => {
    if (actor?.id !== account.id || actor.role !== account.role) throw Object.assign(new Error('account-changed'), { status: 401 });
    const state = await readState(account.id), result = await command(path, method, body, state, signal, undefined, undefined, profile);
    result.state.syncedAt = state?.syncedAt ?? 0;
    await writeState(account.id, result.state);
    if (!path.startsWith('/lite/job/')) for (const id of result.resume ?? []) queueMicrotask(() => runTranslation(id, profile));
    return materializeImages(result.value);
  });
}
function runTranslation(id: string, profile: string | null) {
  if (jobs.has(id) || !actor) return;
  const accountId = actor.id;
  const abort = new AbortController(); jobs.set(id, abort);
  void accountLock(`translation:${accountId}:${id}`, async () => {
    while (!abort.signal.aborted) {
      const step = await local('/lite/job/next', { id }, 'POST', abort.signal, profile); if (!step) break;
      let output, error;
      for (let attempt = 0; attempt <= step.retryCount; attempt++) {
        try { output = await cloud('/lite/translate', { lines: step.lines, context: step.context }, 'POST', abort.signal); break; }
        catch (failure: any) {
          error = failure.code ?? failure.message; if (abort.signal.aborted) return;
          if (failure.code === 'translation-busy') { attempt--; await new Promise(resolve => setTimeout(resolve, Math.max(100, Math.min(60000, failure.retryAfter || 1000)))); continue; }
          if (attempt < step.retryCount) await new Promise(resolve => setTimeout(resolve, Math.max(1000, step.interval)));
        }
      }
      await local('/lite/job/commit', { id, ...(output ? { output } : { error }) }, 'POST', abort.signal, profile);
      if (!output) break;
      await new Promise(resolve => setTimeout(resolve, step.interval));
    }
  }).catch(() => {}).finally(() => jobs.delete(id));
}
const remote = /^\/(?:me$|health$|lite\/|admin\/tmdb\/config|translation\/config|admin\/translation\/|admin\/accounts\/)/;
export async function liteFetch(path: string, init: RequestInit): Promise<Response> {
  const profile = new Headers(init.headers).get(PROFILE_HEADER) ?? localStorage.getItem('moa.profile');
  try {
    const endpoint = path.replace(/^\/api/, '');
    if (endpoint.startsWith('/playback/') && init.method === 'DELETE') releaseMedia(endpoint.split('/')[2]);
    if (remote.test(endpoint)) {
      const response = await fetch(path, init);
      if (endpoint === '/me' && response.ok && actor) {
        const current = await response.clone().json();
        if (current.id !== actor.id || current.role !== actor.role) { resetRuntime(); window.dispatchEvent(new Event('moa:profile-required')); }
      }
      if (response.ok && init.method === 'PATCH' && endpoint.startsWith('/admin/')) configAt = 0;
      return response;
    }
    await ready();
    if (Date.now() - configAt > 30000) {
      try { config = await cloud('/lite/config'); }
      catch (error: any) { if (error.status === 401 || error.status === 403 || !config) throw error; }
      configAt = Date.now();
    }
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    const translationId = /^\/translations\/([^/?]+)$/.exec(endpoint)?.[1];
    if (method === 'DELETE' && translationId) jobs.get(translationId)?.abort();
    const value = await local(endpoint, body, method, init.signal ?? undefined, profile);
    if (endpoint === '/playback' && value) { try { if (await prepareMedia(value.sessionId, value.url, value.headers, value.mime)) value.transport = 'connector'; } catch { /* Direct playback remains available without connector permission. */ } }
    if (endpoint.startsWith('/playback/') && method === 'DELETE') releaseMedia(endpoint.split('/')[2]);
    if (value?.state && ['queued', 'running'].includes(value.state) && value.id) runTranslation(value.id, profile);
    if (endpoint === '/progress') scheduleSync(10000);
    else if (method !== 'GET') scheduleSync();
    else if (Date.now() - lastSync > 60000) scheduleSync(1500, false);
    if (endpoint.startsWith('/playback/') && method === 'DELETE') void synchronize().catch(() => {});
    return value === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) { return new Response(JSON.stringify({ error: error.code ?? error.message ?? 'runtime-error' }), { status: error.status ?? 502, headers: { 'Content-Type': 'application/json' } }); }
}
let logoutAccountId: string | undefined;
export async function beforeLogout() {
  logoutAccountId = actor?.id;
  clearTimeout(syncTimer); for (const abort of jobs.values()) abort.abort();
  await synchronize().catch(() => {});
  resetRuntime();
}
export function afterLogout() { channel?.postMessage({logoutAccountId}); logoutAccountId = undefined; }
function resetRuntime() {
  syncFailures = 0; syncRetryAt = 0; lastSync = 0;
  if (actor) clearImageTickets(actor.id);
  clearTimeout(syncTimer); for (const abort of jobs.values()) abort.abort();
  for (const abort of hostRequests.values()) abort.abort(); hostRequests.clear();
  releaseAllMedia(); for (const url of blobs.values()) URL.revokeObjectURL(url); blobs.clear(); imageTickets.clear();
  active?.reject(Object.assign(new Error('login-required'), { status: 401 })); active = undefined;
  worker?.terminate(); worker = undefined; actor = undefined; bootstrap = undefined; config = undefined; configAt = 0;
  localStorage.removeItem('moa.profile');
}
setInterval(() => { if (document.visibilityState === 'visible') void backgroundSync(); }, 60000);
document.addEventListener('visibilitychange', () => { void backgroundSync(); });
window.addEventListener('online', () => { syncRetryAt = 0; void backgroundSync(true); });
window.addEventListener('pagehide', () => { for (const abort of jobs.values()) abort.abort(); void synchronize().catch(() => {}); });
channel?.addEventListener('message', event => {
  if (event.data.logoutAccountId && event.data.logoutAccountId === localStorage.getItem('moa-lite.account')) { resetRuntime(); window.location.replace('/__moa/login'); }
  else if (actor && (event.data.activeAccountId && event.data.activeAccountId !== actor.id)) { resetRuntime(); window.dispatchEvent(new Event('moa:profile-required')); }
  else if (event.data.accountId === actor?.id) window.dispatchEvent(new Event('moa-lite:changed'));
});
