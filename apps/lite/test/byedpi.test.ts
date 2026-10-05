import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer, get } from 'node:https';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withByeDpi } from '../server/byedpi.js';
import { sourceHttp } from '../server/network.js';
import { compatibilityHttp } from '../../../packages/extensions/src/http.js';
import { pinnedProxyAgent } from '../../../packages/extensions/src/proxy.js';

const listen = (server: import('node:http').Server) => new Promise<string>(yes => server.listen(0, '127.0.0.1', () => yes(`http://127.0.0.1:${(server.address() as any).port}`)));
const closed = (proxy: string) => new Promise<boolean>(yes => {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(proxy).port) });
  socket.once('connect', () => { socket.destroy(); yes(false); }); socket.once('error', () => yes(true));
});

test('native ByeDPI relays concurrent requests and terminates on success, failure and cancellation', async () => {
  const server = createServer((req, res) => { if (req.url === '/hang') return; res.setHeader('Content-Type', 'text/html'); res.end('catalog:' + req.headers['x-fixture']); });
  const url = await listen(server), proxies: string[] = [];
  try {
    await Promise.all([1, 2, 3].map(async n => {
      await withByeDpi(new AbortController().signal, async proxy => {
        assert(proxy); proxies.push(proxy);
        const result = await compatibilityHttp({ url, headers: { 'X-Fixture': String(n) } }, new AbortController().signal, [url], 2048, proxy);
        assert.equal(result.bytes.toString(), 'catalog:' + n);
      }, { enabled: true });
    }));
    assert.equal(new Set(proxies).size, 3);
    for (const proxy of proxies) assert(await closed(proxy));
    let failedProxy = '';
    await assert.rejects(withByeDpi(new AbortController().signal, async proxy => { failedProxy = proxy!; throw new Error('fixture-failed'); }, { enabled: true }), /fixture-failed/);
    assert(await closed(failedProxy));
    const abort = new AbortController(); let abortedProxy = '';
    await assert.rejects(withByeDpi(abort.signal, async proxy => { abortedProxy = proxy!; abort.abort(new Error('fixture-cancel')); abort.signal.throwIfAborted(); }, { enabled: true }), /fixture-cancel/);
    assert(await closed(abortedProxy));
    const inFlight = new AbortController(); let activeProxy = '';
    await assert.rejects(withByeDpi(inFlight.signal, async proxy => {
      activeProxy = proxy!;
      const timer = setTimeout(() => inFlight.abort(), 30);
      try { await compatibilityHttp({ url: url + '/hang' }, inFlight.signal, [url], 2048, proxy); }
      finally { clearTimeout(timer); }
    }, { enabled: true }), /cancelled/);
    assert(await closed(activeProxy));
    await assert.rejects(withByeDpi(new AbortController().signal, async () => assert.fail('must not fall back'), { enabled: true, binary: '/nonexistent/moa-ciadpi' }), /byedpi_start_failed/);
    await withByeDpi(new AbortController().signal, async proxy => assert.equal(proxy, undefined), { enabled: false });
    await assert.rejects(sourceHttp({ url: 'https://127.0.0.1/private' }, new AbortController().signal), /source_address_denied/);
    await assert.rejects(sourceHttp({ url: 'https://example.com/video.mp4' }, new AbortController().signal), /video-relay-unavailable/);
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
});

test('native TLS fragmentation preserves SNI, HTTPS bytes and certificate verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moa-byedpi-'));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=relay.test', '-addext', 'subjectAltName=DNS:relay.test'], { stdio: 'ignore' });
  const ca = await readFile(cert);
  const server = createTlsServer({ key: await readFile(key), cert: ca }, (req, res) => { assert.equal((req.socket as any).servername, 'relay.test'); res.end('secure catalog / cover / link'); });
  const local = await listen(server), url = new URL(local.replace('http://127.0.0.1', 'https://relay.test'));
  try {
    for (const strategy of ['tlsrec', 'disorder']) await withByeDpi(new AbortController().signal, async proxy => {
      const request = (trusted: boolean) => new Promise<string>((yes, no) => {
        const agent = pinnedProxyAgent(proxy, url, '127.0.0.1', new AbortController().signal)!;
        const req = get(url, { agent, ...(trusted ? { ca } : {}) }, async res => {
          try { const chunks = []; for await (const chunk of res) chunks.push(chunk); yes(Buffer.concat(chunks).toString()); } catch (error) { no(error); } finally { agent.destroy(); }
        });
        req.once('error', error => { agent.destroy(); no(error); });
      });
      assert.equal(await request(true), 'secure catalog / cover / link');
      await assert.rejects(request(false), /self-signed certificate/);
    }, { enabled: true, strategy });
  } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await rm(dir, { recursive: true, force: true }); }
});
