import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaRules, playlistUrls } from '../connector/media-rules.js';
import { requestSpec, isReader } from '../connector/policy.js';
test('temporary playback rules are restricted to the approved reader, playback tab and media hosts', () => {
  const rules = mediaRules({ url: 'https://cdn.example.org/master.m3u8', headers: { Referer: 'https://source.example.org/' } }, 'https://moa-lite.example.org', 17, 101, ['https://segments.example.org/one.ts']);
  assert.equal(rules.length, 2);
  for (const rule of rules) { assert.deepEqual(rule.condition.tabIds, [17]); assert.deepEqual(rule.condition.initiatorDomains, ['moa-lite.example.org']); assert.deepEqual(rule.condition.resourceTypes, ['media', 'xmlhttprequest']); assert.equal(rule.action.responseHeaders[0].value, 'https://moa-lite.example.org'); }
  assert.equal(rules[0].action.requestHeaders[0].header, 'referer');
  assert.throws(() => mediaRules({ url: 'https://127.0.0.1/video' }, 'https://moa.example.org', 17, 101), /source_url_denied/);
});
test('playlist discovery includes relative segments, variants and encryption key hosts', () => {
  assert.deepEqual(playlistUrls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.org/key"\nvariant.m3u8\nsegments/one.ts\n', 'https://cdn.example.org/master.m3u8'), ['https://keys.example.org/key', 'https://cdn.example.org/variant.m3u8', 'https://cdn.example.org/segments/one.ts']);
  assert.deepEqual(playlistUrls('<html>denied</html>', 'https://cdn.example.org/'), []);
});
test('connector rejects child frames, unknown readers, forged header lines and unsafe requests', () => {
  assert(!isReader({ frameId: 1, tab: { id: 17 }, url: 'https://moa.example.org/' }, 'https://moa.example.org'));
  assert(!isReader({ frameId: 0, tab: { id: 17 }, url: 'https://other.example.org/' }, 'https://moa.example.org'));
  assert.throws(() => requestSpec({ url: 'https://example.org/', headers: { Referer: 'https://example.org/\r\nattack' } }), /invalid_source_invocation/);
});

import { appOrigin } from '../connector/policy.js';
import { boundedFetch } from '../connector/fetch.js';
import { createRegistration } from '../connector/registration.js';
test('stored app address is a single secure origin; reader matching is exact', () => {
  for (const origin of ['https://app.example.org', 'http://localhost:5180', 'http://127.0.0.1:5180']) assert.equal(appOrigin(origin), origin);
  for (const origin of ['https://app.example.org/', 'https://app.example.org/path', 'https://user@app.example.org', 'http://app.example.org', 'https://app.example.org?q=1', 'null']) assert.throws(() => appOrigin(origin));
  const sender = { frameId: 0, tab: { id: 1 }, url: 'https://app.example.org/path' };
  assert(isReader(sender, 'https://app.example.org'));
  assert(!isReader(sender, undefined));
  assert(!isReader(sender, 'https://app.example.org:8443'));
});
test('fetch omits cookies unless trusted transport explicitly opts in', async () => {
  const original = globalThis.fetch, credentials: unknown[] = [];
  globalThis.fetch = async (_url, options) => { credentials.push(options?.credentials); return new Response('ok'); };
  try {
    const spec = requestSpec({ url: 'https://source.example.org/' });
    await boundedFetch(spec, 'default'); await boundedFetch({ ...spec, login: true }, 'login');
    assert.deepEqual(credentials, ['omit', 'include']);
  } finally { globalThis.fetch = original; }
});
test('registration changes remove old matches, inject existing tabs and resync on startup', async () => {
  let origin = 'https://app.example.org', change: any, startup: any, installed: any;
  const registered: any[] = [], removed: any[] = [], injected: any[] = [], opened: any[] = [];
  let disconnects = 0;
  const api = {
    storage: { local: { get: async () => ({ appOrigin: origin }) }, onChanged: { addListener: (fn: any) => { change = fn; } } },
    permissions: { onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    runtime: { getURL: (s: string) => 'extension://fixture/' + s, onStartup: { addListener: (fn: any) => { startup = fn; } }, onInstalled: { addListener: (fn: any) => { installed = fn; } } },
    tabs: { query: async () => [{ id: 1, url: origin + '/page' }, { id: 2, url: 'https://other.example.org/' }], create: async (value: any) => opened.push(value), onUpdated: { addListener() {} } },
    scripting: { getRegisteredContentScripts: async () => registered.length ? [{ id: 'reader' }] : [], unregisterContentScripts: async (value: any) => removed.push(value), registerContentScripts: async (value: any) => registered.push(value), executeScript: async (value: any) => injected.push(value) }
  };
  const registration = createRegistration(api, () => disconnects++); await registration.ready();
  assert.equal(registered[0][0].runAt, 'document_start'); assert.equal(registered[0][0].persistAcrossSessions, true); assert.equal(registered[0][0].allFrames, false);
  origin = 'https://next.example.org'; change({ appOrigin: {} }, 'local'); await registration.ready();
  assert.equal(registration.origin, origin); assert.equal(disconnects, 2); assert.equal(removed.length, 1); assert.equal(injected.length, 2);
  assert.deepEqual(registered.at(-1)[0].matches, [origin + '/*']);
  startup(); await registration.ready(); assert.equal(registered.length, 3);
  installed({ reason: 'install' }); await registration.ready(); assert.equal(opened[0].url, 'extension://fixture/setup.html');
});
