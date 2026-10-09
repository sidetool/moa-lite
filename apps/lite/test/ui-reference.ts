import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, symlink, readdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { Browser, Page } from 'playwright-core';

export async function compareOriginalUi(browser: Browser, lite: Page, api: (path: string) => Promise<any>, profile: string, media: string, artifacts: string) {
  const root = resolve(import.meta.dirname, '../../..'), reference = resolve(root, '.state/ui-reference');
  await mkdir(reference, { recursive: true });
  const archive = execFileSync('git', ['archive', 'a7ff835e76b9769432f00dcadaad788993464c92', 'apps/web'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', reference], { input: archive });
  await symlink(resolve(root, 'apps/web/node_modules'), resolve(reference, 'apps/web/node_modules')).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: resolve(reference, 'apps/web'), env: { ...process.env, VITE_MOA_LITE: '0', VITE_MOCK: '0' }, stdio: 'pipe' });
  const dist = resolve(reference, 'apps/web/dist');
  await lite.goto('http://127.0.0.1:5190/title/' + media);
  await lite.getByRole('heading', { name: 'Fixture Series', exact: true }).waitFor();
  await lite.waitForLoadState('networkidle');
  const snapshot = new Map<string, any>();
  for (const path of ['/me', '/profiles', '/settings', '/sources', `/media/${media}`, `/media/${media}/group`, `/media/${media}/franchise`]) snapshot.set(path, await api(path));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://127.0.0.1:5191').pathname, file = resolve(dist, '.' + path);
    try { if (!file.startsWith(dist + '/')) throw new Error(); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as any)[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
    catch { res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html'))); }
  });
  await new Promise<void>(resolve => server.listen(5191, '127.0.0.1', resolve));
  const context = await browser.newContext(), original = await context.newPage();
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await lite.route('**/api/lite/image?*', route => route.fulfill({ contentType: 'image/png', body: pixel }));
  await original.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    if (path === '/lite/image') { await route.fulfill({ contentType: 'image/png', body: pixel }); return; }
    assert(snapshot.has(path), 'unexpected reference UI request: ' + path);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot.get(path)) });
  });
  await original.addInitScript(id => localStorage.setItem('moa.profile', id), profile);
  const comparisons = [];
  try {
    for (const [name, viewport] of [['desktop', { width: 1280, height: 720 }], ['mobile', { width: 390, height: 844 }]] as const) {
      await lite.setViewportSize(viewport); await original.setViewportSize(viewport);
      await lite.goto('http://127.0.0.1:5190/title/' + media); await original.goto('http://127.0.0.1:5191/title/' + media);
      for (const page of [lite, original]) { await page.getByRole('heading', { name: 'Fixture Series', exact: true }).waitFor(); await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready); }
      const current = await lite.screenshot({ fullPage: true, animations: 'disabled', path: resolve(artifacts, `${name}.png`) });
      const previous = await original.screenshot({ fullPage: true, animations: 'disabled', path: resolve(artifacts, `${name}-original.png`) });
      const result = await lite.evaluate(async ([current, previous]) => {
        const decoded = [];
        for (const data of [current, previous]) {
          const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
          decoded.push({ width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data });
        }
        const [a, b] = decoded; let different = 0;
        for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2, 3].some(channel => a.pixels[i + channel] !== b.pixels[i + channel])) different++;
        return { width: a.width, height: a.height, referenceWidth: b.width, referenceHeight: b.height, different, total: a.width * a.height };
      }, [current.toString('base64'), previous.toString('base64')]);
      assert.equal(result.width, result.referenceWidth); assert.equal(result.height, result.referenceHeight);
      assert.equal(result.different, 0, `${name}: ${result.different} pixels differ`);
      comparisons.push({ name, ...result });
    }
    await writeFile(resolve(artifacts, 'ui-comparison.json'), JSON.stringify(comparisons, null, 2));
    console.log('PASS pixel-identical desktop/mobile title UI with the same data');
  } finally { await context.close(); await lite.unroute('**/api/lite/image?*'); await new Promise<void>(resolve => server.close(() => resolve())); }
}
