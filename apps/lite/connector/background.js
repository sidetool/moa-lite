import { followSourceRedirects } from './redirects.js';
// SPDX-License-Identifier: GPL-3.0-or-later
import { sourceUrl, requestSpec, isReader, limits } from './policy.js';
import { boundedFetch, cancelFetch } from './fetch.js';
import { mediaRules, playlistUrls } from './media-rules.js';
const api = globalThis.browser ?? chrome;
import { createRegistration } from './registration.js';
const sessions = new Set();
const registration = createRegistration(api, origin => { for (const state of sessions) if (!isReader(state.sender, origin)) state.disconnect(); });
const responseObservers = new Set();
// Register once at service-worker startup. Per-request registration can race the
// network process and lose the first redirect's otherwise opaque headers.
api.webRequest?.onHeadersReceived.addListener(details => {
  for (const observer of responseObservers) observer(details);
}, {urls:['<all_urls>'],types:['xmlhttprequest']}, ['responseHeaders', ...(api.runtime.getURL('/').startsWith('chrome-extension:') ? ['extraHeaders'] : [])]);
let nextRule = 100, headerQueue = Promise.resolve(), activeImages = 0;
// Only temporary rules made by this extension exist. Clear leftovers after a background restart.
const ready = api.declarativeNetRequest.getSessionRules().then(rules => api.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id) }));
let pendingQueue = Promise.resolve();
function remember(origin, denied = false) {
  pendingQueue = pendingQueue.catch(() => {}).then(async () => {
    const { pending = {} } = await api.storage.local.get('pending');
    pending[origin] = { denied, at: Date.now() };
    const entries = Object.entries(pending).sort((a,b) => b[1].at-a[1].at).slice(0,32);
    await api.storage.local.set({ pending: Object.fromEntries(entries) });
  });
  return pendingQueue;
}
async function permission(origin) {
  if (!await api.permissions.contains({ origins: [origin + '/*'] })) { throw new Error('host_permission_missing'); }
}
function transport(spec, requestId, state) { return followSourceRedirects(spec, next => transportHop(next, requestId, state)); }
const hopQueues = new Map();
function transportHop(spec, requestId, state) {
  const started = Date.now(), key = spec.url;
  const work = (hopQueues.get(key) ?? Promise.resolve()).catch(()=>{}).then(() => {
    const timeoutMs = spec.timeoutMs - (Date.now() - started);
    if (timeoutMs <= 0) throw new Error('source_request_timeout');
    return transportHopOnce({...spec,timeoutMs},requestId,state);
  });
  hopQueues.set(key,work);
  void work.finally(()=>{if(hopQueues.get(key)===work)hopQueues.delete(key);}).catch(()=>{});
  return work;
}
async function transportHopOnce(spec, requestId, state) {
  await ready; await permission(spec.origin);
  for (const key of ['referer','origin']) if (spec.special[key]) await permission(new URL(spec.special[key]).origin);
  const { authTabs = {}, loginOrigins = [] } = await api.storage.local.get(['authTabs', 'loginOrigins']);
  spec = { ...spec, login: loginOrigins.includes(spec.origin) };
  let authTab;
  if (spec.login && Number.isInteger(authTabs[spec.origin])) {
    try { const tab = await api.tabs.get(authTabs[spec.origin]); if (new URL(tab.url).origin === spec.origin) authTab = tab.id; } catch {}
  }
  const check = () => { if (state.cancelled || state.cancelledIds.has(requestId)) throw new Error('connector_cancelled'); };
  check();
  const operation = { cancel: () => { cancelFetch(requestId); if (authTab !== undefined) void api.scripting.executeScript({ target: { tabId: authTab }, func: cancelFetch, args: [requestId] }).catch(() => {}); } };
  state.operations.set(requestId, operation);
  let release, rule, captured;
  const listener = details => {
    if (details.url !== spec.url || (authTab !== undefined ? details.tabId !== authTab : details.initiator !== api.runtime.getURL('').replace(/\/$/,'') && !details.originUrl?.startsWith(api.runtime.getURL('')))) return;
    const headers = {};
    for (const header of details.responseHeaders ?? []) {
      const name = header.name.toLowerCase(), value = header.value ?? String.fromCharCode(...(header.binaryValue ?? []));
      headers[name] = headers[name] ? headers[name]+', '+value : value;
    }
    captured = {statusCode:details.statusCode, headers};
  };
  // Fetch hides manual redirect status/Location; the authorized extension observes
  // the response headers without allowing an unvalidated automatic redirect.
  responseObservers.add(listener);
  const finish = result => {
    if (result.opaqueRedirect && !captured) throw new Error('source_redirect_unavailable');
    return {...result, ...(captured ?? {}), contentType:spec.image && !result.opaqueRedirect ? result.contentType : captured?.headers['content-type'] ?? result.contentType ?? ''};
  };
  try {
    if (Object.keys(spec.special).length) {
      const previous = headerQueue;
      headerQueue = new Promise(resolve => { release = resolve; });
      await previous; check();
      rule = ++nextRule;
      const extensionHost = new URL(api.runtime.getURL('/')).hostname;
      await api.declarativeNetRequest.updateSessionRules({ addRules: [{ id: rule, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: Object.entries(spec.special).map(([header,value]) => ({ header, operation: 'set', value })) },
        condition: { regexFilter: '^' + spec.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', ...(authTab === undefined ? {initiatorDomains:[extensionHost]} : {tabIds:[authTab]}), resourceTypes: ['xmlhttprequest'] } }] });
    }
    check();
    if (authTab !== undefined) {
      // Origin is supplied by the real source page. Never copy its cookies to the reader.
      const rows = await api.scripting.executeScript({ target: { tabId: authTab }, func: boundedFetch, args: [{ ...spec, inTab: true }, requestId] });
      check();
      if (!rows[0]?.result || rows[0].error) throw new Error('connector_auth_fetch_failed');
      return finish(rows[0].result);
    }
    return finish(await boundedFetch(spec, requestId));
  } finally {
    responseObservers.delete(listener);
    state.operations.delete(requestId);
    if (rule) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule] }).catch(() => {});
    release?.();
  }
}
function stop(state) { state.cancelled = true; for (const op of state.operations.values()) op.cancel(); }
api.runtime.onConnect.addListener(port => {
  if (port.name !== 'moa-lite-connector-v1') { port.disconnect(); return; }
  const jobs = new Map(), operations = new Map(), inflight = new Set();
  const media = new Map();
  const state = { sender: port.sender, disconnect: () => { cleanup(); port.disconnect(); }, operations, cancelledIds: new Set(), cancelled: false }; sessions.add(state);
  const send = value => { try { port.postMessage(value); } catch {} };
  function end(token) { const job = jobs.get(token); if (job) { stop(job); clearTimeout(job.timer); jobs.delete(token); } }
  async function endMedia(id) {
    const value = media.get(id); if (!value) return;
    media.delete(id); clearTimeout(value.timer);
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: value.ids }).catch(() => {});
  }
  function cleanup() { stop(state); for (const key of jobs.keys()) end(key); for (const id of media.keys()) void endMedia(id); sessions.delete(state); }
  port.onDisconnect.addListener(cleanup);
  void registration.ready().then(() => {
    if (state.cancelled || !isReader(port.sender, registration.origin)) state.disconnect();
    else send({ type: 'ready', version: '0.1.0' });
  });
  port.onMessage.addListener(async message => {
    await registration.ready();
    const { id, type } = message ?? {};
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || inflight.has(id) || inflight.size >= 16) return;
    inflight.add(id);
    try {
      let value;
      if (state.cancelled || !isReader(port.sender, registration.origin)) throw new Error('permission_denied');
      if (type === 'hello') value = { version: '0.1.0', origin: registration.origin, hostPermission: await api.permissions.contains({ origins: ['https://*/*'] }) };
      else if (type === 'cancel') { const target = jobs.get(message.token) ?? state; if (inflight.has(message.requestId)) { target.cancelledIds.add(message.requestId); target.operations.get(message.requestId)?.cancel(); } value = { ok: true }; }
      else if (type === 'end') { end(message.token); value = { ok: true }; }
      else if (type === 'begin') {
        if (jobs.size >= 4 || !['metadata','preferences','list','detail','chapters','pages','html','headers','videos','filters'].includes(message.action)) throw new Error('runtime_busy');
        const token = crypto.randomUUID();
        const timeout = message.action === 'chapters' ? 600000 : ['pages','html'].includes(message.action) ? 150000 : 30000;
        const job = { operations: new Map(), cancelledIds: new Set(), pending: 0, cancelled: false, calls: 0, bytes: 0, action: message.action, timer: setTimeout(() => end(token), timeout) };
        jobs.set(token, job); value = { token };
      } else if (type === 'playback-end') {
        await endMedia(message.sessionId); value = { ok: true };
      } else if (type === 'playback-begin') {
        if (typeof message.sessionId !== 'string' || !/^[\w-]{1,80}$/.test(message.sessionId) || media.size >= 4) throw new Error('runtime_busy');
        await ready;
        const spec = requestSpec(message.request), urls = [];
        await permission(spec.origin);
        for (const key of ['referer', 'origin']) if (spec.special[key]) await permission(new URL(spec.special[key]).origin);
        // Read small playlists only. Media and segments are fetched by the playback tab itself.
        if (message.mime === 'application/vnd.apple.mpegurl' || /\.m3u8(?:\?|$)/i.test(spec.url)) {
          const first = await transport(spec, id, state);
          const text = new TextDecoder().decode(Uint8Array.from(atob(first.bytes), ch => ch.charCodeAt(0)));
          urls.push(...playlistUrls(text, first.finalUrl ?? spec.url));
          if (first.finalUrl !== spec.url) urls.push(first.finalUrl);
          for (const variant of urls.filter(url => /\.m3u8(?:\?|$)/i.test(url)).slice(0, 8)) {
            const next = await transport(requestSpec({ ...message.request, url: variant }), id, state);
            urls.push(...playlistUrls(new TextDecoder().decode(Uint8Array.from(atob(next.bytes), ch => ch.charCodeAt(0))), next.finalUrl ?? variant));
          }
        }
        const rules = mediaRules(message.request, new URL(port.sender.url).origin, port.sender.tab.id, nextRule + 1, urls);
        nextRule += rules.length;
        for (const origin of new Set(urls.map(url => sourceUrl(url).origin))) await permission(origin);
        if (state.cancelled || state.cancelledIds.has(id)) throw new Error('connector_cancelled');
        await endMedia(message.sessionId);
        await api.declarativeNetRequest.updateSessionRules({ addRules: rules });
        if (state.cancelled || state.cancelledIds.has(id)) { await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) }); throw new Error('connector_cancelled'); }
        media.set(message.sessionId, { ids: rules.map(rule => rule.id), timer: setTimeout(() => { void endMedia(message.sessionId); }, 6 * 3600000) });
        value = { ok: true };
      } else if (type === 'http' || type === 'image') {
        const image = type === 'image', job = image ? state : jobs.get(message.token);
        if (!job || job.cancelled) throw new Error('runtime_expired');
        if (image ? activeImages >= 3 : ['metadata','preferences'].includes(job.action) || job.pending >= 4 || ++job.calls > 240) throw new Error('runtime_busy');
        const spec = requestSpec(message.request, image);
        if (image) activeImages++; else job.pending++;
        try {
          value = await transport(spec, id, job);
          if (!image && (job.bytes += value.size) > limits.job) { end(message.token); throw new Error('source_body_limit'); }
          if ([401,403].includes(value.statusCode)) await remember(spec.origin, true);
        } catch (error) { if (error.message === 'source_access_denied') await remember(spec.origin, true); throw error; }
        finally { if (image) activeImages--; else job.pending--; job.cancelledIds.delete(id); }
      } else throw new Error('permission_denied');
      send({ id, value });
    } catch (error) { send({ id, error: /^[a-z_]+$/.test(error.message) ? error.message : 'connector_failed' }); }
    finally { inflight.delete(id); state.cancelledIds.delete(id); }
  });
});
// Only packaged setup/popup pages may opt into authenticated source tabs.
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (![api.runtime.getURL('popup.html'), api.runtime.getURL('setup.html')].includes(sender.url) || message?.type !== 'open-auth') return;
  (async () => {
    const url = sourceUrl(message.origin); await permission(url.origin);
    const tab = await api.tabs.create({ url: url.origin + '/', active: true });
    const { authTabs = {}, loginOrigins = [] } = await api.storage.local.get(['authTabs', 'loginOrigins']);
    authTabs[url.origin] = tab.id;
    await api.storage.local.set({ authTabs, loginOrigins: [...new Set([...loginOrigins, url.origin])] }); return { ok: true };
  })().then(respond, () => respond({ error: 'connector_failed' }));
  return true;
});
