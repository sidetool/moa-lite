import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { RedisDocuments, MemoryDocuments, updateDocument, type DocumentStore } from './documents.js';
import { authenticate, handleAuth, AuthCache, sessionToken } from './auth.js';
import { decrypt, encrypt } from './secrets.js';
import { synchronize } from './sync.js';
import { sourceHttp } from './network.js';
import { Gemini, MODEL, validModel, validGeminiKey } from '../../../apps/server/src/translation/gemini.js';
import { convertSubtitle } from '@moa/subtitles-ko';
import { searchOnlineSubtitles } from './subtitles.js';
import { parseRepository } from '@moa/extensions';
import { Jimaku } from '../../../apps/server/src/translation/jimaku.js';
import { Store } from '../../../apps/server/src/db.js';
import { Catalog } from '../../../apps/server/src/catalog.js';
import { SqliteDatabase } from '../sqlite.js';
import { sqlite } from './auth.js';
import { RuntimeDiagnostics, createQuotaReader, vercelLimits } from './diagnostics.js';
import { InstanceRateLimiter } from './rate-limit.js';
const MAX_BODY = 4_000_000;
function json(res: ServerResponse, status: number, value: any) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BODY) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"payload-limit"}'); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
}
async function body(req: IncomingMessage) {
  const parsed = (req as IncomingMessage & { body?: any }).body;
  if (parsed !== undefined) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0];
    const value = Buffer.isBuffer(parsed) ? parsed : typeof parsed === 'string' ? Buffer.from(parsed) : type === 'application/x-www-form-urlencoded' ? Buffer.from(new URLSearchParams(parsed).toString()) : Buffer.from(JSON.stringify(parsed));
    if (value.length > MAX_BODY) throw Object.assign(new Error('payload-limit'), { statusCode: 413 });
    return value;
  }
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) throw Object.assign(new Error('payload-limit'), { statusCode: 413 }); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
const safeTmdb = (value: any) => ({ configured: !!(value.token || value.apiKey), source: value.token || value.apiKey ? 'database' : 'none', credentialType: value.token ? 'token' : value.apiKey ? 'apiKey' : null, hasSavedCredential: !!(value.token || value.apiKey) });
const defaultTranslation = { enabled: true, model: MODEL, batchSize: 120, requestIntervalMs: 1000, retryCount: 2, apiKeys: [] as string[] };
function translationView(value: any) { const { apiKeys, ...rest } = { ...defaultTranslation, ...value }; return { ...rest, configured: apiKeys.length > 0, keys: apiKeys.map((key: string, index: number) => ({ id: createHash('sha256').update(key).digest('hex').slice(0, 16), label: `키 ${index + 1} · …${key.slice(-4)}` })) }; }
export function createLiteApplication(options: { store?: DocumentStore; secret?: string; setupCode?: string; origin?: string; dev?: boolean; transport?: typeof sourceHttp; translationFetch?: typeof fetch } = {}) {
  const secret = options.secret ?? process.env.APP_SECRET ?? '', setupCode = options.setupCode ?? process.env.SETUP_CODE ?? '';
  const origin = options.origin ?? process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:5180');
  const allowedOrigins = [...new Set([origin, ...[process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).map(host => `https://${host}`)])];
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL, redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const backingStore = options.store ?? (redisUrl && redisToken ? new RedisDocuments(redisUrl, redisToken, process.env.AUTH_NAMESPACE ?? 'moa-lite') : options.dev ? new MemoryDocuments() : null);
  const authCache = new AuthCache(), limiter = new InstanceRateLimiter();
  const store: DocumentStore | null = backingStore && {
    get: key => backingStore.get(key),
    rate: (key, limit, seconds) => backingStore.rate(key, limit, seconds),
    async compareSet(key, revision, value, ttl) {
      if (key === 'auth') authCache.invalidate();
      try { return await backingStore.compareSet(key, revision, value, ttl); }
      finally { if (key === 'auth') authCache.invalidate(); }
    },
  };
  const missing = [...(secret.length < 32 ? ['APP_SECRET'] : []), ...(!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/i.test(setupCode) ? ['SETUP_CODE'] : []), ...(!store ? ['UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN'] : [])];
  const diagnostics = new RuntimeDiagnostics(), quotas = createQuotaReader();
  return { store, async handle(req: IncomingMessage, res: ServerResponse) {
    diagnostics.track(req, res);
    const abort = new AbortController(); req.on('aborted', () => abort.abort()); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === '/api/health') { json(res, missing.length ? 503 : 200, { ok: !missing.length, version: '0.1.0', name: 'moa-lite', ...(missing.length ? { missing } : {}) }); return; }
      if (missing.length || !store) { json(res, 503, { error: 'hosting-not-configured', missing }); return; }
      const requestOrigin = `${origin.startsWith('https:') ? 'https' : 'http'}://${req.headers.host}`;
      if (!allowedOrigins.includes(requestOrigin)) { json(res, 400, { error: 'invalid-origin' }); return; }
      const mutation = !['GET', 'HEAD'].includes(req.method ?? 'GET');
      if (mutation && path.startsWith('/api/') && req.headers.origin !== requestOrigin) { json(res, 403, { error: 'csrf-required' }); return; }
      const raw = await body(req);
      if (path.startsWith('/__moa/')) {
        if (mutation) {
          const peer = String(req.headers['x-vercel-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0];
          if (!await store.rate(`auth:${createHash('sha256').update(peer).digest('hex')}`, 30, 600)) { json(res, 429, { error: 'rate-limited' }); return; }
        }
        await handleAuth(store, req, res, raw, { secret, setupCode, origin, allowedOrigins }); return;
      }
      if (path === '/api/lite/image' && req.method === 'GET') {
        if (!sessionToken(req)) { json(res, 401, { error: 'login-required' }); return; }
        const ticket = url.searchParams.get('ticket');
        let image;
        try { image = ticket ? decrypt(ticket, secret) : null; }
        catch { throw Object.assign(new Error('invalid-image-ticket'), { statusCode: 403 }); }
        if (!image || typeof image.accountId !== 'string' || !Number.isFinite(image.expires) || image.expires <= Date.now()) {
          throw Object.assign(new Error('image-expired'), { statusCode: 403 });
        }
        const wire = await (options.transport ?? sourceHttp)({url:image.url,headers:image.headers}, abort.signal);
        if (wire.statusCode !== 200 || !/^image\/(?:png|jpe?g|webp|gif|avif|bmp|x-icon)(?:;|$)/i.test(wire.contentType)) throw new Error('invalid-image');
        res.writeHead(200, { 'Content-Type': wire.contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(Buffer.from(wire.bytes, 'base64')); return;
      }
      const actor = await authenticate(store, req, authCache);
      if (!actor) { json(res, 401, { error: 'login-required' }); return; }
      let input: any = {}; if (raw.length) { try { input = JSON.parse(raw.toString('utf8')); } catch { json(res, 400, { error: 'invalid-json' }); return; } }
      const admin = () => { if (actor.role !== 'admin') throw Object.assign(new Error('admin-required'), { statusCode: 403 }); };
      if (path === '/api/lite/diagnostics' && req.method === 'GET') {
        admin();
        if (!limiter.rate(`diagnostics:${actor.id}`, 30, 60)) { json(res, 429, { error: 'rate-limited' }); return; }
        json(res, 200, { limitsCheckedAt: '2026-10-05', vercel: { status: 'dashboard-only', metrics: vercelLimits, dashboard: 'https://vercel.com/dashboard/usage' },
          upstash: await quotas(), runtime: diagnostics.snapshot(), byedpi: { enabled: process.env.BYEDPI_ENABLED !== '0', strategy: process.env.BYEDPI_STRATEGY ?? 'tlsrec' } }); return;
      }
      if (path === '/api/me') { json(res, 200, { id: actor.id, username: actor.username, role: actor.role }); return; }
      if (!limiter.rate(`api:${actor.id}`, 3000, 3600)) { json(res, 429, { error: 'rate-limited' }); return; }
      if (path === '/api/lite/sync' && req.method === 'POST') {
        if (input.accountId !== undefined && input.accountId !== actor.id) { json(res, 401, { error: 'account-changed' }); return; }
        if (input.sharedRevision !== undefined && (!Number.isSafeInteger(input.sharedRevision) || input.sharedRevision < 0)) throw new Error('invalid-sync');
        const result = await synchronize(store, actor.id, input);
        let shared;
        if (input.sharedRevision !== undefined) {
          const row = await store.get('shared');
          if (row.revision !== input.sharedRevision) shared = row;
        }
        json(res, 200, { ...result, ...(shared ? { shared } : {}) }); return;
      }
      const purge = /^\/api\/admin\/accounts\/([\w-]{1,80})\/data$/.exec(path);
      if (purge && req.method === 'DELETE') {
        admin();
        await updateDocument(store, `sync:${purge[1]}`, (doc: any) => {
          doc ??= { revision: 0, rows: {} };
          for (const key of Object.keys(doc.rows)) doc.rows[key] = { version: ++doc.revision, value: null };
          return doc;
        });
        res.writeHead(204); res.end(); return;
      }
      if (path === '/api/lite/shared') {
        if (req.method === 'PUT') {
          admin(); validateShared(input.value);
          if (!await store.compareSet('shared', input.revision, input.value)) { json(res, 409, { error: 'shared-settings-conflict' }); return; }
        } else if (req.method !== 'GET') throw new Error('invalid-request');
        json(res, 200, await store.get('shared')); return;
      }
      const needsSecrets = path === '/api/lite/config' || path === '/api/lite/tmdb' || path === '/api/lite/translate' || path.startsWith('/api/admin/tmdb/') || path.startsWith('/api/admin/translation/') || path === '/api/translation/config';
      const secretsRow = needsSecrets ? await store.get('secrets') : { revision: 0, value: null }, secrets = decrypt(secretsRow.value ?? undefined, secret);
      if (path === '/api/admin/tmdb/config') {
        admin();
        if (req.method === 'PATCH') {
          if (Object.keys(input).length !== 1 || !(input.clear === true || typeof input.token === 'string' && /^[\w.-]{16,4096}$/.test(input.token) || typeof input.apiKey === 'string' && /^[a-f0-9]{32}$/i.test(input.apiKey))) throw new Error('invalid-request');
          secrets.tmdb = input.clear ? {} : input;
          if (!await store.compareSet('secrets', secretsRow.revision, encrypt(secrets, secret))) throw new Error('storage-conflict');
        }
        json(res, 200, safeTmdb(secrets.tmdb ?? {})); return;
      }
      if (path === '/api/lite/config') { json(res, 200, { tmdb: safeTmdb(secrets.tmdb ?? {}), translation: translationView(secrets.translation) }); return; }
      if (path === '/api/lite/tmdb' && req.method === 'POST') {
        const target = new URL(input.url);
        if (target.origin !== 'https://api.themoviedb.org' || !target.pathname.startsWith('/3/') || target.username || target.password || target.hash) throw new Error('invalid-request');
        const key = secrets.tmdb ?? {}; if (!key.token && !key.apiKey) throw new Error('tmdb-not-configured');
        target.searchParams.delete('api_key'); if (key.apiKey) target.searchParams.set('api_key', key.apiKey);
        const response = await fetch(target, { headers: { accept: 'application/json', ...(key.token ? { authorization: `Bearer ${key.token}` } : {}) }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
        json(res, 200, { status: response.status, value: await response.json() }); return;
      }
      if (path === '/api/translation/config') { json(res, 200, translationView(secrets.translation)); return; }
      if (path === '/api/admin/translation/config' && req.method === 'PATCH') {
        admin(); const next = { ...defaultTranslation, ...secrets.translation }, fields = ['apiKey', 'addKeys', 'removeKeyIds', 'model', 'enabled', 'clearKey', 'batchSize', 'requestIntervalMs', 'retryCount'];
        if (Object.keys(input).some(k => !fields.includes(k))) throw new Error('invalid-request');
        if (input.model !== undefined && (typeof input.model !== 'string' || !validModel(input.model)) || input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('invalid-request');
        for (const [name, min, max] of [['batchSize', 10, 300], ['requestIntervalMs', 0, 60000], ['retryCount', 0, 5]] as const) if (input[name] !== undefined && (!Number.isInteger(input[name]) || input[name] < min || input[name] > max)) throw new Error('invalid-request');
        if (!Array.isArray(input.addKeys ?? [])) throw new Error('invalid-request');
        const additions = [...(input.apiKey !== undefined ? [input.apiKey] : []), ...(input.addKeys ?? [])].map(key => typeof key === 'string' ? key.trim() : key);
        if (additions.some(key => !validGeminiKey(key))) throw new Error('translation-key-invalid');
        next.apiKeys = [...new Set([...(input.clearKey ? [] : next.apiKeys.filter((key: string) => !(input.removeKeyIds ?? []).includes(createHash('sha256').update(key).digest('hex').slice(0, 16)))), ...additions])];
        if (next.apiKeys.length > 8) throw new Error('translation-too-many-keys');
        for (const key of ['model', 'enabled', 'batchSize', 'requestIntervalMs', 'retryCount']) if (input[key] !== undefined) next[key] = input[key];
        secrets.translation = next;
        if (!await store.compareSet('secrets', secretsRow.revision, encrypt(secrets, secret))) throw new Error('storage-conflict');
        json(res, 200, translationView(next)); return;
      }
      if (path === '/api/admin/translation/models') { admin(); const cfg = { ...defaultTranslation, ...secrets.translation }; if (!cfg.apiKeys.length) throw new Error('translation-not-configured'); json(res, 200, { models: await new Gemini(options.translationFetch).models(cfg.apiKeys[0], abort.signal) }); return; }
      if (path === '/api/lite/translate' && req.method === 'POST') {
        const cfg = { ...defaultTranslation, ...secrets.translation };
        if (!cfg.enabled) throw new Error('translation-disabled'); if (!cfg.apiKeys.length) throw new Error('translation-not-configured');
        if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > cfg.batchSize || input.lines.some((line: any) => !Number.isInteger(line.id) || typeof line.text !== 'string' || line.text.length > 18000) || JSON.stringify(input).length > 150000) throw new Error('invalid-request');
        const turn = await updateDocument(store, 'translation-turn', (saved: any) => {
          const now = Date.now();
          if (saved?.until > now) throw Object.assign(new Error('translation-busy'), { statusCode: 429, retryAfter: saved.until - now });
          return { counter: (saved?.counter ?? -1) + 1, until: now + cfg.requestIntervalMs };
        });
        // Exactly one provider request per invocation. Browser retries rotate to the next key.
        const key = cfg.apiKeys[turn.value.counter % cfg.apiKeys.length];
        const result = await new Gemini(options.translationFetch).translate(key, cfg.model, input.lines, input.context ?? { title: '', sourceLanguage: '' }, abort.signal);
        json(res, 200, result); return;
      }
      if (path === '/api/lite/convert' && req.method === 'POST') { if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1024 * 1024) throw new Error('invalid-request'); json(res, 200, convertSubtitle(input.content, input.format)); return; }
      if (path === '/api/lite/subtitles' && req.method === 'POST') {
        if (typeof input.title !== 'string' || input.title.length > 300 || !Number.isFinite(input.episode) || input.episode < 0 || !Number.isInteger(input.season) || input.season < 1) throw new Error('invalid-request');
        json(res, 200, await searchOnlineSubtitles(input, abort.signal)); return;
      }
      if ((path === '/api/lite/jimaku' || path === '/api/lite/jimaku/file') && req.method === 'POST') {
        const sql = await sqlite(), saved = path.endsWith('/file') ? await store.get(`jimaku:${actor.id}:${input.searchId}`) : null;
        if (path.endsWith('/file') && !saved?.value) throw new Error('jimaku-search-expired');
        const database = new SqliteDatabase(sql), db = new Store('/tmp/moa-lite', database as any), catalog = new Catalog(db);
        db.db.exec('CREATE TABLE IF NOT EXISTS source_media(media_id TEXT PRIMARY KEY,source_id TEXT,url TEXT,detail_at INTEGER DEFAULT 0)');
        const context = saved?.value?.context ?? input;
        if (typeof context.title !== 'string' || context.title.length > 300 || !Number.isInteger(context.season) || context.season < 1 || !Number.isFinite(context.episode)) throw new Error('invalid-request');
        db.run('INSERT INTO profiles VALUES(?,?,?,?,?,?,?)', 'profile', 'profile', 'violet', 0, new Date().toISOString(), actor.id, null);
        db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)', 'media', context.title, context.type ?? 'anime', '{}', new Date().toISOString());
        db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,NULL)', 'episode', 'media', context.season, context.episode, context.title, 0);
        const jimaku = new Jimaku(db, catalog);
        try {
          if (saved?.value) {
            (jimaku as any).searches.set(input.searchId, { profile: 'profile', episode: 'episode', expires: Date.now() + 60000, result: saved.value.result, files: new Map(saved.value.files) });
            const value = await jimaku.translate('episode', 'profile', input.searchId, input.candidateId, { config: () => ({ configured: true, enabled: true }), start: (_id: string, _profile: string, content: any) => content } as any);
            json(res, 200, value);
          } else {
            const result = await jimaku.search('episode', 'profile', { title: context.title, season: context.season, episode: context.episode });
            const record = (jimaku as any).searches.get(result.searchId);
            await store.compareSet(`jimaku:${actor.id}:${result.searchId}`, 0, { context, result, files: [...record.files] }, 1800);
            json(res, 200, result);
          }
        } finally { await jimaku.close(); database.close(); }
        return;
      }
      if (path === '/api/lite/http' && req.method === 'POST') { json(res, 200, await (options.transport ?? sourceHttp)(input, abort.signal)); return; }
      if (path === '/api/lite/images' && req.method === 'POST') {
        if (!Array.isArray(input.images) || input.images.length > 100) throw new Error('invalid-request');
        const expires = Date.now() + 3600000;
        const tickets = input.images.map((image: any) => {
          if (typeof image?.url !== 'string' || image.url.length > 8192 || !image.headers || typeof image.headers !== 'object' || Array.isArray(image.headers) || Object.keys(image.headers).length > 32 || Object.entries(image.headers).some(([key,value]) => !/^[a-zA-Z0-9-]{1,80}$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value))) throw new Error('invalid-request');
          return {url: '/api/lite/image?ticket=' + encodeURIComponent(encrypt({...image, accountId:actor.id, expires},secret)), expires};
        });
        json(res,200,tickets); return;
      }
      json(res, 404, { error: 'not-found' });
    } catch (error: any) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error.error ?? error.message ?? 'internal-error';
      const safe = /^[a-z][a-z0-9_-]{2,100}$/.test(code) ? code : 'internal-error';
      json(res, error.statusCode ?? (/invalid|payload|limit|disabled|not-configured/.test(safe) ? 400 : /conflict/.test(safe) ? 409 : 502), { error: safe, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    }
  } };
}
function validateShared(value: any) {
  if (!value || !Array.isArray(value.repositories) || !Array.isArray(value.sources) || value.repositories.length > 30 || value.sources.length > 100 || JSON.stringify(value).length > 2_000_000) throw new Error('invalid-request');
  for (const repo of value.repositories) { const url = new URL(repo.url); if (url.protocol !== 'https:' || url.username || url.password || repo.kind !== 'mangayomi-js') throw new Error('invalid-request'); }
  for (const source of value.sources) {
    const entry = JSON.parse(source.installed_entry ?? source.entry);
    if (entry.format !== 'mangayomi-js' || !/^[a-f0-9]{40}$/.test(source.id) || typeof source.code !== 'string' || Buffer.byteLength(source.code) > 1024 * 1024 || createHash('sha256').update(source.code).digest('hex') !== source.sha256) throw new Error('invalid-request');
    parseRepository([{ ...entry, sourceCodeLanguage: 1 }]);
  }
}
