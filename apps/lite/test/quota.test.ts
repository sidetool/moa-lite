import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { MemoryDocuments, RedisDocuments } from '../server/documents.js';
import { createLiteApplication } from '../server/app.js';
import { authDatabase } from '../server/auth.js';
import { restoreImageTickets, persistImageTickets, clearImageTickets, type ImageTicket } from '../client/image-cache.js';
import { fixtureTransport } from './fixtures.js';

test('Redis conditional reads and compressed snapshots reduce bytes without stale reads or shared mutations', async () => {
  const records = new Map<string, string>(); let responseBytes = 0, requestBytes = 0, unavailable = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); requestBytes += body.length;
    const command = JSON.parse(body.toString()); let result: unknown;
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
    unavailable = true; await assert.rejects(store.get('shared'), /storage-unavailable/);
    console.log(`Redis fixture: ${bytes} raw bytes -> ${compressedBytes} stored bytes; two unchanged read responses: ${unchangedBytes} bytes`);
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
});

test('combined sync omits unchanged source code and relay avoids secrets reads; logout remains immediate', async () => {
  class Counted extends MemoryDocuments { reads: string[] = []; override async get(key: string) { this.reads.push(key); return super.get(key); } }
  const store = new Counted(), db = await authDatabase(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts(id,username,salt,hash,role,created_at) VALUES(?,?,?,?,?,?)').run('a', 'a', '00', '00', 'admin', Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'a', Date.now() + 60000, Date.now(), 0);
  await store.compareSet('auth', 0, Buffer.from(db.export()).toString('base64')); db.close();
  await store.compareSet('shared', 0, { repositories: [], sources: [{ code: 'large source '.repeat(10000) }] });
  let app: ReturnType<typeof createLiteApplication>;
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  app = createLiteApplication({ store, origin, secret: 'quota-test-secret-1234567890123456789', setupCode: 'LITE-TEST-SETU-P001', transport: fixtureTransport });
  const headers = { Cookie: `moa_session=${token}`, Origin: origin, 'Content-Type': 'application/json' };
  const sync = (revision: number) => fetch(origin + '/api/lite/sync', { method: 'POST', headers, body: JSON.stringify({ since: 0, changes: [], sharedRevision: revision }) }).then(r => r.json());
  try {
    const first = await sync(0); assert.equal(first.shared.revision, 1);
    const next = await sync(1); assert.equal(next.shared, undefined); assert(JSON.stringify(next).length < 100);
    store.reads = [];
    assert.equal((await fetch(origin + '/api/lite/http', { method: 'POST', headers, body: '{"url":"https://fixture.example.org/list"}' })).status, 200);
    assert.deepEqual(store.reads, ['auth']);
    const diagnostic = await fetch(origin + '/api/lite/diagnostics', { headers }); assert.equal(diagnostic.status, 200);
    const report = await diagnostic.json(); assert.equal(report.runtime.scope, 'instance'); assert(report.vercel.metrics.every((metric: any) => metric.used === null));
    const saved = await store.get('auth'), revoked = await authDatabase(saved.value);
    revoked.prepare('DELETE FROM sessions').run(); await store.compareSet('auth', saved.revision, Buffer.from(revoked.export()).toString('base64')); revoked.close();
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
