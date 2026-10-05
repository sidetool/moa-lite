import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import { build } from 'esbuild';
import { createLiteApplication } from '../server/app.js';
import { MemoryDocuments } from '../server/documents.js';
import { fixtureTransport, registry, repository, source } from './fixtures.js';
const root = resolve(import.meta.dirname, '../../..'), artifacts = resolve(root, '.state/regressions');
await mkdir(artifacts, { recursive: true });
await build({ entryPoints: [resolve(root, 'apps/lite/test/regression-entry.ts')], outfile: resolve(artifacts, 'api.js'), bundle: true, external: ['node:*'], platform: 'browser', format: 'esm', target: 'es2022' });
const store = new MemoryDocuments(), origin = 'http://127.0.0.1:5190';
const batches: number[][] = [];
const translationFetch: typeof fetch = async (_url, init) => {
  const prompt = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[0].text);
  batches.push(prompt.lines.map((line: any) => line.id));
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ lines: prompt.lines.map((line: any) => ({ id: line.id, text: '번역 ' + line.text })) }) }] } }] }), { headers: { 'Content-Type': 'application/json' } });
};
const reviewSource = source.replace("imageUrl:'https://fixture.example.org/poster.png'","imageUrl:'https://fixture.example.org/poster.png',imageHeaders:{'User-Agent':'fixture-required'}") + '\nDefaultExtension.prototype.getVideoList = async function(){return [{url:"https://media.fixture.example.org/play?id=123",quality:"720p",subtitles:[{file:"WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\ninline subtitle\\n",label:"inline"}]}]};';
let listVersion=0,listCalls=0,listCompleted=0; const posterHeaders: any[]=[];
const reviewTransport = async (input: any, signal: AbortSignal): Promise<any> => {
  if (input.url.endsWith('/source.js')) { const bytes = Buffer.from(reviewSource); return {statusCode:200,contentType:'text/plain',headers:{},bytes:bytes.toString('base64'),size:bytes.length}; }
  if(input.url.endsWith('/poster.png')){posterHeaders.push(input.headers);return {statusCode:input.headers?.['User-Agent']==='fixture-required'?200:403,contentType:'image/png',headers:{},bytes:'',size:0};}
  if(input.url.endsWith('/list')){listCalls++; if(listVersion){const bytes=Buffer.from('<h1>Updated Fixture Series</h1>');await new Promise(resolve=>setTimeout(resolve,200));listCompleted++;return {statusCode:200,contentType:'text/html',headers:{},bytes:bytes.toString('base64'),size:bytes.length};}}
  return fixtureTransport(input, signal);
};
const app = createLiteApplication({ store, origin, secret: 'moa-lite-test-secret-123456789012345', setupCode: 'LITE-TEST-SETU-P001', transport: reviewTransport, translationFetch });
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
    const file = resolve(root, 'apps/lite/test/assets', url.pathname === '/play' ? 'master.m3u8' : url.pathname.slice(1));
    const bytes = await readFile(file);
    const type = url.pathname === '/play' || url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : url.pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
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

  const playback = await api(a, '/playback', { episodeId });
  console.log('PASS extensionless HLS classification:', JSON.stringify({url:playback.url,mime:playback.mime}));
  assert.equal(playback.mime, 'application/vnd.apple.mpegurl');
  console.log('PASS inline subtitle count:', playback.subtitles.length);
  assert.equal(playback.subtitles.length, 1);
  assert.match(await a.evaluate(async url => (await fetch(url)).text(),playback.subtitles[0].url),/inline subtitle/);
  const poster=await one.request.get(origin+media.poster); console.log('PASS image headers preserved:',JSON.stringify({status:poster.status(),sent:posterHeaders.at(-1)}));assert.equal(poster.status(),200);assert.equal(posterHeaders.at(-1)?.['User-Agent'],'fixture-required');
  await sync(a);
  const beforeIdle = requests.filter(path => path === '/api/lite/sync').length;
  await a.evaluate(async () => { const runtime = await import('/testing/api.js' as string); await runtime.synchronize(false); await runtime.synchronize(false); });
  assert.equal(requests.filter(path => path === '/api/lite/sync').length, beforeIdle);
  const beforeTickets = requests.filter(path => path === '/api/lite/images').length;
  await a.reload();
  const restoredDetail = await api(a, '/media/' + media.id);
  assert.equal(restoredDetail.poster, media.poster);
  assert.equal(requests.filter(path => path === '/api/lite/images').length, beforeTickets);
  console.log('PASS recent idle sync coalescing and stable image tickets after reload');
  const second = await api(a, '/profiles', {name:'Second profile',color:'red'});
  await select(a, profile.id);
  const profileRace = await a.evaluate(async ({account,first,second}) => {
    const {liteFetch} = await import('/testing/api.js' as string);
    let unlock!: () => void;
    const locked = new Promise<void>(resolve => navigator.locks.request('moa-lite:'+account, async()=>{resolve();await new Promise<void>(resolve=>{unlock=resolve;});}));
    await locked;
    const mutation=liteFetch('/api/settings',{method:'PATCH',headers:{'X-Moa-Profile':first},body:JSON.stringify({autoplayDelay:13})});
    await new Promise(resolve=>setTimeout(resolve,100));
    localStorage.setItem('moa.profile',second); unlock();
    const r=await mutation; return {status:r.status,value:await r.json()};
  }, {account:me.id,first:profile.id,second:second.id});
  await select(a,profile.id); const firstSettings=await api(a,'/settings');
  await select(a,second.id); const secondSettings=await api(a,'/settings');
  console.log('PASS queued settings mutation kept original profile:',JSON.stringify({profileRace,firstDelay:firstSettings.autoplayDelay,secondDelay:secondSettings.autoplayDelay}));
  assert.equal(firstSettings.autoplayDelay,13); assert.notEqual(secondSettings.autoplayDelay,13);
  await select(a,profile.id);
  await a.evaluate(async account=>{await (await import('/testing/api.js' as string)).ageCache(account);},me.id);
  listVersion=1;
  const stale=await api(a,`/sources/${sourceId}/browse?mode=popular`);
  await new Promise(resolve=>setTimeout(resolve,900));
  assert(listCompleted>0);
  const afterRefresh=await api(a,`/sources/${sourceId}/browse?mode=popular`);
  console.log('PASS completed background refresh persisted:',JSON.stringify({stale:stale.items[0].title,afterRefresh:afterRefresh.items[0].title,listCalls,listCompleted}));
  assert.equal(afterRefresh.items[0].title,'Updated Fixture Series');
  await a.reload();
  assert.equal((await api(a,`/sources/${sourceId}/browse?mode=popular`)).items[0].title,'Updated Fixture Series');
  await api(a,'/settings',{autoFetchSubtitles:false,autoplayNext:false},'PATCH');
  await a.goto(origin+'/watch/'+episodeId+'?t=0');
  await a.waitForFunction(()=>{const video=document.querySelector('video');return video && video.readyState>=2;});
  await a.evaluate(async()=>{const video=document.querySelector('video')!;video.muted=true;await video.play();});
  await a.waitForFunction(()=>document.querySelector('video')!.currentTime>0.5);
  assert(mediaRequests.includes('/play')); assert(mediaRequests.some(url=>url.endsWith('.ts')));
  console.log('PASS extensionless HLS actually plays in original player');
  await a.goto(origin + '/settings');
  await a.getByRole('link', { name: /진단 · 할당량/ }).click();
  await a.getByText('Node CPU 누적', { exact: true }).waitFor();
  assert.equal(await a.getByRole('link', { name: 'Vercel Usage 열기' }).getAttribute('href'), 'https://vercel.com/dashboard/usage');
  assert(await a.getByText('사용량 확인 필요', { exact: true }).count() >= 6);
  const diagnosticRequests = () => requests.filter(path => path === '/api/lite/diagnostics').length;
  const beforeInvalidation = diagnosticRequests();
  await a.evaluate(() => window.dispatchEvent(new Event('moa-lite:changed')));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(diagnosticRequests(), beforeInvalidation);
  await Promise.all([a.waitForResponse(response => response.url().endsWith('/api/lite/diagnostics')), a.getByRole('button', { name: '새로고침', exact: true }).click()]);
  assert.equal(diagnosticRequests(), beforeInvalidation + 1);
  await a.setViewportSize({ width: 1280, height: 900 }); await a.screenshot({ path: resolve(artifacts, 'diagnostics-desktop.png') });
  await a.setViewportSize({ width: 390, height: 844 });
  assert(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await a.screenshot({ path: resolve(artifacts, 'diagnostics-mobile.png') });
  console.log('PASS administrator diagnostics, explicit refresh only and desktop/mobile layout');
  console.log('P1/P2 browser regressions passed');
} finally { await browser.close(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
