import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { zipDirectory } from './zip.mjs';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(join(root, '.env')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const nativeBinary = join(root, 'vendor/byedpi/ciadpi-linux-x64');
if (createHash('sha256').update(await readFile(nativeBinary)).digest('hex') !== 'c70e87c6168af1832b21641a98bb53e3500b1daf6a5df8bfd22fac4a9294abda') throw new Error('ByeDPI binary checksum mismatch');
await chmod(nativeBinary, 0o755);
const output = join(root, 'apps/web/public/runtime'); await mkdir(output, { recursive: true });
await mkdir(join(root, 'apps/web/public/install'), { recursive: true });
await copyFile(require.resolve('sql.js/dist/sql-wasm.wasm'), join(output, 'sql-wasm.wasm'));
await copyFile(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), join(output, 'quickjs.wasm'));
const client = (file: string) => join(root, 'apps/lite/client', file);
const browserPlugin = { name: 'moa-browser-host', setup(builder: any) {
  builder.onResolve({ filter: /^node:/ }, ({ path }: any) => ({ path: client(path === 'node:crypto' ? 'crypto.ts' : path === 'node:timers/promises' ? 'timers.ts' : 'platform.ts') }));
  builder.onResolve({ filter: /^@moa\/(?:extensions|subtitles-ko)$/ }, ({ path }: any) => ({ path: client(path === '@moa/extensions' ? 'extensions.ts' : 'subtitles.ts') }));
  builder.onResolve({ filter: /^\.\/util\.js$/ }, ({ importer }: any) => importer.includes('apps/server/src') ? { path: client('util.ts') } : undefined);
  builder.onResolve({ filter: /^\.\/apk-bridge\.js$/ }, () => ({ path: client('apk.ts') }));
  builder.onResolve({ filter: /^\.\/http\.js$/ }, ({ importer }: any) => importer.includes('packages/extensions/src/repository') ? { path: client('extensions.ts') } : undefined);
} };
const dom = await readFile(join(dirname(require.resolve('linkedom')), '../worker.js'), 'utf8');
if (!/\nexport \{[^}]+\};\s*$/.test(dom)) throw new Error('DOM bundle changed');
const realm = '(function(){\n' + dom.replace(/\nexport \{[^}]+\};\s*$/, '\nglobalThis.__moaParseHTML=parseHTML;') + '\n})();';
for (const name of ['source-worker', 'catalog-worker']) await build({ entryPoints: [client(name + (name === 'source-worker' ? '.js' : '.ts'))], outfile: join(output, name + '.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, inject: [client('globals.ts')], plugins: [browserPlugin], define: { __MOA_DOM_SOURCE__: JSON.stringify(realm) }, logLevel: 'info' });
const notices: string[] = [await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8')];
for (const name of ['sql.js', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync', 'linkedom', '@noble/hashes', '@noble/ciphers', 'buffer']) {
  const location = dirname(require.resolve(name === 'buffer' ? 'buffer/' : name === '@noble/hashes' ? name + '/sha2.js' : name === '@noble/ciphers' ? name + '/aes.js' : name));
  let license = '';
  for (const candidate of [join(location, 'LICENSE'), join(location, '../LICENSE'), join(location, 'LICENSE.txt'), join(location, '../LICENSE.txt')]) { try { license = await readFile(candidate, 'utf8'); break; } catch {} }
  if (!license) throw new Error('Missing license: ' + name);
  notices.push(name + '\n' + license);
}
await writeFile(join(output, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n'));
for (const target of ['chromium', 'firefox']) {
  const dir = join(root, '.state/extension', target); await mkdir(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: 'moa-lite Browser Connector', version: '0.1.0', description: 'MOA의 소스 조회와 직접 영상 재생을 브라우저에서 연결합니다.', permissions: ['activeTab', 'storage', 'scripting', 'webRequest', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'], background: target === 'chromium' ? { service_worker: 'background.js' } : { scripts: ['background.js'] }, action: { default_popup: 'popup.html' } };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const name of ['background', 'content', 'popup']) await build({ entryPoints: [join(root, 'apps/lite/connector', name + '.js')], outfile: join(dir, name + '.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true });
  await copyFile(join(root, 'apps/lite/connector/popup.html'), join(dir, 'popup.html'));
  await copyFile(join(root, 'apps/lite/connector/popup.html'), join(dir, 'setup.html'));
  await zipDirectory(dir, join(root, 'apps/web/public/install', 'moa-lite-connector-' + target + '.zip'));
}
await writeFile(join(root, 'apps/web/.env.production.local'), 'VITE_MOA_LITE=1\n');
