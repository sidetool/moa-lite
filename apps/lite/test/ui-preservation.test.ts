import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
test('MOA styles, artwork, fonts, title/profile/account pages and player components retain their original source', async () => {
  const root = resolve(import.meta.dirname, '../../..'), base = 'a7ff835e76b9769432f00dcadaad788993464c92';
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'apps/web', 'deploy/auth'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(path => /\.(css|svg|png|jpg|woff2?|otf)$/.test(path) || /^apps\/web\/src\/player\/(components|subtitles|controls)/.test(path));
  paths.push(...['TitlePage', 'ProfilesPage', 'AccountsPage'].map(name => `apps/web/src/pages/${name}.tsx`));
  const upstream = JSON.parse(await readFile(resolve(root,'apps/lite/test/upstream-ui.json'),'utf8'));
  for (const path of paths) {
    const current = await readFile(resolve(root, path));
    const original = execFileSync('git', ['show', `${base}:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    if (['apps/web/src/styles/components.css', 'apps/web/src/styles/player.css', 'apps/web/src/styles/pages.css'].includes(path)) assert.equal(createHash('sha256').update(current).digest('hex'), upstream.styles[path], `${path}: matches approved MOA ${upstream.ref} styles`);
    else assert.deepEqual(current, original, path);
  }
  assert(paths.length >= 10);
});
