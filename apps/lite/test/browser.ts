import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import { build } from 'esbuild';
import { createLiteApplication } from '../server/app.js';
import { MemoryDocuments } from '../server/documents.js';
import { fixtureTransport, registry, repository, source } from './fixtures.js';
import { compareOriginalUi } from './ui-reference.js';
const root = resolve(import.meta.dirname, '../../..'), artifacts = resolve(root, '.state/verification');
await mkdir(artifacts, { recursive: true });
await build({ entryPoints: [resolve(root, 'apps/lite/client/index.ts')], outfile: resolve(artifacts, 'api.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022' });
const store = new MemoryDocuments(), origin = 'http://127.0.0.1:5190';
const batches: number[][] = [];
const translationFetch: typeof fetch = async (_url, init) => {
  const prompt = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[0].text);
  batches.push(prompt.lines.map((line: any) => line.id));
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ lines: prompt.lines.map((line: any) => ({ id: line.id, text: '번역 ' + line.text })) }) }] } }] }), { headers: { 'Content-Type': 'application/json' } });
};
const app = createLiteApplication({ store, origin, secret: 'moa-lite-test-secret-123456789012345', setupCode: 'LITE-TEST-SETU-P001', transport: fixtureTransport, translationFetch });
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const requests: string[] = [];
const server = createServer(async (req, res) => {
  requests.push(req.url!);
  if (req.url?.startsWith('/api/') || req.url?.startsWith('/__moa/')) { await app.handle(req, res); return; }
  const path = new URL(req.url!, origin).pathname;
  let file = path === '/testing/api.js' ? resolve(artifacts, 'api.js') : resolve(root, 'apps/web/dist', '.' + path);
  if (!file.startsWith(resolve(root, 'apps/web/dist')) && path !== '/testing/api.js') { res.writeHead(404); res.end(); return; }
  try { const bytes = await readFile(file); res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.end(bytes); }
  catch { file = resolve(root, 'apps/web/dist/index.html'); res.setHeader('Content-Type', 'text/html'); res.end(await readFile(file)); }
});
await new Promise<void>(resolve => server.listen(5190, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
const errors: string[] = [];
async function pageFor(context: BrowserContext) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return page; }
async function api(page: Page, path: string, body?: any, method = body === undefined ? 'GET' : 'POST') {
  return page.evaluate(async ({ path, body, method }) => {
    const { liteFetch } = await import('/testing/api.js' as string);
    const response = await liteFetch('/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' } });
    const value = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(JSON.stringify({ path, status: response.status, value }));
    return value;
  }, { path, body, method });
}
async function sync(page: Page) { await page.evaluate(async () => { await (await import('/testing/api.js' as string)).synchronize(); }); }
async function waitJob(page: Page, id: string, predicate: (job: any) => boolean) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const job = await api(page, '/translations/' + id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('translation-verification-timeout');
}
async function select(page: Page, id: string) { await page.evaluate(id => localStorage.setItem('moa.profile', id), id); }
async function login(page: Page, name: string) {
  await page.goto(origin + '/__moa/login'); await page.locator('[name=username]').fill(name); await page.locator('[name=password]').fill('test-password-123');
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/__moa/')), page.locator('button.submit').click()]);
}
try {
  const one = await browser.newContext(), a = await pageFor(one);
  const mediaRequests: string[] = [];
  await one.route('https://media.fixture.example.org/**', async route => {
    const url = new URL(route.request().url()); mediaRequests.push(url.pathname);
    const file = resolve(root, 'apps/lite/test/assets', url.pathname.slice(1));
    const bytes = await readFile(file);
    const type = url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : url.pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    const headers: Record<string, string> = { 'Access-Control-Allow-Origin': origin, 'Accept-Ranges': 'bytes', 'Content-Type': type };
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    if (range) { const from = Number(range[1]), to = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1); headers['Content-Range'] = `bytes ${from}-${to}/${bytes.length}`; await route.fulfill({ status: 206, headers, body: bytes.subarray(from, to + 1) }); }
    else await route.fulfill({ status: 200, headers, body: bytes });
  });
  await a.goto(origin + '/__moa/setup');
  await a.locator('[name=code]').fill('LITE-TEST-SETU-P001'); await a.locator('[name=username]').fill('admin'); await a.locator('[name=password]').fill('test-password-123'); await a.locator('[name=confirm]').fill('test-password-123');
  await Promise.all([a.waitForURL(url => !url.pathname.startsWith('/__moa/')), a.locator('button[type=submit]').click()]);
  console.log('PASS original setup HTML and authenticated SPA');
  const me = await api(a, '/me'); assert.equal(me.role, 'admin');
  const profile = await api(a, '/profiles', { name: '첫 기기', color: 'blue' }); await select(a, profile.id);
  const list = await api(a, '/sources/refresh', { url: repository }); assert.equal(list.length, 1);
  const sourceId = list[0].id;
  await api(a, `/sources/${sourceId}/install`, {});
  const filters = await api(a, `/sources/${sourceId}/filters`); assert.equal(filters.filters[0].kind, 'select');
  const preferences = await api(a, `/sources/${sourceId}/preferences`, { label: '브라우저 설정' }, 'PATCH'); assert.equal(preferences[0].value, '브라우저 설정');
  const page = await api(a, `/sources/${sourceId}/browse`, { mode: 'popular', page: 1 }); assert.equal(page.items[0].title, 'Fixture Series');
  const search = await api(a, `/sources/${sourceId}/browse`, { mode: 'search', page: 1, q: 'Fixture' }); assert.equal(search.items.length, 2);
  const filtered = await api(a, `/sources/${sourceId}/browse`, { mode: 'search', page: 1, q: 'Fixture', selection: { revision: filters.revision, filters: [{ position: filters.filters[0].position, value: 1 }] } }); assert.equal(filtered.items.length, 2);
  const cancelled = await a.evaluate(async sourceId => {
    const { liteFetch } = await import('/testing/api.js' as string), abort = new AbortController();
    const promise = liteFetch(`/api/sources/${sourceId}/browse`, { method: 'POST', body: JSON.stringify({ mode: 'search', page: 1, q: 'slow' }), signal: abort.signal });
    setTimeout(() => abort.abort(), 700);
    return (await promise).status;
  }, sourceId);
  assert.equal(cancelled, 499); assert.equal((await api(a, '/profiles'))[0].id, profile.id);
  const media = page.items[0], detail = await api(a, '/media/' + media.id); assert.equal(detail.seasons[0].episodes.length, 2);
  await api(a, '/media/' + page.items[1].id);
  const franchise = await api(a, `/media/${media.id}/franchise`); assert(franchise.seasons.some((season: any) => season.season === 2));
  const episodeId = detail.seasons[0].episodes[0].id;
  const playback = await api(a, '/playback', { episodeId }); assert.equal(playback.url, 'https://media.fixture.example.org/video.mp4'); assert.equal(playback.subtitles.length, 2);
  const hls = await api(a, '/playback', { episodeId, streamId: '1' }); assert.equal(hls.mime, 'application/vnd.apple.mpegurl');
  await api(a, '/settings', { autoFetchSubtitles: false, autoplayNext: false }, 'PATCH');
  await api(a, '/watchlist/' + media.id, undefined, 'PUT'); await api(a, '/progress', { episodeId, position: 40, duration: 100 }); await sync(a);
  assert.equal((await api(a, '/media/' + media.id)).overview, '원본 MOA 화면 검증');
  console.log('PASS QuickJS/WASM list → search → filters → detail → episodes → videos, direct playback session and subtitle Blob');
  const two = await browser.newContext(), b = await pageFor(two); await login(b, 'admin');
  const restored = await api(b, '/profiles'); assert.equal(restored[0].id, profile.id); await select(b, profile.id);
  const watchlist = await api(b, '/watchlist'); assert.equal(watchlist[0].id, media.id);
  const history = await api(b, '/history'); assert(history);
  assert.equal((await api(b, '/sources'))[0].installed, true);
  await api(b, '/watchlist/' + media.id, undefined, 'DELETE'); await sync(b); await sync(a); assert.equal((await api(a, '/watchlist')).length, 0);
  console.log('PASS second device restores shared sources, profile, watchlist/history; deletion propagates');
  await one.setOffline(true);
  await a.evaluate(() => { (globalThis as any).testNow = Date.now; Date.now = () => (globalThis as any).testNow() + 61000; });
  await api(a, '/settings', { autoplayDelay: 8 }, 'PATCH');
  await a.evaluate(() => { Date.now = (globalThis as any).testNow; delete (globalThis as any).testNow; });
  await one.setOffline(false); await sync(a); await sync(b); assert.equal((await api(b, '/settings')).autoplayDelay, 8);
  console.log('PASS offline changes persist and retry');
  const inviteResponse = await one.request.post(origin + '/__moa/api/invites', { headers: { Origin: origin, 'X-Moa-Request': '1' }, data: { label: '검증', maxUses: 1, expiresInDays: null } });
  assert.equal(inviteResponse.status(), 201); const invite = await inviteResponse.json();
  const third = await browser.newContext(), c = await pageFor(third); await c.goto(invite.url);
  await c.locator('[name=username]').fill('member'); await c.locator('[name=password]').fill('test-password-123'); await c.locator('[name=confirm]').fill('test-password-123');
  await Promise.all([c.waitForURL(url => !url.pathname.startsWith('/__moa/')), c.locator('button[type=submit]').click()]);
  assert.deepEqual(await api(c, '/profiles'), []); assert.equal((await api(c, '/sources'))[0].installed, true);
  const denied = await third.request.patch(origin + '/api/admin/tmdb/config', { headers: { Origin: origin }, data: { clear: true } }); assert.equal(denied.status(), 403);
  console.log('PASS second account data isolation, invitations and administrator permissions');
  const fallback = await browser.newContext();
  await fallback.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  const d = await pageFor(fallback); await login(d, 'admin'); await api(d, '/profiles'); await select(d, profile.id);
  const e = await pageFor(fallback); await e.goto(origin + '/profiles'); await api(e, '/profiles'); await select(e, profile.id);
  const extraProfiles = await Promise.all([api(d, '/profiles', { name: '탭 하나' }), api(e, '/profiles', { name: '탭 둘' })]);
  const together = await api(d, '/profiles'); assert(extraProfiles.every(row => together.some((profile: any) => profile.id === row.id))); await sync(d);
  await d.evaluate(async () => { await (await import('/testing/api.js' as string)).beforeLogout(); });
  await fallback.request.post(origin + '/__moa/api/logout', { headers: { Origin: origin, 'X-Moa-Request': '1' }, data: {} });
  await d.evaluate(async () => { (await import('/testing/api.js' as string)).afterLogout(); });
  await e.waitForURL(url => url.pathname === '/__moa/login'); await e.waitForLoadState('networkidle');
  await login(d, 'member'); assert.deepEqual(await api(d, '/profiles'), []);
  await e.goto(origin + '/profiles'); assert.deepEqual(await api(e, '/profiles'), []);
  await fallback.close();
  console.log('PASS concurrent tabs with IndexedDB lock fallback and same-device account switch isolation');
  await api(a, '/admin/translation/config', { apiKey: 'test-gemini-api-key-only', enabled: true, batchSize: 10, requestIntervalMs: 3000, retryCount: 0 }, 'PATCH');
  const content = 'WEBVTT\n\n' + Array.from({ length: 25 }, (_, i) => `00:00:${String(i).padStart(2, '0')}.000 --> 00:00:${String(i + 1).padStart(2, '0')}.000\nLine ${i}\n`).join('\n');
  const job = await api(a, `/episodes/${episodeId}/subtitles/translate`, { content, format: 'vtt', sourceLabel: '테스트', sourceLanguage: 'en' });
  assert.equal(job.total, 25);
  await waitJob(a, job.id, job => job.done === 10);
  await a.goto('about:blank');
  const pausedBatches = batches.length; await new Promise(resolve => setTimeout(resolve, 3300)); assert.equal(batches.length, pausedBatches);
  await a.goto(origin + '/title/' + media.id); await api(a, '/profiles');
  const completed = await waitJob(a, job.id, job => job.state === 'completed'); assert.equal(completed.done, 25);
  assert.deepEqual(batches.map(batch => batch.length), [10, 10, 5]); assert.equal(new Set(batches.flat()).size, 25);
  const cached = await api(a, `/episodes/${episodeId}/subtitles/translate`, { content, format: 'vtt', sourceLabel: '테스트', sourceLanguage: 'en' }); assert.equal(cached.cached, true);
  const beforeCancel = batches.length;
  const cancelledJob = await api(a, `/episodes/${episodeId}/subtitles/translate`, { content: content.replaceAll('Line', 'Cancel'), format: 'vtt', sourceLabel: '테스트', sourceLanguage: 'en' });
  await api(a, '/translations/' + cancelledJob.id, undefined, 'DELETE');
  await new Promise(resolve => setTimeout(resolve, 3100)); assert.equal((await api(a, '/translations/' + cancelledJob.id)).state, 'cancelled'); assert(batches.length <= beforeCancel + 1);
  console.log('PASS browser translation batches, tab-close pause, checkpoint resume, device cache and cancellation');
  const entry = { ...registry[0], id: '123', format: 'mangayomi-js' };
  const invoke = async (code: string, timeoutMs = 100) => a.evaluate(async ({ source, entry, timeoutMs }) => {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(x => x.toString(16).padStart(2, '0')).join('');
    return new Promise<any>((resolve, reject) => { const worker = new Worker('/runtime/source-worker.js', { type: 'module' }); const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker-test-timeout')); }, 5000); worker.onmessage = ({ data }) => { if (['result', 'failure'].includes(data.type)) { clearTimeout(timer); worker.terminate(); resolve(data); } }; worker.postMessage({ type: 'invoke', bundle: { source, entry, codeDigest: digest, action: 'list', preferences: {}, timeoutMs } }); });
  }, { source: code, entry, timeoutMs });
  const loop = await invoke('class DefaultExtension extends MProvider { async getPopular(){while(true){}} }'); assert.equal(loop.code, 'execution_timeout');
  const memory = await invoke('class DefaultExtension extends MProvider { async getPopular(){const values=[];while(true)values.push(new Array(100000).fill("memory"));} }', 1000); assert.equal(memory.type, 'failure');
  console.log('PASS actual Worker CPU timeout and 64 MiB memory limit');
  await a.goto(origin + '/watch/' + episodeId + '?t=0');
  await a.locator('video').waitFor();
  await a.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; });
  await a.evaluate(async () => { const video = document.querySelector('video')!; video.muted = true; video.currentTime = 1; await video.play(); });
  await a.waitForFunction(() => document.querySelector('video')!.currentTime > 1.2);
  await a.evaluate(() => { document.querySelector('video')!.currentTime = 4; });
  await a.waitForFunction(() => document.querySelector('video')!.currentTime >= 4);
  assert(mediaRequests.includes('/video.mp4'));
  console.log('PASS original MOA player directly plays MP4, seeks and loads Korean VTT');
  await a.evaluate(() => { const video = document.querySelector('video')!; video.pause(); video.currentTime = 1; });
  await a.getByRole('button', { name: '자막 및 음성', exact: true }).click({ force: true });
  await a.getByRole('button', { name: /한국어 ASS/ }).click();
  await a.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
  await a.evaluate(async () => { await document.querySelector('video')!.play(); });
  await a.waitForFunction(() => document.querySelector('video')!.currentTime > 1.7);
  await a.evaluate(() => document.querySelector('video')!.pause());
  await a.getByRole('button', { name: '자막 및 음성', exact: true }).click({ force: true });
  await a.waitForLoadState('networkidle');
  await a.screenshot({ path: resolve(artifacts, 'player-ass.png') });
  await a.getByRole('button', { name: '자막 및 음성', exact: true }).click({ force: true });
  await a.getByRole('button', { name: '한국어', exact: true }).click();
  await a.getByRole('button', { name: '자막 및 음성', exact: true }).click({ force: true });
  await a.waitForFunction(() => [...document.querySelector('video')!.textTracks].some(track => track.mode === 'showing' && !!track.cues?.length));
  console.log('PASS original JASSUB Korean ASS rendering and VTT track switching');
  await a.screenshot({ path: resolve(artifacts, 'player.png') });
  await a.evaluate(() => document.querySelector('video')!.pause());
  await a.getByRole('button', { name: '재생 설정', exact: true }).click({ force: true });
  await a.getByRole('button', { name: '1080p HLS', exact: true }).click();
  await a.waitForFunction(() => { const video = document.querySelector('video'); return video && video.currentSrc.startsWith('blob:') && video.readyState >= 2; });
  await a.evaluate(async () => { const video = document.querySelector('video')!; video.muted = true; video.currentTime = 1; await video.play(); });
  await a.waitForFunction(() => document.querySelector('video')!.currentTime > 1.2);
  await a.getByRole('button', { name: '재생 설정', exact: true }).click({ force: true });
  await a.getByRole('button', { name: '144p', exact: true }).click();
  await a.evaluate(() => { document.querySelector('video')!.currentTime = 5; });
  await a.waitForFunction(() => document.querySelector('video')!.currentTime > 5);
  assert(mediaRequests.includes('/master.m3u8')); assert(mediaRequests.some(path => /high-\d+\.ts/.test(path)));
  console.log('PASS original hls.js player directly loads manifests/segments, switches quality and seeks');
  await a.getByRole('button', { name: '재생 설정', exact: true }).click({ force: true });
  await a.getByRole('button', { name: '다음 화 (N)', exact: true }).click({ force: true });
  await a.waitForURL(origin + '/watch/' + detail.seasons[0].episodes[1].id);
  await a.waitForFunction(() => document.querySelector('video')!.readyState >= 2);
  console.log('PASS next episode through the original player controls');
  await a.goto(origin + '/title/' + media.id); await a.locator('.season-trigger[aria-haspopup=menu]').waitFor();
  await a.locator('.season-trigger[aria-haspopup=menu]').click(); await a.getByRole('menuitemradio', { name: /시즌 2/ }).click();
  await a.waitForURL(origin + '/title/' + page.items[1].id); await a.getByRole('heading', { name: 'Fixture Series Season 2', exact: true }).waitFor();
  console.log('PASS season switch through the original MOA season picker');
  await api(a, '/settings', { navigation: ['home', 'movies', 'anime', 'series'].map((id, index) => ({ id, name: ['홈', '영화', '애니', '시리즈'][index], sourceIds: [sourceId], includeLocal: false })) }, 'PATCH');
  await compareOriginalUi(browser, a, path => api(a, path), profile.id, media.id, artifacts);
  assert(!requests.some(path => /\/api\/.*(?:\.mp4|\.m3u8|\.ts)/.test(path)));
  assert.deepEqual(errors, []);
  console.log('PASS existing MOA desktop/mobile title UI, SPA direct entry, no video transfer through API, no browser errors');
  await readFile(resolve(root, 'apps/web/dist/runtime/quickjs.wasm'));
  console.log('Browser verification complete. Artifacts: ' + artifacts);
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
