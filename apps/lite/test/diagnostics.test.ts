import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RuntimeDiagnostics, createQuotaReader, upstashMetrics } from '../server/diagnostics.js';

test('provider quota reads distinguish unknown from zero and collapse/cache management requests', async () => {
  const env = { UPSTASH_MANAGEMENT_EMAIL: 'owner@example.test', UPSTASH_MANAGEMENT_API_KEY: 'management-secret', UPSTASH_DATABASE_ID: 'database-id' };
  let calls = 0;
  const read = createQuotaReader(env, async (input, init) => {
    calls++; assert.equal(String(input), 'https://api.upstash.com/v2/redis/stats/database-id');
    assert.equal((init!.headers as any).Authorization, 'Basic ' + Buffer.from('owner@example.test:management-secret').toString('base64'));
    return new Response(JSON.stringify({ total_monthly_requests: 410000, total_monthly_bandwidth: 0, current_storage: 123, token: 'must-not-leak' }));
  });
  const [a, b] = await Promise.all([read(), read()]); assert.equal(calls, 1); assert.deepEqual(a, b);
  await read(); assert.equal(calls, 1); assert.equal(a.metrics[1].used, 0);
  assert(!JSON.stringify(a).includes('secret')); assert(!JSON.stringify(a).includes('must-not-leak'));
  assert.deepEqual(upstashMetrics({}).map(row => row.used), [null, null, null]);
  assert.deepEqual(upstashMetrics({ total_monthly_requests: -1, total_monthly_bandwidth: '0', current_storage: null }).map(row => row.used), [null, null, null]);
  const missing = await createQuotaReader({}, async () => { throw new Error('must not call'); })(); assert.equal(missing.status, 'not-configured');
  let failures = 0;
  const failing = createQuotaReader(env, async () => { failures++; return new Response('management-secret', { status: 401 }); });
  assert.equal((await failing()).status, 'unavailable'); assert.equal((await failing()).metrics[0].used, null); assert.equal(failures, 1);
});

test('runtime metrics count bytes and finish once and never retain raw URLs or payloads', async () => {
  const diagnostics = new RuntimeDiagnostics();
  const server = createServer((req, res) => {
    diagnostics.track(req, res);
    if (req.url?.startsWith('/api/lite/http')) res.statusCode = 502;
    res.write('한글'); res.end(Buffer.from('abc'));
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await Promise.all(['/api/lite/http?token=secret', '/private-user-identifier'].map(path => fetch(origin + path).then(r => r.text())));
    const report = diagnostics.snapshot();
    assert.equal(report.active, 0); assert.equal(report.routes.http.requests, 1); assert.equal(report.routes.other.requests, 1);
    assert.equal(report.routes.http.responseBytes, 9); assert.equal(report.routes.http.errors, 1);
    assert.equal(report.recent.length, 1); assert.equal(report.recent[0].status, 502); assert(report.cpuMs >= 0);
    assert(!JSON.stringify(report).includes('secret')); assert(!JSON.stringify(report).includes('private-user'));
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
});
