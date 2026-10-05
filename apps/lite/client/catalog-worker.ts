import { selectPlaybackStream } from './playback-streams.js';
import { mergeBackground } from './background-state.js';
import { inlineSubtitle, remoteMediaType, subtitleVtt } from '../../../apps/server/src/remote-media.js';
import './globals.js';
import initSqlJs from 'sql.js';
import { SqliteDatabase } from '../sqlite.js';
import { Store } from '../../../apps/server/src/db.js';
import { Catalog, episodeProgress } from '../../../apps/server/src/catalog.js';
import { Sources } from '../../../apps/server/src/sources.js';
import { TitleGroups } from '../../../apps/server/src/title-groups.js';
import { Franchises } from '../../../apps/server/src/franchise.js';
import { Tmdb } from '../../../apps/server/src/tmdb.js';
import { completion } from '../../../apps/server/src/progress.js';
import { subtitleQuery } from '../../../apps/server/src/subtitle-query.js';
import { playbackMediaType } from '../../../apps/server/src/tmdb.js';
import { subtitleDocument, nextBatch, translatedRanges } from '../../../apps/server/src/translation/subtitle.js';
import { AniSkipClient } from '../../../packages/skip-markers/src/aniskip.js';
import { randomUUID } from './crypto.js';
import { hash, now, ApiFailure } from '../domain.js';
import { host, hostReply } from './host.js';
import { compatibilityHttp } from './extensions.js';
import type { Account, PlaybackSession, SubtitleTrack } from '@moa/shared';

const SQL = initSqlJs({ locateFile: () => '/runtime/sql-wasm.wasm' });
const primary: Record<string, string[]> = { profiles: ['id'], settings: ['id'], media: ['id'], episodes: ['id'], source_media: ['media_id'], source_episodes: ['episode_id'], source_images: ['id'], tmdb_links: ['media_id'], progress: ['profile_id', 'episode_id'], watchlist: ['profile_id', 'media_id'], title_group_overrides: ['profile_id', 'media_id'] };
const order = Object.keys(primary);
let database: SqliteDatabase, db: Store, catalog: Catalog, sources: Sources, groups: TitleGroups, franchises: Franchises, tmdb: Tmdb;
let actor: Account, config: any, syncState: any, shared: any;
const sessions = new Map<string, PlaybackSession>();

let stamp: string | undefined, published: Uint8Array | undefined, sharedBaseline = '', inRequest = false;
let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
function checkpoint() {
  if (inRequest || checkpointTimer) return;
  checkpointTimer = setTimeout(() => { checkpointTimer = undefined; postMessage({type:'checkpoint'}); }, 30);
}
async function initialize(state: any, account: Account, settings: any) {
  const sameAccount = actor?.id === account.id;
  if (sources && sameAccount && state?.stamp && state.stamp === stamp && JSON.stringify(config) === JSON.stringify(settings)) {
    actor = account; config = settings; syncState = state.sync; shared = state.shared; return;
  }
  const previous = database;
  if (sources) { await franchises.close(); await sources.close(); tmdb.close(); }
  actor = account; config = settings;
  const sql = await SQL;
  database = new SqliteDatabase(sql, state?.bytes ? new Uint8Array(state.bytes) : undefined);
  if (sameAccount && published && state?.bytes) mergeBackground(sql, published, previous, database);
  previous?.close();
  db = new Store('', database as any); catalog = new Catalog(db); sources = new Sources(db, catalog); groups = new TitleGroups(catalog);
  // Credentials remain on the server. The original matcher sends requests through this broker.
  tmdb = new Tmdb(db, () => {}, { token: config.tmdb.configured ? 'broker' : undefined, fetch: async (url: any, init?: RequestInit) => {
    const wire = await host('api', { path: '/lite/tmdb', body: { url: String(url) } }, init?.signal ?? undefined);
    return new Response(JSON.stringify(wire.value), { status: wire.status, headers: { 'Content-Type': 'application/json' } });
  } });
  catalog.metadata = tmdb.enabled;
  franchises = new Franchises(catalog, groups, sources, tmdb);
  syncState = state?.sync ?? { revision: 0, rows: {}, pending: {} };
  shared = state?.shared ?? { revision: 0, value: null };
  db.db.exec(`CREATE TABLE IF NOT EXISTS lite_jobs(id TEXT PRIMARY KEY,profile TEXT NOT NULL,episode TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lite_searches(id TEXT PRIMARY KEY,profile TEXT NOT NULL,episode TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL)`);
  database.onWrite = checkpoint;
  sharedBaseline = JSON.stringify(shared.pending ?? shared.value ?? sharedValue());
}
function snapshotRows() {
  const result: Record<string, any> = {};
  const put = (table: string, rows: any[]) => { for (const row of rows) result[JSON.stringify([table, ...primary[table].map(k => row[k])])] = row; };
  for (const table of ['profiles', 'settings', 'progress', 'watchlist', 'title_group_overrides']) put(table, db.all(`SELECT * FROM ${table}`));
  const media = new Set<string>([...db.all('SELECT media_id FROM watchlist'), ...db.all('SELECT e.media_id FROM progress p JOIN episodes e ON e.id=p.episode_id'), ...db.all('SELECT media_id FROM title_group_overrides')].map(r => r.media_id));
  for (const id of media) {
    put('media', db.all('SELECT * FROM media WHERE id=?', id).map(row => {
      const metadata = JSON.parse(row.metadata);
      const reference = Object.fromEntries(['provider', 'poster', 'backdrop', 'year', 'live', 'adult'].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
      return { ...row, metadata: JSON.stringify(reference) };
    }));
    put('source_media', db.all('SELECT * FROM source_media WHERE media_id=?', id).map(row => ({ ...row, detail_at: 0 })));
    put('tmdb_links', db.all("SELECT * FROM tmdb_links WHERE media_id=? AND status IN ('manual','off')", id));
    const episodes = db.all('SELECT e.* FROM episodes e JOIN progress p ON p.episode_id=e.id WHERE e.media_id=?', id);
    put('episodes', episodes);
    for (const episode of episodes) put('source_episodes', db.all('SELECT * FROM source_episodes WHERE episode_id=?', episode.id));
    const row = db.get('SELECT metadata FROM media WHERE id=?', id);
    const metadata = row && JSON.parse(row.metadata);
    for (const url of [metadata?.poster, metadata?.backdrop, ...episodes.map(row => row.thumb)]) {
      const image = url?.match(/^\/api\/images\/(source-[a-f0-9]+)$/)?.[1];
      if (image) put('source_images', db.all('SELECT * FROM source_images WHERE id=?', image));
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => order.indexOf(JSON.parse(a)[0]) - order.indexOf(JSON.parse(b)[0])));
}
function collectChanges() {
  const rows = snapshotRows();
  for (const key of new Set([...Object.keys(syncState.rows), ...Object.keys(rows), ...Object.keys(syncState.pending)])) {
    const value = rows[key] ?? null, previous = syncState.rows[key];
    if (JSON.stringify(value) !== JSON.stringify(previous?.value ?? null)) syncState.pending[key] = { key, base: previous?.version ?? 0, value };
    else delete syncState.pending[key];
  }
}
function applyRows(rows: Record<string, any>) {
  db.transaction(() => {
    // Parents are inserted before children; deletions run in the reverse order.
    for (const table of order) for (const [key, row] of Object.entries(rows)) {
      const identity = JSON.parse(key); if (identity[0] !== table || !row.value) continue;
      const allowed = new Set(db.all(`PRAGMA table_info(${table})`).map(r => r.name));
      const value = { ...row.value, ...(table === 'profiles' ? { account_id: actor.id } : {}) };
      if (table === 'media') {
        const cached = db.get('SELECT metadata FROM media WHERE id=?', value.id);
        // Cloud rows hold references only. Keep the device's full source detail cache.
        if (cached) value.metadata = JSON.stringify({ ...JSON.parse(cached.metadata), ...JSON.parse(value.metadata) });
      }
      if (table === 'source_media' && !db.get('SELECT 1 FROM source_entries WHERE id=?', value.source_id)) {
        const provider = JSON.parse(db.get('SELECT metadata FROM media WHERE id=?', value.media_id)!.metadata).provider;
        db.run('INSERT INTO source_entries(id,repository,entry) VALUES(?,?,?)', value.source_id, 'https://source-unavailable.invalid/', JSON.stringify({ id: value.source_id, name: provider?.name ?? '사용할 수 없는 소스', format: 'mangayomi-js', version: '', itemType: 1 }));
      }
      const columns = Object.keys(value); if (columns.some(k => !allowed.has(k)) || primary[table].some((k, i) => value[k] !== identity[i + 1])) throw new ApiFailure(400, 'invalid-sync');
      const update = columns.filter(k => !primary[table].includes(k));
      db.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${primary[table].join(',')}) DO ${update.length ? 'UPDATE SET ' + update.map(k => `${k}=excluded.${k}`).join(',') : 'NOTHING'}`, ...columns.map(k => value[k]));
    }
    for (const table of [...order].reverse()) for (const [key, row] of Object.entries(rows)) {
      const identity = JSON.parse(key); if (identity[0] !== table || row.value !== null) continue;
      db.run(`DELETE FROM ${table} WHERE ${primary[table].map(k => k + '=?').join(' AND ')}`, ...identity.slice(1));
    }
  });
  for (const [key, row] of Object.entries(rows)) { syncState.rows[key] = row; delete syncState.pending[key]; }
}
function applyShared(value: any) {
  if (!value) return;
  db.transaction(() => {
    for (const row of value.sources) { const old = db.get('SELECT * FROM source_entries WHERE id=?', row.id); if (old && ['sha256','preferences','enabled','type','live'].some(key => old[key] !== row[key])) sources.invalidate(row.id); }
    const installed = new Set(value.sources.map((row: any) => row.id));
    for (const row of db.all('SELECT id FROM source_entries WHERE code IS NOT NULL')) if (!installed.has(row.id)) db.run('UPDATE source_entries SET code=NULL,installed_entry=NULL,enabled=0 WHERE id=?', row.id);
    db.run('UPDATE source_repositories SET active=0');
    for (const repo of value.repositories) db.run('INSERT INTO source_repositories(url,active,kind,checked_at,error) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET active=excluded.active,kind=excluded.kind', repo.url, repo.active, repo.kind, repo.checked_at, repo.error);
    for (const row of value.sources) db.run(`INSERT INTO source_entries(id,repository,entry,installed_entry,code,sha256,preferences,enabled,type,live) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,entry=excluded.entry,installed_entry=excluded.installed_entry,code=excluded.code,sha256=excluded.sha256,preferences=excluded.preferences,enabled=excluded.enabled,type=excluded.type,live=excluded.live`, ...['id', 'repository', 'entry', 'installed_entry', 'code', 'sha256', 'preferences', 'enabled', 'type', 'live'].map(k => row[k]));
    db.run('DELETE FROM source_backups');
    for (const row of value.backups ?? []) if (installed.has(row.source_id)) db.run('INSERT INTO source_backups VALUES(?,?,?,?,?)', row.source_id, row.entry, row.code, row.sha256, row.preferences);
    db.saveDefaultNavigation(value.navigation ?? null);
  });
}
function sharedValue() { return { repositories: db.all('SELECT * FROM source_repositories WHERE active=1'), sources: db.all('SELECT * FROM source_entries WHERE code IS NOT NULL'), backups: db.all('SELECT * FROM source_backups'), navigation: db.defaultNavigation() }; }
async function withMetadata<T extends { items: { id: string }[] }>(page: T, pid: string): Promise<T> {
  const ids = page.items.map(card => card.id).filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
  if (!tmdb.enabled || !ids.length) return page;
  await tmdb.ensure(ids, 1500);
  return { ...page, items: page.items.map(card => {
    const row = db.get('SELECT * FROM media WHERE id=?', card.id);
    return row ? { ...catalog.card(row, pid), ...('sourceCount' in card ? { sourceCount: card.sourceCount } : {}) } : card;
  }) };
}
const profileView = (r: any) => ({ id: r.id, name: r.name, color: r.color, kids: !!r.kids, createdAt: r.created_at, avatar: r.avatar });
function validateProfile(body: any, required = false) {
  if (!body || Object.keys(body).some(key => !['name', 'color', 'kids', 'avatar'].includes(key)) || required && body.name === undefined || body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) || body.color !== undefined && !['red', 'blue', 'green', 'amber', 'violet', 'teal'].includes(body.color) || body.kids !== undefined && typeof body.kids !== 'boolean' || body.avatar !== undefined && body.avatar !== null && (typeof body.avatar !== 'string' || body.avatar.length > 64 || !/^[a-z]+-[0-9]{1,2}$/.test(body.avatar))) throw new ApiFailure(400, 'invalid-profile');
}
function profile(id: string | null) { if (!id || !db.get('SELECT 1 FROM profiles WHERE id=? AND account_id=?', id, actor.id)) throw new ApiFailure(401, 'profile-required'); return id; }
function admin() { if (actor.role !== 'admin') throw new ApiFailure(403, 'admin-required'); }
function episode(id: string) { const row = db.get('SELECT e.*,m.title AS original_title,m.type FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?', id); if (!row) throw new ApiFailure(404, 'episode-not-found'); return row; }
function normalizedSubtitle(content: string, format: string) { return host('api', { path: '/lite/convert', body: { content, format } }); }
function track(content: string, format: 'ass' | 'vtt', extra: any): any { return { ...extra, format, __content: content }; }
function jobView(record: any) {
  const doc = subtitleDocument(record.content, record.format);
  return { id: record.id, episodeId: record.episode, state: record.state, revision: record.revision, partial: record.state !== 'completed', done: Object.keys(record.output).length, total: doc.lines.length, model: record.model, cached: !!record.cached, error: record.error, translatedRanges: translatedRanges(doc.lines, record.output),
    ...(Object.keys(record.output).length ? { track: track(doc.render(record.output, record.state !== 'completed'), doc.format, { id: record.id, label: '한국어 · AI 번역', lang: 'ko', source: 'translation', default: true }) } : {}) };
}
function getJob(id: string, pid: string) { const row = db.get('SELECT payload FROM lite_jobs WHERE id=? AND profile=?', id, pid); if (!row) throw new ApiFailure(404, 'translation-job-not-found'); return JSON.parse(row.payload); }
function saveJob(job: any) { db.run('INSERT OR REPLACE INTO lite_jobs VALUES(?,?,?,?)', job.id, job.profile, job.episode, JSON.stringify(job)); }
async function startJob(id: string, pid: string, body: any) {
  episode(id);
  if (!config.translation.configured) throw new ApiFailure(400, 'translation-not-configured');
  if (!config.translation.enabled) throw new ApiFailure(409, 'translation-disabled');
  const value = await normalizedSubtitle(body.content, body.format), doc = subtitleDocument(value.content, value.format);
  if (!doc.lines.length) throw new ApiFailure(400, 'translation-invalid-subtitle');
  const digest = hash(value.content + config.translation.model);
  const old = db.all('SELECT payload FROM lite_jobs WHERE episode=? AND profile=?', id, pid).map(r => JSON.parse(r.payload)).find(r => r.digest === digest);
  if (old?.state === 'completed') { old.cached = true; return jobView(old); }
  const job = { id: old?.id ?? randomUUID(), episode: id, profile: pid, content: value.content, format: value.format, digest, model: config.translation.model, state: 'queued', output: old?.output ?? {}, startAt: body.startAt ?? 0, sourceLanguage: body.sourceLanguage ?? '', revision: (old?.revision ?? 0) + 1, attempts: 0 };
  saveJob(job); return jobView(job);
}
async function playback(pid: string, body: any): Promise<PlaybackSession> {
  const ep = episode(body.episodeId); catalog.kids.assert(ep.media_id, pid);
  const videos = await sources.videos(body.episodeId).catch(error => {
    if (error?.message === 'source_browser_unavailable' || error?.statusCode < 500) throw error;
    throw new ApiFailure(502, 'source-video-extraction-failed');
  });
  const { item, streamId, streams } = selectPlaybackStream(videos, body.streamId);
  const detail = catalog.detail(ep.media_id, pid), list = detail.seasons.flatMap(s => s.episodes), next = list[list.findIndex(e => e.id === ep.id) + 1];
  const live = !!sources.row(sources.remoteEpisode(ep.id)!.source_id).live;
  const subtitles: any[] = [];
  for (const [i, sub] of (item.subtitles ?? []).entries()) {
    if (i >= 32 || /\.m3u8(?:\?|$)/i.test(sub.file)) continue;
    try {
      let converted;
      if (!/^https:\/\//i.test(sub.file)) {
        if (new TextEncoder().encode(sub.file).length > 1024 * 1024) continue;
        converted = inlineSubtitle(sub.file);
      } else {
        const content = (await compatibilityHttp({ url: sub.file, headers: item.headers ?? {} }, AbortSignal.timeout(15000), [], 1024 * 1024)).bytes.toString('utf8');
        const format = /\.(ass|ssa)(?:\?|$)/i.test(sub.file) ? 'ass' : /\.smi(?:\?|$)/i.test(sub.file) ? 'smi' : 'vtt';
        converted = format === 'vtt' ? {content:subtitleVtt(content),format:'vtt'} : await normalizedSubtitle(content, format);
      }
      subtitles.push(track(converted.content, converted.format, { id: `extension-${i}`, label: sub.label || `자막 ${i + 1}`, source: 'extension', lang: /한국|korean|\bko\b/i.test(sub.label ?? '') ? 'ko' : undefined }));
    } catch { /* A failing optional subtitle must not prevent playback. */ }
  }
  for (const row of db.all('SELECT * FROM online_subtitles WHERE episode_id=?', ep.id)) subtitles.push(track(row.content, row.format, { id: row.id, label: row.creator_name + ' · 한국어', lang: 'ko', source: 'online', provenance: { creatorName: row.creator_name, sourceUrl: row.source_url } }));
  for (const row of db.all('SELECT payload FROM lite_jobs WHERE episode=? AND profile=?', ep.id, pid)) { const view = jobView(JSON.parse(row.payload)); if (view.track) subtitles.push(view.track); }
  const session: PlaybackSession = { sessionId: randomUUID(), episodeId: ep.id, mediaId: detail.id, mediaTitle: detail.title, mediaType: playbackMediaType(db, detail.id, detail.type), episodeTitle: ep.title, episodeLabel: `S${ep.season}:E${ep.number}`, mode: 'direct', url: item.url, mime: remoteMediaType(item.url), headers: item.headers ?? {}, transport: 'direct', live, duration: ep.duration || 0, streams, streamId, startPosition: live ? 0 : body.startPosition ?? (list.find(e => e.id === ep.id)?.progress?.completed ? 0 : list.find(e => e.id === ep.id)?.progress?.position ?? 0), subtitles, audioTracks: [], next: !live && next ? { episodeId: next.id, title: detail.title, label: next.title, thumb: next.thumb } : null };
  sessions.set(session.sessionId, session); return session;
}
async function dispatch(path: string, method: string, body: any, pid: string | null): Promise<any> {
  const url = new URL(path, 'https://moa-lite.invalid'), p = url.pathname, q = Object.fromEntries(url.searchParams);
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent), id = parts[1];
  if (p === '/profiles') {
    if (method === 'POST') {
      validateProfile(body, true);
      const count = db.get('SELECT COUNT(*) AS n FROM profiles')!.n; if (count >= 5) throw new ApiFailure(409, 'profile-limit');
      const uuid = randomUUID(); db.run('INSERT INTO profiles VALUES(?,?,?,?,?,?,?)', uuid, body.name.trim(), body.color ?? ['red','blue','green','amber','violet'][count], +!!body.kids, now(), actor.id, body.avatar ?? null);
      const nav = db.defaultNavigation(); if (nav) db.run('INSERT INTO settings VALUES(?,?)', uuid, JSON.stringify({ navigation: db.availableNavigation(nav) }));
      return profileView(db.get('SELECT * FROM profiles WHERE id=?', uuid));
    }
    return db.all('SELECT * FROM profiles WHERE account_id=? ORDER BY created_at,id', actor.id).map(profileView);
  }
  if (parts[0] === 'profiles' && id) {
    const old = db.get('SELECT * FROM profiles WHERE id=? AND account_id=?', id, actor.id); if (!old) throw new ApiFailure(404, 'profile-not-found');
    if (method === 'DELETE') { db.run('DELETE FROM lite_jobs WHERE profile=?', id); db.run('DELETE FROM profiles WHERE id=?', id); return; }
    if (method === 'PATCH') { validateProfile(body); db.run('UPDATE profiles SET name=?,color=?,kids=?,avatar=? WHERE id=?', body.name?.trim() ?? old.name, body.color ?? old.color, body.kids === undefined ? old.kids : +!!body.kids, body.avatar === undefined ? old.avatar : body.avatar, id); return profileView(db.get('SELECT * FROM profiles WHERE id=?', id)); }
  }
  if (p === '/source-repositories') { if (method === 'DELETE') { admin(); return sources.removeRepository(body.url); } return sources.repositories(); }
  if (p === '/sources') return sources.list();
  if (p === '/sources/refresh') { admin(); if (body.kind && body.kind !== 'mangayomi-js') throw new ApiFailure(400, 'compatibility_feature_unsupported'); return sources.refresh(body.url, 'mangayomi-js'); }
  if (p === '/sources/remove' || parts[0] === 'sources' && method === 'DELETE') { admin(); return sources.remove(body.ids ?? [id]); }
  if (p === '/admin/cache-stats') { admin(); return sources.stats.snapshot(); }
  if (p === '/network') return { defaultProxy: '', revision: 0 };
  if (p === '/admin/default-navigation' && method === 'GET') { admin(); return { navigation: db.defaultNavigation() }; }
  const prof = profile(pid);
  if (parts[0] === 'sources' && id) {
    const action = parts[2];
    if (action === 'browse') return withMetadata(await sources.browse(id, prof, body.mode ?? q.mode ?? 'popular', body.page ?? Number(q.page ?? 1), body.q ?? q.q ?? '', body.selection), prof);
    if (action === 'filters') return sources.capabilities(id);
    if (action === 'preferences') { if (method === 'PATCH') admin(); return sources.preferences(id, method === 'PATCH' ? body : undefined); }
    admin();
    if (action === 'install') return sources.install(id);
    if (action === 'rollback') return sources.rollback(id);
    if (action === 'check') return sources.diagnose(id, prof);
    if (action === 'removal-impact') return sources.removalImpact([id]);
    if (method === 'PATCH') return sources.configure(id, body);
  }
  if (p === '/admin/default-navigation') { admin(); const nav = body.fromProfile ? db.settings(prof).navigation ?? null : body.navigation; db.saveDefaultNavigation(nav); return { navigation: nav }; }
  if (p === '/settings') { if (method === 'PATCH') db.run('INSERT OR REPLACE INTO settings VALUES(?,?)', prof, JSON.stringify({ ...db.settings(prof), ...body, hardwareTranscoding: false })); return { ...db.settings(prof), hardwareTranscoding: false }; }
  if (p === '/home') {
    const read = () => catalog.home(prof, q.type as any, q.providers?.split(','), q.continueScope as any);
    let home = read();
    const ids = home.rows.flatMap(row => row.items.map(card => card.id)).filter(id => !db.get('SELECT 1 FROM tmdb_links WHERE media_id=?', id));
    if (tmdb.enabled && ids.length) { await tmdb.ensure([...new Set(ids)], 1500); home = read(); }
    return { ...home, rows: home.rows.map(r => r.kind === 'watchlist' && q.titleGrouping !== 'false' ? { ...r, items: groups.resolve(r.items.map(c => c.id), prof) } : r) };
  }
  if (p === '/media') { let cards = catalog.cards(prof, q.type as any); if (q.provider) cards = cards.filter(c => c.provider.id === q.provider); if (q.genre) cards = cards.filter(c => c.genres?.includes(q.genre)); if (q.sort === 'title') cards.sort((a,b) => a.title.localeCompare(b.title,'ko')); if (q.sort === 'year') cards.sort((a,b) => (b.year ?? 0) - (a.year ?? 0)); return catalog.page(cards, Number(q.page ?? 1)); }
  if (p === '/media/groups/resolve') return groups.resolve(body.ids, prof, body.query);
  if (p === '/media/groups/candidates') return groups.candidates(q.q ?? '', prof);
  if (parts[0] === 'media' && id) {
    if (parts[2] === 'group') return method === 'PATCH' ? groups.change(id, prof, body.action, body.otherId) : groups.group(id, prof);
    if (parts[2] === 'franchise') {
      let result = franchises.get(id, prof);
      const until = Date.now() + 13000;
      while (!result.complete && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 50)); result = franchises.get(id, prof); }
      return result;
    }
    if (parts[2] === 'metadata') return parts[3] === 'search' ? catalog.kids.candidates(await tmdb.search(q.q), prof) : tmdb.change(id, body);
    catalog.kids.assert(id, prof); await sources.detail(id); await tmdb.ensureDetail(id, 5000); return catalog.detail(id, prof);
  }
  if (p === '/metadata/status') return { tmdb: tmdb.enabled };
  if (p === '/genres') return [...new Set(catalog.cards(prof, q.type as any).flatMap(c => c.genres ?? []))].sort();
  if (p === '/search') return catalog.search(prof, q.q ?? '');
  if (p === '/watchlist') return groups.resolve(catalog.watchlist(prof).map(c => c.id), prof);
  if (parts[0] === 'watchlist') { catalog.kids.assert(id, prof); if (method === 'PUT') db.run('INSERT OR IGNORE INTO watchlist VALUES(?,?,?)', prof, id, now()); else db.run('DELETE FROM watchlist WHERE profile_id=? AND media_id=?', prof, id); return; }
  if (p === '/history') return catalog.history(prof, Number(q.page ?? 1));
  if (parts[0] === 'history') { db.run('DELETE FROM progress WHERE profile_id=? AND episode_id=?', prof, id); return; }
  if (p === '/progress') {
    episode(body.episodeId); if (!Number.isFinite(body.position) || body.position < 0 || !Number.isFinite(body.duration) || body.duration <= 0) throw new ApiFailure(400, 'invalid-progress');
    const position = Math.min(body.position, body.duration);
    db.run('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)', prof, body.episodeId, position, body.duration, +completion(position, body.duration), now()); return episodeProgress(db.get('SELECT * FROM progress WHERE profile_id=? AND episode_id=?', prof, body.episodeId)!);
  }
  if (p === '/playback') return playback(prof, body);
  if (parts[0] === 'playback') { if (method === 'DELETE') sessions.delete(id); return; }
  if (parts[0] === 'episodes') {
    const ep = episode(id); catalog.kids.assert(ep.media_id, prof);
    if (parts[2] === 'context') return { mediaId: ep.media_id, season: ep.season, number: ep.number };
    if (parts[2] === 'markers') {
      const duration = Number(q.duration) || ep.duration;
      if (playbackMediaType(db, ep.media_id, ep.type) !== 'anime' || duration <= 0) return { markers: null };
      const query = subtitleQuery(db, ep);
      const api = new AniSkipClient({ cache: {
        get: async (key: string) => { const row = db.get('SELECT * FROM enrichment_cache WHERE key=?', key); return row ? { value: JSON.parse(row.payload), expiresAt: row.expires_at } : undefined; },
        set: async (key: string, entry: any) => { db.run('INSERT OR REPLACE INTO enrichment_cache VALUES(?,?,?)', key, JSON.stringify(entry.value), entry.expiresAt); }
      }, fetch: async (url: any, init?: RequestInit) => {
        const wire = await compatibilityHttp({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body }, init?.signal ?? AbortSignal.timeout(8000));
        return new Response(wire.bytes.toString('utf8'), { status: wire.statusCode, headers: { 'Content-Type': wire.contentType } });
      } });
      try { return { markers: (await api.lookup({ title: query.title, aliases: query.aliases.slice(0, 3), season: query.season, episodeNumber: query.episode, episodeLength: duration })).markers }; }
      catch { return { markers: null }; }
    }
    if (parts[2] === 'subtitles') {
      if (parts[3] === 'translate') return startJob(id, prof, body);
      if (parts[3] === 'translations') return db.all('SELECT payload FROM lite_jobs WHERE episode=? AND profile=?', id, prof).map(r => jobView(JSON.parse(r.payload)).track).filter(Boolean);
      const override = { ...q, ...(q.season !== undefined ? { season: Number(q.season) } : {}), ...(q.episode !== undefined ? { episode: Number(q.episode) } : {}), ...(q.episodeOffset !== undefined ? { episodeOffset: Number(q.episodeOffset) } : {}) };
      const query = subtitleQuery(db, ep, override as any);
      if (parts[3] === 'jimaku') {
        if (parts[4] === 'translate') { const value = await host('api', { path: '/lite/jimaku/file', body }); return startJob(id, prof, { ...value, startAt: body.startAt }); }
        return host('api', { path: '/lite/jimaku', body: { ...query, type: ep.type } });
      }
      if (parts[3] === 'online') {
        if (method === 'POST') {
          const row = db.get('SELECT * FROM lite_searches WHERE id=? AND profile=? AND episode=? AND expires>?', body.searchId, prof, id, Date.now());
          const c = row && JSON.parse(row.payload).find((c: any) => c.id === body.candidateId); if (!c) throw new ApiFailure(409, 'subtitle-search-expired');
          const uuid = randomUUID(); db.run('INSERT OR IGNORE INTO online_subtitles VALUES(?,?,?,?,?,?,?,?,?)', uuid, id, c.creatorName, c.sourceUrl, c.format, c.content, hash(c.content), randomUUID(), Date.now());
          return track(c.content, c.format, { id: uuid, label: c.creatorName + ' · 한국어', lang: 'ko', source: 'online', default: true });
        }
        const candidates = await host('api', { path: '/lite/subtitles', body: query }), searchId = randomUUID(), expiresAt = Date.now() + 300000;
        db.run('INSERT INTO lite_searches VALUES(?,?,?,?,?)', searchId, prof, id, JSON.stringify(candidates), expiresAt);
        return { searchId, expiresAt, query, resolvedTitle: query.title, partial: false, autoApply: !query.warnings.length, candidates: candidates.map(({ content: _content, ...c }: any) => c) };
      }
      if (method === 'DELETE') { db.run('DELETE FROM online_subtitles WHERE id=? AND episode_id=?', parts[3], id); return; }
    }
  }
  if (parts[0] === 'translations') { const job = getJob(id, prof); if (method === 'DELETE') job.state = 'cancelled'; if (parts[2] === 'priority') job.startAt = body.startAt; if (method !== 'GET') { job.revision++; saveJob(job); return; } return jobView(job); }
  if (p === '/lite/job/next') {
    const job = getJob(body.id, prof); if (['cancelled','failed','completed'].includes(job.state)) return null;
    const doc = subtitleDocument(job.content, job.format), batch = nextBatch(doc.lines, job.output, job.startAt, config.translation.batchSize);
    if (!batch.length) { job.startAt = 0; }
    const lines = batch.length ? batch : nextBatch(doc.lines, job.output, 0, config.translation.batchSize);
    if (!lines.length) { job.state = 'completed'; saveJob(job); return null; }
    job.state = 'running'; job.revision++; saveJob(job);
    return { lines, context: { title: episode(job.episode).original_title, sourceLanguage: job.sourceLanguage }, interval: config.translation.requestIntervalMs, retryCount: config.translation.retryCount };
  }
  if (p === '/lite/job/commit') {
    const job = getJob(body.id, prof); if (job.state === 'cancelled') return null;
    if (body.error) { job.error = body.error; job.state = 'failed'; }
    else { Object.assign(job.output, body.output); job.state = Object.keys(job.output).length >= subtitleDocument(job.content, job.format).lines.length ? 'completed' : 'running'; }
    job.revision++; saveJob(job); return jobView(job);
  }
  throw new ApiFailure(404, 'not-found');
}
function decorate(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decorate);
  const output: any = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' && field.startsWith('/api/images/')) {
      const image = db.get('SELECT * FROM source_images WHERE id=?', field.split('/').pop()!);
      output[key] = image ? { __image: { url: image.url, headers: JSON.parse(image.headers) } } : undefined;
    } else output[key] = decorate(field);
  }
  return output;
}
let queue: Promise<void> = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === 'host-reply') { hostReply(data); return; }
  if (data.type !== 'request') return;
  queue = queue.catch(() => {}).then(async () => {
    try {
      inRequest = true;
      await initialize(data.state, data.actor, data.config);
      if (data.cloudShared && data.cloudShared.revision !== shared.revision) { applyShared(data.cloudShared.value); shared = data.cloudShared; sharedBaseline = JSON.stringify(sharedValue()); }
      if (data.cloudSync) { applyRows(data.cloudSync.rows); syncState.revision = data.cloudSync.revision; }
      const before = actor.role === 'admin' ? sharedBaseline : '';
      const result = ['/lite/sync-state','/lite/checkpoint'].includes(data.path) ? null : await dispatch(data.path, data.method ?? 'GET', data.body ?? {}, data.profile);
      collectChanges();
      const value = actor.role === 'admin' ? sharedValue() : shared.value;
      if (actor.role === 'admin' && JSON.stringify(value) !== before) shared.pending = value;
      sharedBaseline = JSON.stringify(value);
      published = database.export(); stamp = randomUUID();
      const resume = db.all('SELECT payload FROM lite_jobs WHERE profile=?', data.profile).map(r => JSON.parse(r.payload)).filter(r => ['queued', 'running'].includes(r.state)).map(r => r.id);
      postMessage({ type: 'result', id: data.id, value: decorate(result), resume, state: { bytes: published, stamp, sync: syncState, shared }, syncRequest: { since: syncState.revision, changes: Object.values(syncState.pending).slice(0, 100) } });
    } catch (error: any) { postMessage({ type: 'failure', id: data.id, error: { status: error.statusCode ?? 502, code: error.error ?? error.message ?? 'execution_failed' } }); }
    finally { inRequest = false; }
  });
};
