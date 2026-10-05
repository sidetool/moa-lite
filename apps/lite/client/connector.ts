export type ConnectorStatus = { installed: boolean; version?: string; hostPermission?: boolean };
let status: ConnectorStatus = { installed: false };
let checking: Promise<ConnectorStatus> | undefined;
const subscribers = new Set<(status: ConnectorStatus) => void>();
function publish(next: ConnectorStatus) {
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const cb of subscribers) cb({ ...status });
}
export function onConnectorStatusChange(cb: (status: ConnectorStatus) => void) { subscribers.add(cb); return () => { subscribers.delete(cb); }; }
export function getConnectorStatus(): Promise<ConnectorStatus> {
  return checking ??= connectorCall('hello', {}, undefined, 500).then(value => {
    publish({ installed: true, version: String(value.version), hostPermission: value.hostPermission === true }); return { ...status };
  }, () => { publish({ installed: false }); return { ...status }; }).finally(() => { checking = undefined; });
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.channel === 'moa-lite-connector-ready-v1') void getConnectorStatus().then(value => { if (!value.installed) void getConnectorStatus(); });
  if (event.data?.channel === 'moa-lite-connector-disconnected-v1') publish({ installed: false });
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void getConnectorStatus(); });
let sequence = 0;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'moa-lite-connector-response-v1') return;
  const request = pending.get(event.data.id); if (!request) return;
  if (event.data.error) request.reject(new Error(event.data.error)); else request.resolve(event.data.value);
});
export function connectorCall(type: string, args: any = {}, signal?: AbortSignal, timeout = 30000): Promise<any> {
  const id = `moa-lite-${++sequence}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); pending.delete(id); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { window.postMessage({ channel: 'moa-lite-connector-request-v1', id: `cancel-${id}`, type: 'cancel', token: args.token, requestId: id }, location.origin); cleanup(); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('connector_not_installed')); }, timeout);
    pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    if (signal?.aborted) { cancel(); return; } signal?.addEventListener('abort', cancel, { once: true });
    window.postMessage({ channel: 'moa-lite-connector-request-v1', id, type, ...args }, location.origin);
  });
}
export async function connectorAvailable() {
  return status.installed || (await getConnectorStatus()).installed;
}
export async function connectorHttp(input: any, signal?: AbortSignal) {
  const { token } = await connectorCall('begin', { action: 'videos' }, signal);
  try { return await connectorCall('http', { token, request: input }, signal); }
  finally { void connectorCall('end', { token }).catch(() => {}); }
}
const mediaSessions = new Set<string>();
export async function prepareMedia(sessionId: string, url: string, headers: Record<string, string> = {}, mime?: string) {
  if (!await connectorAvailable()) return false;
  await connectorCall('playback-begin', { sessionId, request: { url, headers }, mime }); mediaSessions.add(sessionId); return true;
}
export function releaseMedia(sessionId: string) { if (mediaSessions.delete(sessionId)) void connectorCall('playback-end', { sessionId }).catch(() => {}); }
export function releaseAllMedia() { for (const id of mediaSessions) releaseMedia(id); }
window.addEventListener('pagehide', releaseAllMedia);
