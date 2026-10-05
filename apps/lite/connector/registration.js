// SPDX-License-Identifier: GPL-3.0-or-later
import { appOrigin } from './policy.js';
export function createRegistration(api, changed) {
  let origin, queue = Promise.resolve(), fallback = false;
  const inject = async tab => {
    try {
      if (origin && new URL(tab.url).origin === origin) await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] });
    } catch { /* Closed, restricted or permission-revoked tab. */ }
  };
  const sync = () => queue = queue.catch(() => {}).then(async () => {
    const saved = await api.storage.local.get('appOrigin');
    let next; try { next = appOrigin(saved.appOrigin); } catch {}
    if (origin !== next) { origin = next; changed(origin); }
    fallback = !api.scripting.registerContentScripts;
    if (!fallback) {
      const scripts = await api.scripting.getRegisteredContentScripts({ ids: ['reader'] });
      if (scripts.length) await api.scripting.unregisterContentScripts({ ids: ['reader'] });
      if (origin) {
        // Match patterns cannot restrict ports; content/background check exact origin.
        const url = new URL(origin), matches = [url.protocol + '//' + url.hostname + '/*'];
        try { await api.scripting.registerContentScripts([{ id: 'reader', matches, js: ['content.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true }]); }
        catch { fallback = true; }
      }
    }
    for (const tab of await api.tabs.query({})) await inject(tab);
  });
  api.tabs.onUpdated.addListener((_id, change, tab) => { if (fallback && (change.status === 'loading' || change.status === 'complete')) void inject(tab); });
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.appOrigin) void sync().catch(() => {}); });
  api.permissions.onAdded.addListener(() => { void sync().catch(() => {}); });
  api.permissions.onRemoved.addListener(() => { changed(); void sync().catch(() => {}); });
  api.runtime.onStartup.addListener(() => { void sync().catch(() => {}); });
  api.runtime.onInstalled.addListener(details => {
    void sync().catch(() => {});
    if (details.reason === 'install') void api.tabs.create({ url: api.runtime.getURL('setup.html') });
  });
  void sync().catch(() => {});
  return { get origin() { return origin; }, ready: () => queue.catch(() => {}) };
}
