import { RemoteAccess, connectorRpc } from './remote-access.js';
import { readFile } from 'node:fs/promises';
import { ImageCache, IMAGE_CACHE_TTL } from './image-cache.js';
import { Franchises } from './franchise.js';
import { Jimaku } from './translation/jimaku.js';
import { Translations } from './translation/service.js';
import { Gemini } from './translation/gemini.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream } from 'node:fs';
import { access, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Account, Profile, Settings, MediaType, ClientCapabilities, NavigationTab, DefaultNavigationUpdate } from '@moa/shared';
import { config as makeConfig, type Config } from './config.js';
import { DEFAULT_SETTINGS, Store } from './db.js';
import { TitleGroups } from './title-groups.js';
import { Sources } from './sources.js';
import { RemotePlayback } from './remote-playback.js';
import { Catalog, episodeProgress } from './catalog.js';
import { Library } from './library.js';
import { Playback } from './playback.js';
import { ApiFailure, safePath, hash, now, contained } from './util.js';
import { completion } from './progress.js';
import { randomUUID } from 'node:crypto';
import { OnlineSubtitles, type OnlineClient } from './online.js';
import { Enrichment, type EnrichmentOptions } from './enrichment.js';
import { Tmdb } from './tmdb.js';

declare module 'fastify' { interface FastifyRequest { moaProfile?: string; moaAccount: Account } }
const COLORS = ['red', 'blue', 'green', 'amber', 'violet', 'teal'];
const TYPES = ['movie', 'series', 'anime'];
const string = { type: 'string', minLength: 1, maxLength: 200 };
const idParams = (key = 'id') => ({ type: 'object', required: [key], properties: { [key]: string } });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const profileFields = { avatar: { type: ['string', 'null'], pattern: '^[a-z]+-[0-9]{1,2}$', maxLength: 64 }, name: { ...string, pattern: '\\S' }, color: { type: 'string', enum: COLORS }, kids: { type: 'boolean' } };
const filterChange = object({ position: { type: 'integer', minimum: 0, maximum: 511 }, groupPosition: { type: 'integer', minimum: 0, maximum: 511 }, value: { type:['string','number','boolean','object'], maxLength:2000, additionalProperties:false, properties:{index:{type:'integer',minimum:0},ascending:{type:'boolean'}}, required:['index','ascending'] } }, ['position','value']);
const browseSelection = object({ revision: {type:'string',maxLength:80}, filters: {type:'array',maxItems:512,items:filterChange} }, ['revision','filters']);
const settingsFields = { groupHistory: { type: 'boolean' }, navigation: { type: "array", minItems: 1, maxItems: 12, items: object({ id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" }, name: { type: "string", minLength: 1, maxLength: 24, pattern: "\\S" }, sourceIds: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } }, sourceFilters: { type: "object", maxProperties:32, additionalProperties: browseSelection }, includeLocal: { type: "boolean" } }, ["id", "name", "sourceIds", "includeLocal"]) }, autoplayNext: { type: 'boolean' }, autoplayDelay: { type: 'number', minimum: 0 }, defaultSubtitleLang: { type: 'string', maxLength: 32 }, subtitleSize: { type: 'string', enum: ['small', 'medium', 'large', 'xlarge'] }, preferredQuality: { type: 'string', enum: ['auto', '1080', '720', '480'] }, hardwareTranscoding: { type: 'boolean' }, autoFetchSubtitles: { type: 'boolean' }, translationMode: { type: 'string', enum: ['manual','ask','auto'] }, translationSourcePriority: { type: 'string', enum: ['site','jimaku'] }, skipSubtitleSearchWithSiteTrack: { type: 'boolean' }, skipTranslationWithoutSubtitles: { type: 'boolean' } };
const validateNavigation = (tabs: NavigationTab[] | null | undefined) => {
  if (tabs && (tabs[0]?.id !== 'home' || new Set(tabs.map(t => t.id)).size !== tabs.length)) throw new ApiFailure(400, 'invalid-navigation');
};
const pageQuery = { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 };
const typeQuery = { type: 'string', enum: TYPES };
const toProfile = (p: Record<string, any>): Profile => ({ id: p.id, name: p.name, color: p.color, kids: Boolean(p.kids), createdAt: p.created_at, avatar: p.avatar ?? null });
const profile = (req: FastifyRequest) => req.moaProfile!;
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const query = (req: FastifyRequest) => req.query as Record<string, any>;

export async function sendFile(reply: FastifyReply, file: string, mime: string, range?: string) {
  const info = await stat(file), size = info.size;
  reply.type(mime).header('Accept-Ranges', 'bytes');
  if (!range) return reply.header('Content-Length', size).send(createReadStream(file));
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid = () => reply.code(416).header('Content-Range', `bytes */${size}`).send();
  if (!match || !size || (!match[1] && !match[2])) return invalid();
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!(suffix > 0)) return invalid(); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return invalid();
  return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(createReadStream(file, { start, end }));
}
export async function buildApp(overrides: Partial<Config> = {}, logger = true, services: EnrichmentOptions & { store?: Store; subtitleClient?: OnlineClient; translationFetch?: typeof fetch; jimakuFetch?: typeof fetch; tmdb?: { token?: string; key?: string; fetch?: typeof fetch } } = {}) {
  const cfg = makeConfig(overrides);
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allowUnionTypes: true } } });
  const db = services.store ?? new Store(cfg.dataDir), catalog = new Catalog(db);
  const sources = new Sources(db, catalog);
  const connectorSecret = process.env.MOA_CONNECTOR_SECRET_FILE || '/run/moa-connector/token';
  const remoteAccess = new RemoteAccess(cfg.dataDir, process.env.MOA_CONNECTOR_URL ? connectorRpc(process.env.MOA_CONNECTOR_URL, connectorSecret) : null, async () => {
    if (!cfg.requireAccount) return false;
    try {
      const token = (await readFile(connectorSecret, 'utf8')).trim();
      const [auth, gate] = await Promise.all([
        fetch('http://moa-auth:8789/internal/remote-access-safety', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }),
        fetch('http://moa-gateway:8080/api/me', { redirect: 'manual', signal: AbortSignal.timeout(3000) }),
      ]);
      return auth.ok && (await auth.json() as { adminExists: boolean }).adminExists && gate.status === 401;
    } catch { return false; }
  }, process.env.MOA_REMOTE_EXTERNALLY_MANAGED === '1');

  const imageCache = new ImageCache(path.join(cfg.dataDir,'images'),undefined,Date.now,()=>app.log.warn({event:'image-cache-io-error'}));
  const cacheStatsTimer = setInterval(()=>app.log.info({event:'cache-stats',...sources.stats.snapshot()}),5*60_000); cacheStatsTimer.unref();
  const tmdb = new Tmdb(db, value => app.log.info(value), services.tmdb);
  catalog.metadata = tmdb.enabled;
  const groups = new TitleGroups(catalog);
  const franchises = new Franchises(catalog, groups, sources, tmdb);
  // Session tokens live only in memory. Remove their obsolete segments after a restart.
  await rm(path.join(cfg.dataDir, 'sessions'), { recursive: true, force: true });
  const online = new OnlineSubtitles(db, value => app.log.info(value), services.subtitleClient);
  const jimaku = new Jimaku(db, catalog, services.jimakuFetch);
  const translations = new Translations(db, catalog, cfg.dataDir, new Gemini(services.translationFetch));
  const remotePlayback = new RemotePlayback(db, catalog, sources, undefined, online);
  const enrichment = new Enrichment(db, cfg, online, value => app.log.info(value), services);
  const library = new Library(db, cfg, message => app.log.warn(message), () => enrichment.schedule());
  const playback = new Playback(db, catalog, cfg, value => app.log.info(value), online, enrichment);
  /** Give TMDB a moment to link new titles so first visits already show its artwork. */
  const withMetadata = async <T extends { items: { id: string }[] }>(page: T, profileId: string): Promise<T> => {
    const unlinked = page.items.map(c => c.id).filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
    if (!tmdb.enabled || !unlinked.length) return page;
    await tmdb.ensure(unlinked, 1500);
    return { ...page, items: page.items.map(c => { const row = db.get('SELECT * FROM media WHERE id=?', c.id); return row ? { ...catalog.card(row, profileId), ...('sourceCount' in c ? { sourceCount: c.sourceCount } : {}) } : c; }) };
  };
  app.decorateRequest('moaProfile', undefined);
  app.decorateRequest('moaAccount');
  app.setErrorHandler((err, _request, reply) => {
    const error = err as Error & { validation?: unknown; statusCode?: number };
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.error });
    if (error.validation) return reply.code(400).send({ error: 'invalid-request', message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.statusCode === 404 ? 'not-found' : 'invalid-request' });
    app.log.error(error); return reply.code(500).send({ error: 'internal-error' });
  });
  app.addHook('onRequest', async req => {
    // The router decodes static path segments; authorize its matched route, not the raw URL.
    const url = req.routeOptions.url ?? req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/health') return;
    const id = req.headers['x-moa-account'], role = req.headers['x-moa-role'];
    if (id === undefined && role === undefined && !cfg.requireAccount) req.moaAccount = { id: 'local', username: 'local', role: 'admin' };
    else {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['admin', 'member'].includes(String(role))) throw new ApiFailure(401, 'login-required');
      let username = '';
      try { username = decodeURIComponent(String(req.headers['x-moa-username'] ?? '')); } catch { throw new ApiFailure(401, 'login-required'); }
      req.moaAccount = { id, username, role: role as Account['role'] };
    }
    if (req.moaAccount.role === 'admin') db.claimProfiles(req.moaAccount.id);
    const route = url;
    const admin = route.startsWith('/api/admin/') || route.startsWith('/api/network') || route.startsWith('/api/library/') ||
      route.startsWith('/api/source-repositories') || route === '/api/sources/refresh' || route === '/api/sources/remove' ||
      route === '/api/sources/:id/removal-impact' || req.method === 'DELETE' && route === '/api/sources/:id' ||
      /^\/api\/sources\/:id\/(install|rollback|check|preferences)$/.test(route) ||
      req.method === 'PATCH' && (route === '/api/sources/:id' || route === '/api/media/:id/metadata') ||
      req.method === 'DELETE' && route === '/api/episodes/:id/subtitles/:subtitleId';
    if (admin && req.moaAccount.role !== 'admin') throw new ApiFailure(403, 'admin-required');
    const sessionAsset = ['GET','HEAD'].includes(req.method) && /^\/api\/playback\/[^/]+\//.test(url);
    const scoped = !(/^\/api\/(me$|profiles(?:\/|$)|admin\/|images\/)/.test(url)) && !sessionAsset;
    const header = req.headers['x-moa-profile'];
    const copyNavigation = route === '/api/admin/default-navigation' && req.method === 'PUT' && header !== undefined;
    if (scoped || copyNavigation || sessionAsset && header !== undefined) {
      if (typeof header !== 'string' || !db.get('SELECT id FROM profiles WHERE id=? AND account_id=?', header, req.moaAccount.id)) throw new ApiFailure(401, 'profile-required');
      req.moaProfile = header;
    }
    if (sessionAsset) {
      const sessionId = params(req).sessionId;
      const owner = playback.sessions.get(sessionId)?.profile ?? remotePlayback.sessions.get(sessionId)?.profile ?? online.assetProfile(sessionId) ?? translations.assetProfile(sessionId);
      if (owner && !db.get('SELECT 1 FROM profiles WHERE id=? AND account_id=?', owner, req.moaAccount.id)) throw new ApiFailure(403, 'session-account-mismatch');
    }
  });
  app.get('/api/admin/apk/status', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(await sources.apk.status()));
  app.get('/api/admin/tmdb/config', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(tmdb.status()));
  app.patch('/api/admin/tmdb/config', { schema: { body: object({
    token: { type: 'string', minLength: 16, maxLength: 4096, pattern: '^[A-Za-z0-9._-]+$' },
    apiKey: { type: 'string', pattern: '^[a-fA-F0-9]{32}$' }, clear: { type: 'boolean' }
  }) } }, async (req, reply) => {
    const status = tmdb.configure(req.body as Parameters<Tmdb['configure']>[0]);
    catalog.metadata = tmdb.enabled;
    return reply.header('Cache-Control', 'private, no-store').send(status);
  });
  app.get('/api/admin/remote-access', async (_req, reply) => reply.header('Cache-Control', 'private, no-store').send(remoteAccess.status()));
  const remoteConfigSchema = object({ mode: { type: 'string', enum: ['off', 'cloudflare-quick', 'cloudflare-token', 'tailscale'] }, publicHostname: { type: 'string', maxLength: 253 }, funnel: { type: 'boolean' }, cloudflareToken: { type: ['string', 'null'], minLength: 1, maxLength: 8192 }, tailscaleAuthKey: { type: ['string', 'null'], minLength: 1, maxLength: 1024 } }, ['mode']);
  for (const action of ['configure', 'start', 'stop'] as const) {
    app.post(`/api/admin/remote-access/${action}`, { schema: { body: action === 'configure' ? remoteConfigSchema : object({}) } }, async (req, reply) => {
      // Require a JSON request and same-origin browser mutations; no form POST CSRF.
      if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiFailure(415, 'json-required');
      if (req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`) throw new ApiFailure(403, 'csrf-required');
      return reply.header('Cache-Control', 'private, no-store').send(await remoteAccess.mutate(action, req.body as import('@moa/shared').RemoteAccessConfigure));
    });
  }
  app.get('/api/admin/cache-stats', async (_req,reply) => reply.header('Cache-Control','private, no-store').send(sources.stats.snapshot()));
  app.get('/api/me', async req => req.moaAccount);
  app.get('/api/episodes/:id/subtitles/jimaku', { schema: { params: idParams(), querystring: object({ title: { type: 'string', minLength: 1, maxLength: 300 }, season: { type: 'integer', minimum: 1, maximum: 99 }, episode: { type: 'number', minimum: 0, maximum: 10000 } }) } }, async req => jimaku.search(params(req).id, profile(req), query(req)));
  app.post('/api/episodes/:id/subtitles/jimaku/translate', { schema: { params: idParams(), body: object({ searchId: string, candidateId: string, startAt: {type: 'number', minimum: 0, maximum: 864000} }, ['searchId','candidateId']) } }, async req => { const body = req.body as { searchId: string; candidateId: string; startAt?: number }; return jimaku.translate(params(req).id, profile(req), body.searchId, body.candidateId, translations, body.startAt); });
  app.get('/api/translation/config', async () => translations.config());
  app.patch('/api/admin/translation/config', { schema: { body: object({ apiKey: { type: 'string', minLength: 16, maxLength: 256 }, model: { type: 'string', maxLength: 102 }, enabled: { type: 'boolean' }, clearKey: { type: 'boolean' }, batchSize: { type: 'integer', minimum: 10, maximum: 300 }, requestIntervalMs: { type: 'integer', minimum: 0, maximum: 60000 }, retryCount: { type: 'integer', minimum: 0, maximum: 5 }, addKeys: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 16, maxLength: 256 } }, removeKeyIds: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^[a-f0-9]{16}$' } } }) } }, async req => translations.configure(req.body as Parameters<Translations['configure']>[0]));
  app.get('/api/admin/translation/models', async () => translations.models());
  app.post('/api/episodes/:id/subtitles/translate', { bodyLimit: 2 * 1024 * 1024, schema: { params: idParams(), body: object({ content: { type: 'string', minLength: 1, maxLength: 1024 * 1024 }, format: { type: 'string', enum: ['ass','vtt','srt','smi'] }, sourceLabel: { type: 'string', maxLength: 200 }, sourceLanguage: { type: 'string', maxLength: 32 }, startAt: {type: 'number', minimum: 0, maximum: 864000} }, ['content','format','sourceLabel']) } }, async req => translations.start(params(req).id, profile(req), req.body as Parameters<Translations['start']>[2]));
  app.get('/api/episodes/:id/subtitles/translations', { schema: { params: idParams() } }, async req => translations.tracks(params(req).id, profile(req)));
  app.get('/api/translations/:id', { schema: { params: idParams() } }, async req => translations.get(params(req).id, profile(req)));
  app.post('/api/translations/:id/priority', {schema: {params: idParams(), body: object({startAt: {type: 'number', minimum: 0, maximum: 864000}}, ['startAt'])}}, async (req, reply) => { translations.priority(params(req).id, profile(req), (req.body as {startAt: number}).startAt); return reply.code(204).send(); });
  app.delete('/api/translations/:id', { schema: { params: idParams() } }, async (req, reply) => { translations.cancel(params(req).id, profile(req)); return reply.code(204).send(); });

  async function removeProfile(id: string) {
    // Delete the ownership row before awaiting process cleanup so concurrent asset requests fail closed.
    db.run('DELETE FROM profiles WHERE id=?', id);
    online.removeProfile(id);
    translations.removeProfile(id);
    for (const [sid, s] of remotePlayback.sessions) if (s.profile === id) remotePlayback.remove(sid);
    for (const [sid, s] of playback.sessions) if (s.profile === id) await playback.remove(sid);
  }
  app.delete('/api/admin/accounts/:id/data', { schema: { params: idParams() } }, async (req, reply) => {
    for (const row of db.all('SELECT id FROM profiles WHERE account_id=?', params(req).id)) await removeProfile(row.id);
    return reply.code(204).send();
  });
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  app.get('/api/profiles', async req => db.all('SELECT * FROM profiles WHERE account_id=? ORDER BY created_at,id', req.moaAccount.id).map(toProfile));
  app.post('/api/profiles', { schema: { body: object(profileFields, ['name']) } }, async (req, reply) => {
    const body = req.body as { name: string; color?: string; kids?: boolean; avatar?: string | null };
    const id = randomUUID();
    db.transaction(() => {
      const count = db.get('SELECT count(*) AS n FROM profiles WHERE account_id=?', req.moaAccount.id)!.n;
      if (count >= 5) throw new ApiFailure(409, 'profile-limit');
      db.run('INSERT INTO profiles(id,name,color,kids,created_at,account_id,avatar) VALUES(?,?,?,?,?,?,?)', id, body.name.trim(), body.color || COLORS[count % COLORS.length], body.kids ? 1 : 0, now(), req.moaAccount.id, body.avatar ?? null);
      const navigation = db.defaultNavigation();
      if (navigation) db.run('INSERT INTO settings VALUES(?,?)', id, JSON.stringify({ navigation: db.availableNavigation(navigation) }));
    });
    return reply.code(201).send(toProfile(db.get('SELECT * FROM profiles WHERE id=?', id)!));
  });
  app.patch('/api/profiles/:id', { schema: { params: idParams(), body: object(profileFields) } }, async req => {
    const id = params(req).id, old = db.get('SELECT * FROM profiles WHERE id=? AND account_id=?', id, req.moaAccount.id); if (!old) throw new ApiFailure(404, 'profile-not-found');
    const body = req.body as Partial<Profile>;
    db.run('UPDATE profiles SET name=?,color=?,kids=?,avatar=? WHERE id=?', body.name?.trim() ?? old.name, body.color ?? old.color, body.kids !== undefined ? Number(body.kids) : old.kids, body.avatar === undefined ? old.avatar : body.avatar, id);
    return toProfile(db.get('SELECT * FROM profiles WHERE id=?', id)!);
  });
  app.delete('/api/profiles/:id', { schema: { params: idParams() } }, async (req, reply) => {
    if (!db.get('SELECT 1 FROM profiles WHERE id=? AND account_id=?', params(req).id, req.moaAccount.id)) throw new ApiFailure(404, 'profile-not-found');
    await removeProfile(params(req).id);
    return reply.code(204).send();
  });
  app.get('/api/admin/default-navigation', async () => ({ navigation: db.defaultNavigation() }));
  app.put('/api/admin/default-navigation', { schema: { body: { oneOf: [
    object({ navigation: { anyOf: [settingsFields.navigation, { type: 'null' }] } }, ['navigation']),
    object({ fromProfile: { const: true } }, ['fromProfile'])
  ] } } }, async req => {
    const body = req.body as DefaultNavigationUpdate;
    if ('fromProfile' in body && !req.moaProfile) throw new ApiFailure(401, 'profile-required');
    const tabs = 'fromProfile' in body ? db.settings(profile(req)).navigation ?? null : body.navigation;
    validateNavigation(tabs);
    const navigation = tabs === null ? null : db.availableNavigation(tabs);
    db.saveDefaultNavigation(navigation);
    return { navigation };
  });
  app.get('/api/settings', async req => db.settings(profile(req)));
  app.patch('/api/settings', { schema: { body: object(settingsFields) } }, async req => {
    const tabs = (req.body as Partial<Settings>).navigation;
    validateNavigation(tabs);
    const updated: Settings = { ...db.settings(profile(req)), ...req.body as Partial<Settings> };
    db.run('INSERT OR REPLACE INTO settings VALUES(?,?)', profile(req), JSON.stringify(updated)); return updated;
  });
  app.get('/api/home', { schema: { querystring: object({ type: typeQuery, providers: { type: 'string', maxLength: 4096 }, continueScope: { type: 'string', enum: ['tab', 'all'], default: 'tab' }, titleGrouping: { type: 'string', enum: ['true', 'false'], default: 'true' } }) } }, async req => { let home=catalog.home(profile(req), query(req).type, query(req).providers?.split(',').filter(Boolean), query(req).continueScope);
    const unlinked = [...new Set(home.rows.flatMap(r => r.items.map(c => c.id)))].filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
    if (tmdb.enabled && unlinked.length) { await tmdb.ensure(unlinked, 1500); home = catalog.home(profile(req), query(req).type, query(req).providers?.split(',').filter(Boolean), query(req).continueScope); } return {...home,rows:home.rows.map(row=>row.kind === 'watchlist' && query(req).titleGrouping !== 'false' ? {...row,items:groups.resolve(row.items.map(c=>c.id),profile(req))} : row)}; });
  app.get('/api/media', { schema: { querystring: object({ type: typeQuery, genre: string, provider: string, sort: { type: 'string', enum: ['recent', 'title', 'year'], default: 'recent' }, page: pageQuery }) } }, async req => {
    const q = query(req); let cards = catalog.cards(profile(req), q.type);
    if (q.genre) cards = cards.filter(c => c.genres?.includes(q.genre));
    if (q.provider) cards = cards.filter(c => c.provider.id === q.provider);
    if (q.sort === 'title') cards.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    if (q.sort === 'year') cards.sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
    return catalog.page(cards, q.page);
  });
  app.post('/api/media/groups/resolve', { schema: { body: object({ids:{type:'array',maxItems:1000,items:string},query:{type:'string',maxLength:500}},['ids']) } }, async req => groups.resolve((req.body as {ids:string[]}).ids,profile(req),(req.body as {query?:string}).query));
  app.get('/api/media/groups/candidates', { schema: {querystring:object({q:{type:'string',maxLength:200,default:''}})} }, async req => groups.candidates(query(req).q,profile(req)));
  app.get('/api/media/:id/group', {schema:{params:idParams()}}, async req => groups.group(params(req).id,profile(req)));
  app.patch('/api/media/:id/group', {schema:{params:idParams(),body:object({action:{type:'string',enum:['merge','separate','reset']},otherId:string},['action'])}}, async req => {
    const b = req.body as {action:string;otherId?:string}; return groups.change(params(req).id,profile(req),b.action,b.otherId);
  });
  app.get('/api/episodes/:id/context', {schema:{params:idParams()}}, async req=>{const e=db.get('SELECT media_id,season,number FROM episodes WHERE id=?',params(req).id);if(!e)throw new ApiFailure(404,'episode-not-found');return {mediaId:e.media_id,season:e.season,number:e.number};});
  app.get('/api/media/:id/franchise', { schema: { params: idParams() } }, async req => franchises.get(params(req).id, profile(req)));
  app.get('/api/media/:id', { schema: { params: idParams() } }, async req => { catalog.kids.assert(params(req).id, profile(req)); await sources.detail(params(req).id); await tmdb.ensureDetail(params(req).id, 5000); return catalog.detail(params(req).id, profile(req)); });
  app.get('/api/metadata/status', async () => ({ tmdb: tmdb.enabled }));
  app.get('/api/media/:id/metadata/search', { schema: { params: idParams(), querystring: object({ q: { ...string } }, ['q']) } }, async req => catalog.kids.candidates(await tmdb.search(query(req).q), profile(req)));
  app.patch('/api/media/:id/metadata', { schema: { params: idParams(), body: object({ action: { type: 'string', enum: ['link', 'off', 'auto'] }, kind: { type: 'string', enum: ['tv', 'movie'] }, tmdbId: { type: 'integer', minimum: 1 }, season: { type: 'integer', minimum: 1, maximum: 200 } }, ['action']) } }, async req => tmdb.change(params(req).id, req.body as any));
  app.get('/api/genres', { schema: { querystring: object({ type: typeQuery }) } }, async req => [...new Set(catalog.cards(profile(req), query(req).type).flatMap(c => c.genres || []))].sort());
  app.get('/api/search', { schema: { querystring: object({ q: { type: 'string', maxLength: 200, default: '' } }) } }, async req => catalog.search(profile(req), query(req).q));
  app.get('/api/watchlist', async req => groups.resolve(catalog.watchlist(profile(req)).map(c=>c.id),profile(req)));
  app.put('/api/watchlist/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    const id = params(req).mediaId; if (!db.get('SELECT id FROM media WHERE id=?', id)) throw new ApiFailure(404, 'media-not-found');
    db.run('INSERT OR IGNORE INTO watchlist VALUES(?,?,?)', profile(req), id, now()); return reply.code(204).send();
  });
  app.delete('/api/watchlist/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    db.run('DELETE FROM watchlist WHERE profile_id=? AND media_id=?', profile(req), params(req).mediaId); return reply.code(204).send();
  });
  app.get('/api/history', { schema: { querystring: object({ page: pageQuery }) } }, async req => catalog.history(profile(req), query(req).page));
  app.delete('/api/history/media/:mediaId', { schema: { params: idParams('mediaId') } }, async (req, reply) => {
    db.run('DELETE FROM progress WHERE profile_id=? AND episode_id IN (SELECT id FROM episodes WHERE media_id=?)', profile(req), params(req).mediaId);
    return reply.code(204).send();
  });
  app.delete('/api/history/:episodeId', { schema: { params: idParams('episodeId') } }, async (req, reply) => {
    db.run('DELETE FROM progress WHERE profile_id=? AND episode_id=?', profile(req), params(req).episodeId); return reply.code(204).send();
  });
  app.post('/api/progress', { schema: { body: object({ episodeId: string, position: { type: 'number', minimum: 0 }, duration: { type: 'number', exclusiveMinimum: 0 } }, ['episodeId', 'position', 'duration']) } }, async req => {
    const body = req.body as { episodeId: string; position: number; duration: number };
    if (!db.get('SELECT id FROM episodes WHERE id=?', body.episodeId)) throw new ApiFailure(404, 'episode-not-found');
    const remote = sources.remoteEpisode(body.episodeId);
    if (remote && sources.row(remote.source_id).live) throw new ApiFailure(400, 'live-progress-unavailable');
    const position = Math.min(body.position, body.duration);
    db.run('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)', profile(req), body.episodeId, position, body.duration, Number(completion(position, body.duration)), now());
    return episodeProgress(db.get('SELECT * FROM progress WHERE profile_id=? AND episode_id=?', profile(req), body.episodeId)!);
  });
  app.get('/api/network', async () => sources.network());
  app.patch('/api/network', { schema: { body: object({ defaultProxy: { type: 'string', maxLength: 2048 }, revision: { type: 'integer', minimum: 0 } }, ['defaultProxy','revision']) } }, async req => { const body = req.body as { defaultProxy: string; revision: number }; return sources.saveNetwork(body.defaultProxy,body.revision); });
  app.post('/api/network/test', { schema: { body: object({ defaultProxy: { type: 'string', maxLength: 2048 } }, ['defaultProxy']) } }, async req => sources.testNetwork((req.body as { defaultProxy: string }).defaultProxy));
  app.get('/api/sources', async () => sources.list());
  const removeSources = (ids: string[]) => sources.remove(ids, async (episodeIds, imageIds) => {
    online.removeEpisodes(episodeIds);
    for (const [sid, s] of remotePlayback.sessions) if (episodeIds.has(s.response.episodeId)) remotePlayback.remove(sid);
    await Promise.all([...playback.sessions].filter(([, s]) => episodeIds.has(s.response.episodeId)).map(([sid]) => playback.remove(sid)));
    if (imageIds.size) {
      const dir = path.join(cfg.dataDir, 'images');
      const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      await Promise.all(files.filter(file => imageIds.has(file.replace(/-\d+\.webp$/, ''))).map(file => rm(path.join(dir, file), { force: true })));
    }
  });
  app.get('/api/sources/:id/removal-impact', { schema: { params: idParams() } }, async req => sources.removalImpact([params(req).id]));
  app.delete('/api/sources/:id', { schema: { params: idParams() } }, async req => removeSources([params(req).id]));
  app.post('/api/sources/remove', { schema: { body: object({ ids: { type: 'array', minItems: 1, maxItems: 1000, items: string } }, ['ids']) } }, async req => removeSources((req.body as { ids: string[] }).ids));
  app.get('/api/source-repositories',async()=>sources.repositories());
  app.delete('/api/source-repositories',{schema:{body:object({url:{type:'string',maxLength:4096}},['url'])}},async req=>sources.removeRepository((req.body as {url:string}).url));
  app.post('/api/sources/refresh', { schema: { body: object({ url: { type: 'string', maxLength: 4096 }, kind: { type:'string',enum:['mangayomi-js','aniyomi-apk'] } }, ['url']) } }, async req => sources.refresh((req.body as { url: string }).url,(req.body as {kind?:'mangayomi-js'|'aniyomi-apk'}).kind));
  app.post('/api/sources/:id/install', { schema: { params: idParams() } }, async req => sources.install(params(req).id));
  app.post('/api/sources/:id/rollback', {schema:{params:idParams()}},async req=>sources.rollback(params(req).id));
  app.post('/api/sources/:id/check', {schema:{params:idParams()}},async req=>sources.diagnose(params(req).id,profile(req)));
  app.patch('/api/sources/:id', { schema: { params: idParams(), body: object({ enabled: { type: 'boolean' }, type: typeQuery, live: { type: 'boolean' } }) } }, async req => sources.configure(params(req).id, req.body as any));
  app.get('/api/sources/:id/preferences', { schema: { params: idParams() } }, async req => sources.preferences(params(req).id));
  app.patch('/api/sources/:id/preferences', { schema: { params: idParams(), body: { type: 'object', maxProperties: 128 } } }, async req => sources.preferences(params(req).id, req.body as Record<string,unknown>));
  app.get('/api/sources/:id/filters', { schema: { params: idParams() } }, async req => sources.capabilities(params(req).id));
  app.post('/api/sources/:id/browse', { schema: { params: idParams(), body: object({ mode: {type:'string',enum:['popular','latest','search'],default:'popular'}, page:pageQuery, q:{type:'string',maxLength:200,default:''}, selection:browseSelection }) } }, async req => {
    const b = req.body as any; return withMetadata(await sources.browse(params(req).id, profile(req), b.mode, b.page, b.q, b.selection), profile(req));
  });
  app.get('/api/sources/:id/browse', { schema: { params: idParams(), querystring: object({ mode: { type: 'string', enum: ['popular','latest','search'], default: 'popular' }, page: pageQuery, q: { type: 'string', maxLength: 200, default: '' } }) } }, async req => {
    const q = query(req); return withMetadata(await sources.browse(params(req).id, profile(req), q.mode, q.page, q.q), profile(req));
  });
  app.get('/api/library/folders', async () => library.folders());
  app.post('/api/library/folders', { schema: { body: object({ path: { type: 'string', minLength: 1, maxLength: 4096 }, type: typeQuery, label: string }, ['path', 'type']) } }, async (req, reply) => {
    const body = req.body as { path: string; type: MediaType; label?: string }, safe = await safePath(cfg.mediaRoot, body.path, true);
    for (const folder of library.folders()) if (contained(folder.path, safe) || contained(safe, folder.path)) throw new ApiFailure(409, 'folder-overlap');
    const id = randomUUID(); db.run('INSERT INTO folders(id,path,type,label) VALUES(?,?,?,?)', id, safe, body.type, body.label || path.basename(safe));
    return reply.code(201).send(library.folders().find(f => f.id === id));
  });
  app.delete('/api/library/folders/:id', { schema: { params: idParams() } }, async (req, reply) => {
    const files = new Set(db.all('SELECT f.path FROM files f JOIN episodes e ON e.id=f.episode_id JOIN media m ON m.id=e.media_id WHERE m.folder_id=?', params(req).id).map(f => f.path));
    for (const [id, s] of playback.sessions) if (files.has(s.file)) await playback.remove(id);
    db.run('DELETE FROM folders WHERE id=?', params(req).id); return reply.code(204).send();
  });
  app.get('/api/library/browse', { schema: { querystring: object({ path: { type: 'string', maxLength: 4096 } }) } }, async req => {
    const safe = await safePath(cfg.mediaRoot, query(req).path || cfg.mediaRoot, true), dirs: string[] = [];
    for (const dir of await readdir(safe, { withFileTypes: true })) {
      if (dir.isDirectory() || dir.isSymbolicLink()) {
        try { dirs.push(await safePath(cfg.mediaRoot, path.join(safe, dir.name), true)); } catch {}
      }
    }
    return { path: safe, dirs: [...new Set(dirs)].sort() };
  });
  app.post('/api/library/scan', async () => library.start());
  app.get('/api/library/status', async () => library.status);
  app.get('/api/episodes/:id/markers', { schema: { params: idParams(), querystring: object({ duration: {type:'number',minimum:60,maximum:21600} }, ['duration']) } }, async req => {
    if (!db.get('SELECT id FROM episodes WHERE id=?',params(req).id)) throw new ApiFailure(404,'episode-not-found');
    return enrichment.remoteMarkers(params(req).id,(req.query as {duration:number}).duration);
  });
  app.get('/api/episodes/:id/subtitles/online', { schema: { params: idParams(), querystring: object({ title: {type:'string',minLength:1,maxLength:500,pattern:'\\S'}, season: {type:'integer',minimum:1,maximum:99}, episode: {type:'number',minimum:0,maximum:10000}, episodeOffset: {type:'integer',minimum:0,maximum:10000} }) } }, async (req, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    req.raw.once('aborted', abort); reply.raw.once('close', close);
    try { return await online.search(params(req).id, profile(req), controller.signal, req.query as import('@moa/shared').OnlineSubtitleQuery); }
    finally { req.raw.off('aborted', abort); reply.raw.off('close', close); }
  });
  app.post('/api/episodes/:id/subtitles/online', { schema: { params: idParams(), body: object({ searchId: string, candidateId: string }, ['searchId', 'candidateId']) } }, async req => {
    const body = req.body as { searchId: string; candidateId: string };
    return online.apply(params(req).id, profile(req), body.searchId, body.candidateId);
  });
  app.get('/api/episodes/:id/subtitles/:subtitleId/content', async (req, reply) => {
    const row = online.content(params(req).id, params(req).subtitleId, query(req).token, req.moaProfile);
    return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(row.content);
  });
  app.delete('/api/episodes/:id/subtitles/:subtitleId', { schema: { params: object({ id: string, subtitleId: string }, ['id', 'subtitleId']) } }, async (req, reply) => {
    online.remove(params(req).id, params(req).subtitleId);
    for (const s of playback.sessions.values()) if (s.response.episodeId === params(req).id) {
      s.subtitleSources.delete(params(req).subtitleId);
      s.response.subtitles = s.response.subtitles.filter(t => t.id !== params(req).subtitleId);
    }
    return reply.code(204).send();
  });
  app.post('/api/playback', { schema: { body: object({ episodeId: string, capabilities: object({ h264: { type: 'boolean' }, hevc: { type: 'boolean' }, av1: { type: 'boolean' }, vp9: { type: 'boolean' }, audioCodecs: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 32 }, maxHeight: { type: 'integer', minimum: 2 } }, ['h264', 'hevc', 'av1']), audioTrackId: string, streamId: string, startPosition: { type: 'number', minimum: 0 } }, ['episodeId', 'capabilities']) } }, async req => {
    const body = req.body as { episodeId: string; capabilities: ClientCapabilities; audioTrackId?: string; streamId?: string; startPosition?: number };
    const episode = db.get('SELECT media_id FROM episodes WHERE id=?', body.episodeId);
    if (episode) catalog.kids.assert(episode.media_id, profile(req));
    const result = sources.remoteEpisode(body.episodeId)
      ? await remotePlayback.create(profile(req), body.episodeId, body.startPosition, body.streamId)
      : await playback.create(profile(req), body.episodeId, body.capabilities, body.audioTrackId, body.startPosition);
    result.subtitles.push(...translations.tracks(body.episodeId, profile(req)));
    return result;
  });
  app.post('/api/playback/:sessionId/heartbeat', { schema: { params: idParams('sessionId') } }, async (req, reply) => {
    remotePlayback.heartbeat(params(req).sessionId, profile(req));
    return reply.code(204).send();
  });
  app.delete('/api/playback/:sessionId', { schema: { params: idParams('sessionId') } }, async (req, reply) => {
    if (remotePlayback.sessions.has(params(req).sessionId)) { remotePlayback.get(params(req).sessionId, profile(req)); await remotePlayback.remove(params(req).sessionId); return reply.code(204).send(); }
    if (online.removeAsset(params(req).sessionId, profile(req))) return reply.code(204).send();
    playback.get(params(req).sessionId, profile(req)); await playback.remove(params(req).sessionId); return reply.code(204).send();
  });
  app.get('/api/playback/:sessionId/remote/:asset', async (req, reply) => remotePlayback.proxy(req, reply, params(req).sessionId, params(req).asset));
  const session = (req: FastifyRequest) => playback.get(params(req).sessionId, req.moaProfile);
  app.get('/api/playback/:sessionId/index.m3u8', async (req, reply) => {
    const s = session(req); if (s.response.mode === 'direct') throw new ApiFailure(404, 'not-hls');
    return reply.type('application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(playback.playlist(s));
  });
  app.get('/api/playback/:sessionId/original', async (req, reply) => {
    const s = session(req); if (s.response.mode !== 'direct') throw new ApiFailure(404, 'not-direct');
    const safe = await safePath(cfg.mediaRoot, s.file); return sendFile(reply, safe, s.response.mime, req.headers.range);
  });
  app.get('/api/playback/:sessionId/:asset', async (req, reply) => {
    const s = session(req), asset = params(req).asset, match = /^(seg-(\d+)\.m4s|init\.mp4)$/.exec(asset);
    if (!match || s.response.mode === 'direct') throw new ApiFailure(404, 'not-found');
    const file = asset === 'init.mp4' ? await playback.initialization(s) : await playback.segment(s, Number(match[2]));
    return sendFile(reply.header('Cache-Control', 'private, max-age=1800'), file, 'video/mp4');
  });
  app.get('/api/playback/:sessionId/subtitles/:track', async (req, reply) => {
    const translated = translations.asset(params(req).sessionId, params(req).track, req.moaProfile);
    if (translated) return reply.type(translated.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(translated.content);
    if (remotePlayback.sessions.has(params(req).sessionId)) {
      const row = remotePlayback.savedSubtitle(params(req).sessionId,params(req).track,req.moaProfile);
      return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control','private, no-store').send(row.content);
    }
    const applied = online.asset(params(req).sessionId, params(req).track, req.moaProfile);
    if (applied) return reply.type(applied.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(applied.content);
    const s = session(req), track = params(req).track, source = s.subtitleSources.get(track.replace(/\.(ass|vtt)$/, ''));
    if (!source || !track.endsWith(`.${source.format}`)) throw new ApiFailure(404, 'subtitle-not-found');
    if (source.onlineId) {
      const row = online.content(s.response.episodeId, source.onlineId, undefined, s.profile);
      return reply.type(row.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').header('Cache-Control', 'private, no-store').send(row.content);
    }
    const safe = await safePath(cfg.mediaRoot, source.file);
    // Preserve external ASS exactly, including styles, embedded drawings, and timing.
    if (source.stream === undefined && source.format === 'ass') return sendFile(reply, safe, 'text/x-ssa; charset=utf-8');
    if (source.stream === undefined && /\.vtt$/i.test(safe)) return sendFile(reply, safe, 'text/vtt; charset=utf-8');
    const cached = await playback.subtitleCache.get(safe, source.stream, source.format);
    return sendFile(reply, cached, source.format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8');
  });
  app.get('/api/playback/:sessionId/fonts/:font', async (req, reply) => {
    const s = session(req), index = s.fontSources.get(params(req).font); if (index === undefined) throw new ApiFailure(404, 'font-not-found');
    const file = await playback.subtitleCache.font(await safePath(cfg.mediaRoot, s.file), index);
    return sendFile(reply, file, 'application/octet-stream');
  });
  app.get('/api/images/:id', { schema: { params: idParams(), querystring: object({ w: { type: 'integer', minimum: 32, maximum: 1920 } }) } }, async (req, reply) => {
    if (params(req).id.startsWith('source-')) {
      if (!db.get('SELECT 1 FROM source_images WHERE id=?', params(req).id)) throw new ApiFailure(404, 'image-not-found');
      const id = params(req).id, width = query(req).w || 960;
      const bytes = await imageCache.get(`${id}-${width}.webp`,IMAGE_CACHE_TTL,async()=> {
        const original = await imageCache.original(id,()=>sources.imageContent(id));
        return sharp(original,{limitInputPixels:40_000_000}).resize({width,withoutEnlargement:true}).webp({quality:82}).toBuffer();
      });
      if (!db.get('SELECT 1 FROM source_images WHERE id=?',id)) { await rm(path.join(cfg.dataDir,'images',`${id}-${width}.webp`),{force:true}); throw new ApiFailure(404,'image-not-found'); }
      return reply.header('Cache-Control','public, max-age=3600').type('image/webp').send(bytes);
    }
    const image = db.get('SELECT * FROM images WHERE id=?', params(req).id); if (!image) throw new ApiFailure(404, 'image-not-found');
    const source = image.local ? await safePath(cfg.mediaRoot, image.path) : image.path, info = await stat(source);
    const width = query(req).w || 960, etag = hash(`${image.id}:${info.mtimeMs}:${info.size}:${width}`);
    reply.header('ETag', `"${etag}"`).header('Cache-Control', 'public, max-age=3600');
    if (req.headers['if-none-match'] === `"${etag}"`) { await imageCache.touch(`${etag}.webp`); return reply.code(304).send(); }
    const bytes = await imageCache.get(`${etag}.webp`,Infinity,()=>sharp(source).resize({width,withoutEnlargement:true}).webp({quality:82}).toBuffer());
    return reply.type('image/webp').send(bytes);
  });
  let web = false;
  try { await access(path.join(cfg.webDir, 'index.html')); web = true; } catch {}
  if (web) await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false });
  app.setNotFoundHandler(async (req, reply) => {
    if (web && ['GET', 'HEAD'].includes(req.method) && req.url.split('?')[0] !== '/api' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not-found' });
  });
  // Periodic scans reuse the same incremental scan path; disabled with 0 for tests.
  const interval = Math.max(0, Number(process.env.MOA_SCAN_INTERVAL_MS ?? 6 * 60 * 60 * 1000));
  const scanTimer = interval > 0 ? setInterval(() => library.start(), interval) : undefined; scanTimer?.unref();
  app.addHook('onReady', async () => { await remoteAccess.init(); enrichment.schedule(); void tmdb.backfill().catch(error => app.log.warn({ event: 'tmdb-backfill-error', error: String(error) })); });
  app.addHook('onClose', async () => { remoteAccess.close(); clearInterval(cacheStatsTimer); await imageCache.close(); if (scanTimer) clearInterval(scanTimer); await franchises.close(); tmdb.close(); await jimaku.close(); await translations.close(); online.close(); remotePlayback.close(); await sources.close(); await library.pending; await enrichment.close(); await playback.close(); db.close(); });
  return { app, db, sources, remotePlayback, catalog, library, playback, online, translations, jimaku, enrichment, config: cfg };
}
