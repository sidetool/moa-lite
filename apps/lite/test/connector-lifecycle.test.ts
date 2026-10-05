import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

test('packaged connector removes playback rules on stop, disconnect and cancellation during rule installation', async () => {
  const { outputFiles } = await build({ entryPoints: [new URL('../connector/background.js', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', define: { __READER_ORIGINS__: '["https://moa.example.org"]' } });
  const rules = new Map<number, any>([[41, { id: 41 }]]), replies = new Map<string, any>();
  let connect: any, message: any, disconnect: any, release: (() => void) | undefined, hold = false;
  const api = {
    runtime: { getURL: (path: string) => 'chrome-extension://fixture/' + path, onConnect: { addListener: (fn: any) => { connect = fn; } }, onMessage: { addListener() {} } },
    permissions: { contains: async () => true },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }: any) => {
        if (hold && addRules.length) await new Promise<void>(resolve => { release = resolve; });
        for (const id of removeRuleIds) rules.delete(id);
        for (const rule of addRules) { assert(!rules.has(rule.id)); rules.set(rule.id, rule); }
      }
    }
  };
  runInNewContext(outputFiles![0].text, { chrome: api, crypto: webcrypto, URL, setTimeout, clearTimeout, TextDecoder, Uint8Array, atob });
  const port = { name: 'moa-lite-connector-v1', sender: { url: 'https://moa.example.org/', frameId: 0, tab: { id: 17 } }, postMessage: (value: any) => replies.set(value.id, value), disconnect() {}, onMessage: { addListener: (fn: any) => { message = fn; } }, onDisconnect: { addListener: (fn: any) => { disconnect = fn; } } };
  connect(port);
  const begin = (id: string) => message({ id, type: 'playback-begin', sessionId: id, request: { url: 'https://cdn.example.org/video.mp4', headers: { Referer: 'https://source.example.org/' } } });
  try {
    await Promise.all([begin('one'), begin('two')]);
    assert(!rules.has(41)); assert.equal(rules.size, 2);
    for (const rule of rules.values()) assert.equal(rule.condition.tabIds[0], 17);
    await message({ id: 'stop', type: 'playback-end', sessionId: 'one' }); assert.equal(rules.size, 1);
    disconnect(); await new Promise(resolve => setImmediate(resolve)); assert.equal(rules.size, 0);
    connect(port); hold = true;
    const installing = begin('cancelled');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await message({ id: 'cancel', type: 'cancel', requestId: 'cancelled' }); release(); await installing;
    assert.equal(replies.get('cancelled').error, 'connector_cancelled'); assert.equal(rules.size, 0);
  } finally { disconnect(); }
});
