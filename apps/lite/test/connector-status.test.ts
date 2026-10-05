import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
test('negative detection retries on ready and visibility; UI subscriptions unsubscribe', async () => {
  const { outputFiles } = await build({ entryPoints: [new URL('../client/connector.ts', import.meta.url).pathname], bundle: true, write: false, format: 'iife', globalName: 'client', platform: 'browser' });
  const listeners: Record<string, Function[]> = {};
  let installed = false, calls = 0;
  const window: any = { addEventListener: (name: string, fn: Function) => (listeners[name] ??= []).push(fn), postMessage: (data: any) => {
    if (data.type !== 'hello') return; calls++;
    if (installed) queueMicrotask(() => dispatch({ channel: 'moa-lite-connector-response-v1', id: data.id, value: { version: '0.1.0', hostPermission: true } }));
  } };
  const dispatch = (data: any) => { for (const fn of listeners.message) fn({ source: window, origin: 'https://app.example.org', data }); };
  const document: any = { visibilityState: 'visible', addEventListener: window.addEventListener };
  const context: any = { window, document, location: { origin: 'https://app.example.org' }, setTimeout, clearTimeout };
  runInNewContext(outputFiles![0].text, context);
  assert.equal(await context.client.connectorAvailable(), false);
  // Hot paths must not wait for another handshake timeout after a negative result.
  assert.equal(await context.client.connectorAvailable(), false); assert.equal(calls, 1);
  const updates: any[] = []; const unsubscribe = context.client.onConnectorStatusChange((value: any) => updates.push(value));
  installed = true; dispatch({ channel: 'moa-lite-connector-ready-v1', version: '0.1.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await context.client.connectorAvailable(), true); assert.equal(calls, 2);
  assert.equal(updates[0].hostPermission, true); unsubscribe();
  installed = false; listeners.visibilitychange[0](); await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(updates.length, 1);
  installed = true; assert.equal((await context.client.getConnectorStatus()).installed, true);
});

test('content announces ready only after background authorization and ignores duplicate injection', async () => {
  const { outputFiles } = await build({ entryPoints: [new URL('../connector/content.js', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser' });
  const posted: any[] = [], listeners: Record<string, Function[]> = {};
  let received: any, disconnected: any, connections = 0;
  const window: any = { addEventListener: (name: string, fn: Function) => (listeners[name] ??= []).push(fn), postMessage: (value: any) => posted.push(value) }; window.top = window;
  const api = {
    storage: { local: { get: async () => ({ appOrigin: 'https://app.example.org' }) } },
    runtime: { connect: () => { connections++; return { postMessage() {}, disconnect() {}, onMessage: { addListener: (fn: any) => { received = fn; } }, onDisconnect: { addListener: (fn: any) => { disconnected = fn; } } }; } }
  };
  const context: any = { window, chrome: api, location: { origin: 'https://app.example.org' } };
  const { createContext, runInContext } = await import('node:vm'); createContext(context);
  runInContext(outputFiles![0].text, context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.length, 0);
  received({ type: 'ready', version: '0.1.0' }); assert.equal(posted[0].channel, 'moa-lite-connector-ready-v1');
  runInContext(outputFiles![0].text, context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 1); assert.equal(listeners.message.length, 1);
  disconnected(); posted.length = 0;
  listeners.message[0]({ source: window, origin: 'https://app.example.org', data: { channel: 'moa-lite-connector-request-v1', id: 'retry', type: 'hello' } });
  assert.equal(connections, 2); assert.equal(posted.length, 0, 'a rejected reconnect must not trigger ready/retry feedback');
});
