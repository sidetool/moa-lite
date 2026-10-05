import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { authDatabase } from '../server/auth.js';
import { createLiteApplication } from '../server/app.js';
import { MemoryDocuments, RedisDocuments } from '../server/documents.js';
import { encrypt, decrypt } from '../server/secrets.js';
import { sourceHttp } from '../server/network.js';
import { fixtureTransport } from './fixtures.js';
const secret = 'moa-lite-secret-test-1234567890123456789';
test('encrypted provider keys are authenticated and cannot be decrypted with another app secret', () => {
  const value = encrypt({ token: 'provider-secret' }, secret);
  assert(!value.includes('provider-secret')); assert.equal(decrypt(value, secret).token, 'provider-secret');
  assert.throws(() => decrypt(value, secret + 'wrong'));
  const changed = Buffer.from(value, 'base64'); changed[changed.length - 1] ^= 1; assert.throws(() => decrypt(changed.toString('base64'), secret));
});
test('metadata relay rejects videos, private networks and oversized requests', async () => {
  for (const url of ['https://example.com/movie.mp4', 'https://example.com/segment.ts', 'https://example.com/part.m4s']) await assert.rejects(sourceHttp({ url }, AbortSignal.timeout(1000)), /video-relay-unavailable/);
  await assert.rejects(sourceHttp({ url: 'https://127.0.0.1/' }, AbortSignal.timeout(1000)), /source_address_denied/);
  await assert.rejects(sourceHttp({ url: 'https://example.com', method: 'POST', body: 'x'.repeat(512 * 1024 + 1) }, AbortSignal.timeout(1000)), /invalid-source-invocation/);
});
test('serverless API derives account permissions from the session and requires same-origin mutations', async () => {
  const store = new MemoryDocuments(), db = await authDatabase(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('member', 'member', '00', '00', 'member', Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'member', Date.now() + 60000, Date.now(), 0);
  await store.compareSet('auth', 0, Buffer.from(db.export()).toString('base64')); db.close();
  let origin = ''; const server = createServer((req, res) => createLiteApplication({ store, secret, setupCode: 'LITE-TEST-SETU-P001', origin, transport: fixtureTransport }).handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const cookie = `moa_session=${token}`;
  try {
    assert.equal((await fetch(origin + '/api/me')).status, 401);
    const me = await fetch(origin + '/api/me', { headers: { Cookie: cookie, 'X-Moa-Role': 'admin' } }); assert.equal((await me.json()).role, 'member');
    assert.equal((await fetch(origin + '/api/lite/diagnostics', { headers: { Cookie: cookie, 'X-Moa-Role': 'admin' } })).status, 403);
    assert.equal((await fetch(origin + '/api/lite/sync', { method: 'POST', headers: { Cookie: cookie }, body: '{"since":0,"changes":[]}' })).status, 403);
    assert.equal((await fetch(origin + '/api/admin/tmdb/config', { method: 'PATCH', headers: { Cookie: cookie, Origin: origin }, body: '{"clear":true}' })).status, 403);
    assert.equal((await fetch(origin + '/api/lite/shared', { method: 'PUT', headers: { Cookie: cookie, Origin: origin }, body: '{"revision":0,"value":{}}' })).status, 403);
    assert.equal((await fetch(origin + '/api/lite/sync', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: '{"since":0,"changes":[]}' })).status, 200);
    assert.deepEqual((await fetch(origin + '/api/lite/config', { headers: { Cookie: cookie } }).then(r => r.json())).tmdb, { configured: false, source: 'none', credentialType: null, hasSavedCredential: false });
    assert.equal((await fetch(origin + '/api/lite/http', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: '{"url":"https://fixture.example.org/list"}' })).status, 200);
    assert.equal((await fetch(origin + '/__moa/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Moa-Request': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 204);
    assert.equal((await fetch(origin + '/api/me', { headers: { Cookie: cookie } })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('Gemini auth keys persist encrypted and reach models and translation unchanged after app restart', async () => {
  const authKey = 'AQ.Ab' + 'x'.repeat(48), standardKey = 'AIza' + 'y'.repeat(35);
  const store = new MemoryDocuments(), db = await authDatabase(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('admin', 'admin', '00', '00', 'admin', Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'admin', Date.now() + 60000, Date.now(), 0);
  await store.compareSet('auth', 0, Buffer.from(db.export()).toString('base64')); db.close();
  const used: string[] = [];
  const translationFetch: typeof fetch = async (url, init) => {
    const key = new Headers(init?.headers).get('x-goog-api-key')!;
    used.push(key);
    assert.ok(!String(url).includes(key)); assert.ok(!String(init?.body).includes(key));
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    if (!init?.body) return Response.json({ models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }] });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ lines: [{ id: 0, text: '안녕' }] }) }] } }] });
  };
  let origin = '', app: ReturnType<typeof createLiteApplication>;
  const create = () => createLiteApplication({ store, secret, setupCode: 'LITE-TEST-SETU-P001', origin, translationFetch });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  app = create();
  const request = (path: string, value?: unknown, method = value === undefined ? 'GET' : 'PATCH') => fetch(origin + path, {
    method, headers: { Cookie: `moa_session=${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value),
  });
  try {
    const save = await request('/api/admin/translation/config', { addKeys: ['  ' + authKey + '\t', standardKey, authKey], requestIntervalMs: 0 });
    assert.equal(save.status, 200);
    const view = await save.text(); assert.equal(JSON.parse(view).keys.length, 2);
    for (const key of [authKey, standardKey]) assert.ok(!view.includes(key));
    const stored = await store.get('secrets');
    assert.ok(!stored.value.includes(authKey)); assert.deepEqual(decrypt(stored.value, secret).translation.apiKeys, [authKey, standardKey]);
    for (const payload of [{ addKeys: ['short'] }, { addKeys: [authKey + '\r\nX-Test: invalid'] }, { addKeys: ['x'.repeat(257)] }, { apiKey: 42 }, { apiKey: '' }, { addKeys: [authKey + '한글'] }, { addKeys: 'not-an-array' }]) {
      assert.equal((await request('/api/admin/translation/config', payload)).status, 400);
    }
    assert.equal((await store.get('secrets')).revision, stored.revision);
    app = create();
    assert.equal((await request('/api/translation/config').then(r => r.json())).configured, true);
    const models = await request('/api/admin/translation/models'); assert.equal(models.status, 200); assert.deepEqual((await models.json()).models, ['gemini-flash-latest']);
    for (let turn = 0; turn < 2; turn++) {
      const result = await request('/api/lite/translate', { lines: [{ id: 0, text: 'Hello' }], context: { title: 'Fixture', sourceLanguage: 'en' } }, 'POST');
      assert.equal(result.status, 200); assert.deepEqual(await result.json(), { '0': '안녕' });
    }
    assert.deepEqual(used, [authKey, authKey, standardKey]);
    assert.equal((await request('/api/admin/translation/config', { apiKey: '\t' + authKey + ' ' })).status, 200);
    assert.ok(decrypt((await store.get('secrets')).value, secret).translation.apiKeys.includes(authKey));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Redis REST transport preserves revisions, CAS arguments, expiry and server-only authorization', async () => {
  const commands: any[][] = [];
  const server = createServer(async (req, res) => { assert.equal(req.headers.authorization, 'Bearer redis-test-token'); const chunks = []; for await (const chunk of req) chunks.push(chunk); const command = JSON.parse(Buffer.concat(chunks).toString()); commands.push(command); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: command[0] === 'GET' ? '{"revision":7,"value":{"test":true}}' : 1 })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new RedisDocuments(`http://127.0.0.1:${(server.address() as any).port}`, 'redis-test-token', 'test');
  try { assert.equal((await store.get('shared')).revision, 7); assert(await store.compareSet('shared', 7, { value: true }, 60)); assert(await store.rate('account', 30, 60));
    assert.deepEqual(commands[0], ['GET', 'test:shared']); assert.deepEqual(commands[1].slice(2), [1, 'test:shared', 7, '{"revision":8,"value":{"value":true}}', 60]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
