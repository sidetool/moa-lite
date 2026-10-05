import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, readlink, symlink, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { FileFsRef, streamToBuffer, isSymbolicLink } from '@vercel/build-utils';
import Ajv from 'ajv-draft-04';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../../..');
const config = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
const schema = await fetch('https://openapi.vercel.sh/vercel.json').then(r => r.json());
// The published draft-04 schema also contains numeric draft-06 exclusive bounds.
function bounds(value: any) { if (!value || typeof value !== 'object') return; for (const [name, part] of Object.entries(value)) { if (['exclusiveMinimum', 'exclusiveMaximum'].includes(name) && typeof part === 'number') { value[name === 'exclusiveMinimum' ? 'minimum' : 'maximum'] = part; value[name] = true; } else bounds(part); } }
bounds(schema);
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(schema); assert(Boolean(validate(config)), JSON.stringify(validate.errors));
const { build } = require('@vercel/node');
const result = await build({ files: { 'api/index.ts': new FileFsRef({ fsPath: resolve(root, 'api/index.ts') }) }, entrypoint: 'api/index.ts', workPath: root, repoRootPath: root,
  config: { ...config.functions['api/index.ts'], projectSettings: { installCommand: '', buildCommand: 'true', nodeVersion: '24.x', createdAt: Date.now() } }, considerBuildCommand: true, meta: { skipDownload: true } });
const lambda = result.output, files = Object.keys(lambda.files);
assert(files.some(path => path.endsWith('deploy/auth/login.html')));
assert(files.some(path => path.endsWith('deploy/auth/setup.html')));
assert(files.some(path => path.endsWith('sql.js/dist/sql-wasm.wasm')));
assert(files.includes('vendor/byedpi/ciadpi-linux-x64'));
assert(files.includes('vendor/byedpi/LICENSE'));
assert(!files.some(path => /apps\/lite\/test\/assets/.test(path)));
const dir = resolve(root, '.state/vercel-function'); await mkdir(dir, { recursive: true });
let size = 0;
for (const [name, file] of Object.entries(lambda.files) as [string, any][]) {
  const target = resolve(dir, name); assert(target.startsWith(dir + '/'));
  await mkdir(dirname(target), { recursive: true });
  if (isSymbolicLink(file.mode)) { await symlink(await readlink(file.fsPath), target).catch((error: any) => { if (error.code !== 'EEXIST') throw error; }); continue; }
  const bytes = await streamToBuffer(file.toStream()); size += bytes.length;
  await writeFile(target, bytes);
  if (file.mode) await chmod(target, file.mode & 0o777);
}
assert(size < 250 * 1024 * 1024);
await writeFile(resolve(dir, 'verification.json'), JSON.stringify({ runtime: lambda.runtime, handler: lambda.handler, files: files.length, size }, null, 2));
console.log(`PASS Vercel configuration schema and official Node builder: ${lambda.runtime}, ${files.length} files, ${(size / 1024 / 1024).toFixed(2)} MiB. Function: ${dir}`);
const { withByeDpi } = await import(pathToFileURL(resolve(dir, 'apps/lite/server/byedpi.js')).href);
const { compatibilityHttp } = await import(pathToFileURL(resolve(dir, 'packages/extensions/src/http.js')).href);
const fixture = createServer((_req, res) => res.end('packaged-native-relay'));
await new Promise<void>(yes => fixture.listen(0, '127.0.0.1', yes));
try {
  const target = `http://127.0.0.1:${(fixture.address() as any).port}`;
  await withByeDpi(AbortSignal.timeout(5000), async (proxy: string) => {
    assert(proxy);
    const result = await compatibilityHttp({ url: target }, AbortSignal.timeout(5000), [target], 1024, proxy);
    assert.equal(result.bytes.toString(), 'packaged-native-relay');
  }, { enabled: true });
  console.log('PASS packaged native ByeDPI executable and actual SOCKS relay');
} finally { fixture.closeAllConnections(); await new Promise<void>(yes => fixture.close(() => yes())); }
const documents = new Map<string, string>();
const redis = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const command = JSON.parse(Buffer.concat(chunks).toString()); let result;
  if (command[0] === 'GET') result = documents.get(command[1]) ?? null;
  else if (command[1].includes('local cached=')) { const raw = documents.get(command[3]); const { createHash } = await import('node:crypto'); result = !raw ? '' : createHash('sha1').update(raw).digest('hex') === command[4] ? null : raw; }
  else if (command[1].includes('local old=')) { const previous = JSON.parse(documents.get(command[3]) ?? '{"revision":0}'); result = previous.revision === Number(command[4]) ? 1 : 0; if (result) documents.set(command[3], command[5]); }
  else result = 1;
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
});
await new Promise<void>(resolve => redis.listen(0, '127.0.0.1', resolve));
let handler: any;
const api = createServer(async (req, res) => {
  // Vercel parses request bodies before invoking Node API handlers.
  if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); const text = Buffer.concat(chunks).toString(); (req as any).body = req.headers['content-type']?.includes('application/json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); }
  await handler(req, res);
});
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(api.address() as any).port}`;
Object.assign(process.env, { APP_SECRET: 'moa-lite-vercel-package-verification-secret', SETUP_CODE: 'LITE-TEST-SETU-P001', APP_URL: origin, UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${(redis.address() as any).port}`, UPSTASH_REDIS_REST_TOKEN: 'test-only-token' });
try {
  handler = (await import(pathToFileURL(resolve(dir, 'api/index.js')).href)).default;
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  const setup = await fetch(origin + '/__moa/setup'), html = await setup.text(); assert.equal(setup.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1], cookie = setup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const created = await fetch(origin + '/__moa/setup', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookie }, body: new URLSearchParams({ csrf, code: 'LITE-TEST-SETU-P001', username: 'admin', password: 'vercel-test-password', confirm: 'vercel-test-password', remember: 'on' }) });
  assert.equal(created.status, 303);
  const session = created.headers.getSetCookie().find(value => value.startsWith('moa_session='))!.split(';')[0];
  assert.equal((await fetch(origin + '/api/me', { headers: { Cookie: session } }).then(r => r.json())).role, 'admin');
  assert.equal((await fetch(origin + '/__moa/login.css')).status, 200);
  assert.equal((await fetch(origin + '/api/lite/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: session }, body: '{"since":0,"changes":[]}' })).status, 200);
  console.log('PASS packaged Node function cold import, WASM/auth assets, Redis REST persistence and pre-parsed Vercel form/JSON bodies');
} finally { await new Promise<void>(resolve => api.close(() => resolve())); await new Promise<void>(resolve => redis.close(() => resolve())); }
