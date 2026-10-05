import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { MemoryDocuments, RedisDocuments } from '../server/documents.js';
import { createLiteApplication } from '../server/app.js';
import { authDatabase, authenticate, AuthCache } from '../server/auth.js';
import { restoreImageTickets, persistImageTickets, clearImageTickets, type ImageTicket } from '../client/image-cache.js';
import { encrypt } from '../server/secrets.js';
import { InstanceRateLimiter } from '../server/rate-limit.js';
import type { IncomingMessage } from 'node:http';
import { fixtureTransport } from './fixtures.js';

test('Redis conditional reads and compressed snapshots reduce bytes without stale reads or shared mutations', async (t) => {
  const records = new Map<string, string>(); let responseBytes = 0, requestBytes = 0, unavailable = false; const commands: any[][] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); requestBytes += body.length;
    const command = JSON.parse(body.toString()); commands.push(command); let result: unknown;
    if (unavailable) { res.writeHead(503); res.end('{"error":"offline"}'); return; }
    if (command[0] === 'GET') result = records.get(command[1]) ?? null;
    else if (command[1].includes('local cached=')) { const raw = records.get(command[3]); result = !raw ? '' : createHash('sha1').update(raw).digest('hex') === command[4] ? null : raw; }
    else { const old = JSON.parse(records.get(command[3]) ?? '{"revision":0}'); result = old.revision === command[4] ? 1 : 0; if (result) records.set(command[3], command[5]); }
    const output = JSON.stringify({ result }); responseBytes += Buffer.byteLength(output); res.setHeader('Content-Type', 'application/json'); res.end(output);
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, store = new RedisDocuments(origin, 'test', 'quota'), other = new RedisDocuments(origin, 'test', 'quota');
  try {
    const value = { rows: Array.from({ length: 1000 }, (_, id) => ({ id, title: 'Fixture title', position: 123, duration: 1200 })) };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert(await store.compareSet('shared', 0, value)); assert(requestBytes < bytes / 3);
    const compressedBytes = Buffer.byteLength(records.get('quota:shared')!);
    assert.deepEqual((await store.get('shared')).value, value);
    const before = responseBytes;
    const row = await store.get('shared'); row.value.rows[0].position = 999;
    assert.equal((await store.get('shared')).value.rows[0].position, 123);
    assert(responseBytes - before < 100);
    const unchangedBytes = responseBytes - before;
    assert(await other.compareSet('shared', 1, { changed: true }));
    assert.deepEqual((await store.get('shared')).value, { changed: true });
    records.delete('quota:shared'); assert.equal((await store.get('shared')).value, null);
    assert(await other.compareSet('shared', 0, { recreated: true }));
    assert.deepEqual((await store.get('shared')).value, { recreated: true });
    // Same revision with different contents (expiry/restore) must never reuse the old cache.
    records.set('quota:shared', '{"revision":1,"value":{"restored":true}}');
    assert.deepEqual((await store.get('shared')).value, { restored: true });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const db = await authDatabase(), token = 'a'.repeat(43), cache = new AuthCache();
    db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('a', 'a', '00', '00', 'admin', Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'a', Date.now() + 45_000, Date.now(), 0);
    await store.compareSet('auth', 0, Buffer.from(db.export()).toString('base64')); db.close();
    const req = { headers: { cookie: `moa_session=${token}` } } as IncomingMessage;
    assert.equal((await authenticate(store, req, cache))?.id, 'a');
    const readCount = commands.length;
    for (let i = 0; i < 5; i++) assert.equal((await authenticate(store, req, cache))?.id, 'a');
    t.mock.timers.tick(29_999); await authenticate(store, req, cache);
    assert.equal(commands.length, readCount);
    t.mock.timers.tick(1);
    await Promise.all(Array.from({ length: 5 }, () => authenticate(store, req, cache)));
    assert.equal(commands.length, readCount + 1);
    assert.equal(commands.at(-1)![0], 'EVAL'); assert.match(commands.at(-1)![1], /local cached=/);
    // Expiry must be checked even while the cached document is fresh.
    t.mock.timers.tick(14_999); assert.equal((await authenticate(store, req, cache))?.id, 'a');
    t.mock.timers.tick(1); assert.equal(await authenticate(store, req, cache), null);
    assert.equal(commands.length, readCount + 1);
    unavailable = true; await assert.rejects(store.get('shared'), /storage-unavailable/);
    console.log(`Redis fixture: ${bytes} raw bytes -> ${compressedBytes} stored bytes; two unchanged read responses: ${unchangedBytes} bytes`);
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
});

test('combined sync omits unchanged source code and relay avoids secrets reads; logout remains immediate', async () => {
  class Counted extends MemoryDocuments {
    reads: string[] = []; writes: string[] = []; rateCalls: string[] = [];
    override async get(key: string) { this.reads.push(key); return super.get(key); }
    override async compareSet(key: string, revision: number, value: any, ttl?: number) { this.writes.push(key); return super.compareSet(key, revision, value, ttl); }
    override async rate(key: string, limit: number, seconds: number) { this.rateCalls.push(key); return super.rate(key, limit, seconds); }
    reset() { this.reads = []; this.writes = []; this.rateCalls = []; }
  }
  const store = new Counted(), db = await authDatabase(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('a', 'a', '00', '00', 'admin', Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'a', Date.now() + 60000, Date.now(), 0);
  await store.compareSet('auth', 0, Buffer.from(db.export()).toString('base64')); db.close();
  await store.compareSet('shared', 0, { repositories: [], sources: [{ code: 'large source '.repeat(10000) }] });
  let app: ReturnType<typeof createLiteApplication>;
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  app = createLiteApplication({ store, origin, secret: 'quota-test-secret-1234567890123456789', setupCode: 'LITE-TEST-SETU-P001', transport: async (input, signal) => input.url === 'https://fixture.example.org/poster.png'
    ? { ...await fixtureTransport({ url: 'https://fixture.example.org/list' }, signal), contentType: 'image/png', bytes: Buffer.from('synthetic-image').toString('base64') }
    : fixtureTransport(input, signal) });
  const headers = { Cookie: `moa_session=${token}`, Origin: origin, 'Content-Type': 'application/json' };
  const sync = (revision: number) => fetch(origin + '/api/lite/sync', { method: 'POST', headers, body: JSON.stringify({ since: 0, changes: [], sharedRevision: revision }) }).then(r => r.json());
  try {
    const first = await sync(0); assert.equal(first.shared.revision, 1);
    const next = await sync(1); assert.equal(next.shared, undefined); assert(JSON.stringify(next).length < 100);
    store.reset(); await sync(1);
    assert.deepEqual(store.reads, ['sync:a', 'shared']); assert.deepEqual(store.writes, []); assert.deepEqual(store.rateCalls, []);
    store.reset();
    assert.equal((await fetch(origin + '/api/lite/config', { headers })).status, 200);
    assert.deepEqual(store.reads, ['secrets']);
    store.reset();
    assert.equal((await fetch(origin + '/api/lite/http', { method: 'POST', headers, body: '{"url":"https://fixture.example.org/list"}' })).status, 200);
    assert.deepEqual(store.reads, []); assert.deepEqual(store.rateCalls, []); assert.deepEqual(store.writes, []);
    const ticketResponse = await fetch(origin + '/api/lite/images', { method: 'POST', headers, body: JSON.stringify({ images: [{ url: 'https://fixture.example.org/poster.png', headers: { Referer: 'https://fixture.example.org/' } }] }) });
    const [ticket] = await ticketResponse.json();
    store.reset();
    const image = await fetch(origin + ticket.url, { headers });
    assert.equal(image.status, 200); assert.equal(await image.text(), 'synthetic-image');
    assert.equal(image.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    // Cookie presence is sufficient; images never validate sessions against storage.
    assert.equal((await fetch(origin + ticket.url, { headers: { Cookie: `__Host-moa_session=${'z'.repeat(43)}` } })).status, 200);
    assert.equal((await fetch(origin + ticket.url)).status, 401);
    for (const url of ['/api/lite/image?url=https://fixture.example.org/poster.png', '/api/lite/image?ticket=broken', '/api/lite/image?ticket=' + encodeURIComponent(encrypt({ url: 'https://fixture.example.org/poster.png', headers: {}, accountId: 'a', expires: Date.now() - 1 }, 'quota-test-secret-1234567890123456789'))]) {
      assert.equal((await fetch(origin + url, { headers })).status, 403);
    }
    assert.deepEqual([store.reads, store.writes, store.rateCalls], [[], [], []]);
    const nonImage = '/api/lite/image?ticket=' + encodeURIComponent(encrypt({ url: 'https://fixture.example.org/list', headers: {}, accountId: 'a', expires: Date.now() + 60000 }, 'quota-test-secret-1234567890123456789'));
    assert.equal((await fetch(origin + nonImage, { headers })).status, 400);
    assert.deepEqual([store.reads, store.writes, store.rateCalls], [[], [], []]);
    const diagnostic = await fetch(origin + '/api/lite/diagnostics', { headers }); assert.equal(diagnostic.status, 200);
    const report = await diagnostic.json(); assert.equal(report.runtime.scope, 'instance'); assert(report.vercel.metrics.every((metric: any) => metric.used === null));
    for (let i = 1; i < 30; i++) assert.equal((await fetch(origin + '/api/lite/diagnostics', { headers })).status, 200);
    assert.equal((await fetch(origin + '/api/lite/diagnostics', { headers })).status, 429);
    assert.deepEqual(store.rateCalls, []);
    const logout = await fetch(origin + '/__moa/api/logout', { method: 'POST', headers: { ...headers, 'X-Moa-Request': '1' }, body: '{}' });
    assert.equal(logout.status, 204, await logout.text());
    assert.equal(store.rateCalls.length, 1); assert.match(store.rateCalls[0], /^auth:/);
    assert.equal((await fetch(origin + '/api/me', { headers })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
});

test('image tickets survive reloads, expire, stay bounded and remain account separated', () => {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } } as Storage;
  const tickets = new Map<string, ImageTicket>([['poster', { url: '/api/lite/image?ticket=opaque', expires: Date.now() + 60000 }], ['expired', { url: '/api/lite/image?ticket=old', expires: 1 }]]);
  persistImageTickets('a', tickets, storage);
  const restored = new Map<string, ImageTicket>(); restoreImageTickets('b', restored, storage); assert.equal(restored.size, 0);
  restoreImageTickets('a', restored, storage); assert.deepEqual([...restored.keys()], ['poster']); assert.equal(restored.get('poster')?.url, tickets.get('poster')?.url);
  for (let id = 0; id < 500; id++) tickets.set('key' + id, { url: '/api/lite/image?ticket=' + id, expires: Date.now() + 60000 });
  persistImageTickets('a', tickets, storage); assert(JSON.parse([...rows.values()][0]).length <= 256);
  clearImageTickets('a', storage); assert.equal(rows.size, 0);
});

test('instance rate windows enforce limits, isolate keys, expire and stay bounded', () => {
  const limiter = new InstanceRateLimiter(2);
  for (let i = 0; i < 3000; i++) assert(limiter.rate('api:a', 3000, 3600, 0));
  assert.equal(limiter.rate('api:a', 3000, 3600, 1), false);
  assert(limiter.rate('api:b', 3000, 3600, 1));
  assert.equal(limiter.rate('api:c', 3000, 3600, 2), false);
  assert(limiter.rate('api:c', 3000, 3600, 3_600_000));
  assert.equal(limiter.rate('api:b', 1, 3600, 3_600_000), false);
  assert(limiter.rate('api:b', 1, 3600, 3_600_001));
});

test('auth cache bounds remote revocation and cannot restore an invalidated in-flight snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = new MemoryDocuments(), db = await authDatabase(), token = 'b'.repeat(43);
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('a', 'a', '00', '00', 'admin', Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'a', Date.now() + 90_000, Date.now(), 0);
  const encoded = Buffer.from(db.export()).toString('base64'); db.close();
  await store.compareSet('auth', 0, encoded);
  const cache = new AuthCache(), req = { headers: { cookie: `moa_session=${token}` } } as IncomingMessage;
  assert.equal((await authenticate(store, req, cache))?.id, 'a');
  await store.compareSet('auth', 1, null); // A different instance's write.
  t.mock.timers.tick(29_999); assert.equal((await authenticate(store, req, cache))?.id, 'a');
  t.mock.timers.tick(1); assert.equal(await authenticate(store, req, cache), null);
  await store.compareSet('auth', 2, encoded); cache.invalidate();
  let release!: () => void, captured!: () => void;
  const ready = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const delayed = {
    get: async (key: string) => { const row = await store.get(key); if (++reads === 1) { captured(); await gate; } return row; },
    compareSet: store.compareSet.bind(store), rate: store.rate.bind(store),
  };
  const reading = authenticate(delayed, req, cache);
  await ready; await store.compareSet('auth', 3, null); cache.invalidate(); release();
  assert.equal(await reading, null); assert.equal(reads, 2);
});
