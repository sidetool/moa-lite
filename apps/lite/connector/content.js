// SPDX-License-Identifier: GPL-3.0-or-later
(async () => {
  if (window !== window.top) return;
  const api = globalThis.browser ?? chrome;
  const { appOrigin } = await api.storage.local.get('appOrigin');
  if (appOrigin !== location.origin) return;
  if (globalThis.__moaLiteConnectorConnect) { globalThis.__moaLiteConnectorConnect(); return; }
  let port;
  function connect() {
    if (port) return port;
    port = api.runtime.connect({ name: 'moa-lite-connector-v1' });
    port.onMessage.addListener(message => {
      if (message.type === 'ready') window.postMessage({ channel: 'moa-lite-connector-ready-v1', version: message.version }, location.origin);
      else window.postMessage({ channel: 'moa-lite-connector-response-v1', ...message }, location.origin);
    });
    port.onDisconnect.addListener(() => { port = null; window.postMessage({ channel: 'moa-lite-connector-disconnected-v1' }, location.origin); });
    return port;
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'moa-lite-connector-request-v1') return;
    const data = event.data;
    if (typeof data.id !== 'string' || !['hello','begin','http','image','end','cancel','playback-begin','playback-end'].includes(data.type)) return;
    try { connect().postMessage(data); } catch { window.postMessage({ channel: 'moa-lite-connector-response-v1', id: data.id, error: 'connector_disconnected' }, location.origin); }
  });
  globalThis.__moaLiteConnectorConnect = connect;
  connect();
  window.addEventListener('pageshow', connect);
  window.addEventListener('pagehide', () => { port?.disconnect(); port = null; });
})();
