import { parseSeasonInfo } from './season-info.js';
import { parseSeason } from '@moa/subtitles-ko';
import type { MediaCard, MediaDetail, MetadataCandidate, MetadataKind, MetadataLink, Person } from '@moa/shared';
import { selectCertification } from './kids.js';
import { Store } from './db.js';
import { ApiFailure } from './util.js';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 86_400_000;
const TITLE_TTL = 7 * DAY, MISS_TTL = 3 * DAY;
const ACCEPT = 80;
export const MATCH_VERSION = 2;

// TMDB leaves the combined TV genres untranslated in Korean.
const GENRES: Record<number, string> = { 10759: '액션·모험', 10765: 'SF·판타지', 10768: '전쟁·정치', 10762: '키즈', 10763: '뉴스', 10764: '리얼리티', 10766: '연속극', 10767: '토크' };
const img = (size: string, file?: string | null) => file ? IMG + size + file : undefined;
const yearOf = (date?: string | null) => date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const tmdbNorm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Small, card-sized metadata merged into every card of a linked title. */
interface CardInfo {
  status?: string; lastAirDate?: string;
  title: string; originalTitle?: string; poster?: string; backdrop?: string; logo?: string; year?: number; genres?: string[];
  adult?: boolean; genreIds?: number[]; rating?: number; certification?: string; overview?: string; animation: boolean; originCountries?: string[]; runtime?: number;
  seasons?: Record<string, { poster?: string; year?: number; episodes?: number }>;
}
interface DetailInfo { tagline?: string; people: Person[]; trailer?: string; similar: MetadataCandidate[] }
interface EpisodeInfo { number: number; name?: string; overview?: string; still?: string; airDate?: string; runtime?: number }
interface Target { text: string; season?: number }

function dice(a: string, b: string) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2), n = grams.get(g) || 0; if (n) { hits++; grams.set(g, n - 1); } }
  return 2 * hits / (a.length + b.length - 2);
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.includes(short) && short.length / long.length >= 0.7) return 0.9;
  return dice(a, b) * 0.95;
}

/** Search queries for a source title: tags, seasons and trailing numbers are tried without and with. */
export function searchTerms(raw: string) {
  let text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const movieHint = /극장판|劇場版|the movie/i.test(text);
  const year = Number(/[([]\s*((?:19|20)\d{2})\s*[)\]]/.exec(text)?.[1]) || undefined;
  text = text.replace(/[([]\s*(?:자막|더빙|한글\s*자막|자체\s*자막|무삭제|무자막|완결|극장판|4K|UHD|FHD|HD|(?:19|20)\d{2})\s*[)\]]/gi, ' ')
    .replace(/\b(?:4K|UHD|FHD)\b/gi, ' ').replace(/\s*전\s*시즌(?:\s*이어보기)?\s*$/, ' ').replace(/\s+/g, ' ').trim();
  const season = parseSeason(text);
  const base = text.replace(/(?:final\s+season)|(?:시즌|season)\s*\d{1,2}|\d{1,2}\s*기|\d{1,2}(?:st|nd|rd|th)\s+season|\s(?:part|파트)\s*\d+|\s\d{1,2}\s*(?:부|쿨)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim() || text;
  const targets: Target[] = [{ text: base, season }];
  if (base !== text) targets.push({ text });
  const numbered = !season && /^(.{2,}?)\s?(\d{1,2})$/.exec(text);
  if (numbered && Number(numbered[2]) > 1) targets.push({ text: numbered[1].trim(), season: Number(numbered[2]) });
  const subtitle = base.replace(/\s*[~〜].*$/, '').trim();
  if (subtitle.length >= 2 && subtitle !== base) targets.push({ text: subtitle, season });
  // "더 픽스 The Fix": Korean title followed by its English name.
  const korean = /\p{Script=Hangul}/u.test(base) ? base.replace(/\s+[A-Za-z][A-Za-z0-9 :'&!?.,-]*$/, '').trim() : base;
  if (korean.length >= 2 && korean !== base) targets.push({ text: korean, season });
  const unique = targets.filter((t, i) => targets.findIndex(o => o.text === t.text) === i);
  if (movieHint) unique.sort((a, b) => Number(b.text === text) - Number(a.text === text));
  return { targets: unique, season, year, movieHint };
}

interface SearchResult { media_type?: string; id: number; name?: string; title?: string; original_name?: string; original_title?: string; first_air_date?: string; release_date?: string; genre_ids?: number[]; popularity?: number; poster_path?: string; overview?: string }

export function scoreResult(result: SearchResult, targets: Target[], expected: { type: string; movieHint: boolean; year?: number }) {
  const kind = result.media_type === 'movie' ? 'movie' : 'tv';
  const names = [result.name || result.title, result.original_name || result.original_title].filter(Boolean).map(n => tmdbNorm(n!));
  let best = 0, target: Target | undefined;
  for (const t of targets) for (const n of names) {
    const s = similarity(tmdbNorm(t.text), n);
    if (s > best) { best = s; target = t; }
  }
  if (!target) return { score: 0, season: undefined };
  let score = best * 100;
  const wantMovie = expected.type === 'movie' || expected.movieHint;
  score += (kind === 'movie') === wantMovie ? 5 : -12;
  const animated = result.genre_ids?.includes(16);
  if (expected.type === 'anime') score += animated ? 5 : -30;
  const year = yearOf(result.first_air_date || result.release_date);
  if (expected.year && year && (target.season ?? 1) <= 1 && Math.abs(expected.year - year) > 1) score -= 30;
  return { score, season: target.season };
}

/** Keeps a small number of TMDB requests in flight and retries rate limits. */
export class Tmdb {
  get enabled() { return Boolean(this.token || this.key); }
  private environment: { token?: string; key?: string } = {};
  private reload() {
    const saved = JSON.parse(this.db.get("SELECT value FROM admin_settings WHERE key='tmdb'")?.value || '{}');
    const effective = this.environment.token || this.environment.key ? this.environment : saved;
    this.token = effective.token || undefined; this.key = effective.apiKey || effective.key || undefined;
  }
  status() {
    const saved = JSON.parse(this.db.get("SELECT value FROM admin_settings WHERE key='tmdb'")?.value || '{}');
    return { configured: this.enabled, source: this.environment.token || this.environment.key ? 'environment' : this.enabled ? 'database' : 'none',
      credentialType: this.token ? 'token' : this.key ? 'apiKey' : null, hasSavedCredential: Boolean(saved.token || saved.apiKey) };
  }
  configure(value: { token?: string; apiKey?: string; clear?: boolean }) {
    if (Object.keys(value).length !== 1 || value.clear !== undefined && value.clear !== true) throw new ApiFailure(400, 'invalid-request');
    this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('tmdb',?)", JSON.stringify(value.clear ? {} : value));
    this.reload();
    return this.status();
  }
  private token?: string;
  private key?: string;
  private active = 0;
  private waiting: Array<() => void> = [];
  private inflight = new Map<string, Promise<void>>();
  private refreshing = new Set<string>();
  private seasonRequests = new Map<string, Promise<void>>();
  private abort = new AbortController();
  constructor(private db: Store, private log: (value: Record<string, unknown>) => void, options: { token?: string; key?: string; fetch?: typeof fetch } = { token: process.env.MOA_TMDB_TOKEN, key: process.env.MOA_TMDB_API_KEY }) {
    this.environment = { token: options.token?.trim() || undefined, key: options.key?.trim() || undefined };
    this.reload();
    if (options.fetch) this.fetcher = options.fetch;
  }
  private fetcher: typeof fetch = (input, init) => fetch(input, init);
  private async slot() {
    if (this.active >= 6) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
  }
  private release() { this.active--; this.waiting.shift()?.(); }
  private async get(pathname: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!this.token && this.key) url.searchParams.set('api_key', this.key);
    await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await this.fetcher(url, { headers: { accept: 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, signal: AbortSignal.any([AbortSignal.timeout(8000), this.abort.signal]) });
        if (res.status === 429 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`tmdb-${res.status}`);
        return await res.json();
      }
    } finally { this.release(); }
  }

  /** Link titles in the background; resolves when done or after the budget, whichever is first. */
  ensure(ids: string[], budgetMs: number): Promise<void> {
    if (!this.enabled || !ids.length) return Promise.resolve();
    const work = Promise.allSettled([...new Set(ids)].map(async id => {
      await this.link(id);
      const row = linked(this.db,id);
      if (row?.kind === 'tv' && row.season != null && !JSON.parse(row.card).seasons?.[row.season]?.poster) await this.season(row.tmdb_id,row.season);
    })).then(() => {});
    return budgetMs > 0 ? Promise.race([work, sleep(budgetMs)]) : Promise.resolve();
  }
  /** Detail pages also need the episode lists of the linked seasons. */
  async ensureDetail(id: string, budgetMs: number) {
    if (!this.enabled) return;
    const work = (async () => {
      await this.link(id);
      const link = this.db.get("SELECT * FROM tmdb_links WHERE media_id=? AND status IN ('auto','manual') AND kind='tv'", id);
      if (!link) return;
      const remote = Boolean(this.db.get('SELECT 1 FROM source_media WHERE media_id=?', id));
      const seasons = remote && link.season != null ? [link.season] : this.db.all('SELECT DISTINCT season FROM episodes WHERE media_id=?', id).map(r => r.season as number);
      await Promise.allSettled([...new Set(seasons.length ? seasons : [1])].slice(0, 6).map(n => this.season(link.tmdb_id, n)));
    })().catch(error => this.log({ event: 'tmdb-detail-error', id, error: String(error) }));
    await Promise.race([work, sleep(budgetMs)]);
  }
  private link(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const row = this.db.get('SELECT * FROM tmdb_links WHERE media_id=?', id);
    const retry = row && foreignSource(this.db, id).foreign && (row.status === 'none' || row.status === 'auto' && row.score < 100) && (this.db.get('SELECT version FROM tmdb_match_versions WHERE media_id=?', id)?.version || 0) < MATCH_VERSION;
    if (!retry && (row?.status === 'off' || row?.status === 'none' && row.checked_at > Date.now() - MISS_TTL)) return Promise.resolve();
    if (!retry && row && ['auto', 'manual'].includes(row.status)) {
      const title = this.db.get('SELECT fetched_at FROM tmdb_titles WHERE kind=? AND tmdb_id=?', row.kind, row.tmdb_id);
      if (title && title.fetched_at > Date.now() - TITLE_TTL) return Promise.resolve();
      if (title) { void this.title(row.kind, row.tmdb_id).catch(() => {}); return Promise.resolve(); }
    }
    const work = (!retry && row && ['auto', 'manual'].includes(row.status) ? this.title(row.kind, row.tmdb_id).then(() => {}) : this.match(id))
      .catch(error => this.log({ event: 'tmdb-match-error', id, error: String(error) }))
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return work;
  }
  private async match(id: string) {
    const previous = JSON.stringify(this.db.get('SELECT * FROM tmdb_links WHERE media_id=?',id));
    const unchanged = () => Boolean(this.db.get('SELECT 1 FROM media WHERE id=?', id)) && previous === JSON.stringify(this.db.get('SELECT * FROM tmdb_links WHERE media_id=?',id));
    const media = this.db.get('SELECT title,type,metadata FROM media WHERE id=?', id);
    if (!media) return;
    const meta = JSON.parse(media.metadata);
    // Live channels and truncated listing titles cannot be matched reliably.
    if (meta.live || /(?:\.{3}|…)\s*$/.test(media.title)) return;
    const terms = searchTerms(media.title);
    const source = foreignSource(this.db, id);
    const letters = media.title.match(/\p{L}/gu) || [];
    const english = source.foreign || letters.filter((c: string) => /\p{Script=Latin}/u.test(c)).length > letters.length / 2;
    const expected = { type: source.anime && media.type === 'series' ? 'anime' : media.type, movieHint: terms.movieHint, year: meta.year || terms.year };
    let best: { result: SearchResult; score: number; season?: number } | undefined;
    for (const target of terms.targets.slice(0, 4)) {
      for (const language of english ? ['ko-KR', 'en-US'] : ['ko-KR']) {
        const page = await this.get('/search/multi', { query: target.text, language, include_adult: 'false' });
        for (const result of (page?.results || []) as SearchResult[]) {
          if (!['tv', 'movie'].includes(result.media_type || '')) continue;
          const { score, season } = scoreResult(result, terms.targets, expected);
          if (!best || score > best.score + 2 || Math.abs(score - best.score) <= 2 && (result.popularity || 0) > (best.result.popularity || 0)) best = { result, score, season };
        }
      }
      if (best && best.score >= 95) break;
    }
    if (!unchanged()) return;
    if (!best || best.score < ACCEPT) {
      this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,status,checked_at) VALUES(?,'none',?)", id, Date.now());
      this.db.run('INSERT OR REPLACE INTO tmdb_match_versions VALUES(?,?)', id, MATCH_VERSION);
      return;
    }
    const kind = best.result.media_type as MetadataKind, info = await this.title(kind, best.result.id);
    if (!info || !unchanged()) return;
    const wanted = best.season ?? (/\bfinal\s+season\b/i.test(media.title) ? Math.max(0, ...Object.keys(info.seasons || {}).map(Number)) : undefined);
    const season = kind === 'tv' && wanted && info.seasons?.[wanted] ? wanted : null;
    this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,kind,tmdb_id,season,status,score,checked_at) VALUES(?,?,?,?,'auto',?,?)", id, kind, best.result.id, season, Math.round(best.score), Date.now());
    this.db.run('INSERT OR REPLACE INTO tmdb_match_versions VALUES(?,?)', id, MATCH_VERSION);
  }
  private async title(kind: MetadataKind, tmdbId: number): Promise<CardInfo | null> {
    const append = kind === 'tv' ? 'aggregate_credits,images,videos,recommendations,content_ratings' : 'credits,images,videos,recommendations,release_dates';
    const d = await this.get(`/${kind}/${tmdbId}`, { language: 'ko-KR', append_to_response: append, include_image_language: 'ko,en,null', include_video_language: 'ko,en' });
    if (!d) return null;
    const logos: any[] = d.images?.logos || [];
    const pickLogo = (lang: string) => logos.filter(l => l.iso_639_1 === lang).sort((a, b) => b.vote_average - a.vote_average)[0];
    // A Korean logo, or the English one for English-language titles. Others keep the text title.
    const logo = pickLogo('ko') || (d.original_language === 'en' ? pickLogo('en') : undefined);
    const backdrop = (d.images?.backdrops || []).filter((b: any) => !b.iso_639_1).sort((a: any, b: any) => b.vote_average - a.vote_average)[0]?.file_path || d.backdrop_path;
    const certification = selectCertification(kind, d);
    const seasons: CardInfo['seasons'] = {};
    for (const s of d.seasons || []) if (s.season_number > 0) seasons[s.season_number] = { poster: img('w500', s.poster_path), year: yearOf(s.air_date), episodes: s.episode_count };
    const card: CardInfo = {
      ...(kind === 'tv' ? { status: d.status, lastAirDate: d.last_air_date } : {}),
      adult: Boolean(d.adult), genreIds: (d.genres || []).map((g: any) => g.id),
      title: d.name || d.title, originalTitle: d.original_name || d.original_title, poster: img('w500', d.poster_path), backdrop: img('w1280', backdrop),
      logo: logo ? img(logo.file_path.endsWith('.svg') ? 'original' : 'w500', logo.file_path) : undefined,
      year: yearOf(d.first_air_date || d.release_date), genres: (d.genres || []).map((g: any) => GENRES[g.id] || g.name).filter(Boolean).slice(0, 5),
      rating: d.vote_count >= 5 && d.vote_average ? Math.round(d.vote_average * 10) / 10 : undefined,
      certification: certification ? String(certification).replace(/^all$/i, 'ALL') : undefined,
      originCountries: d.origin_country || (d.production_countries || []).map((c: any) => c.iso_3166_1),
      overview: d.overview || undefined, animation: (d.genres || []).some((g: any) => g.id === 16),
      runtime: d.runtime || undefined, ...(kind === 'tv' ? { seasons } : {}),
    };
    const cast: any[] = (kind === 'tv' ? d.aggregate_credits?.cast : d.credits?.cast) || [];
    const videos: any[] = (d.videos?.results || []).filter((v: any) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type));
    videos.sort((a, b) => Number(b.iso_639_1 === 'ko') - Number(a.iso_639_1 === 'ko') || Number(b.type === 'Trailer') - Number(a.type === 'Trailer') || Number(b.official) - Number(a.official));
    const detail: DetailInfo = {
      tagline: d.tagline || undefined, trailer: videos[0]?.key,
      people: cast.slice(0, 16).map(p => ({ name: p.name, role: (p.roles?.[0]?.character || p.character || '').replace(/\s*\((?:voice|목소리)\)\s*$/i, '') || undefined, photo: img('w185', p.profile_path) })),
      similar: (d.recommendations?.results || []).filter((r: any) => r.poster_path).slice(0, 18).map((r: any) => candidate(r, kind)),
    };
    this.db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,?,?)', kind, tmdbId, JSON.stringify(card), JSON.stringify(detail), Date.now());
    return card;
  }
  private season(tvId: number, number: number): Promise<void> {
    const key = `${tvId}:${number}`;
    const running = this.seasonRequests.get(key); if (running) return running;
    const work = this.fetchSeason(tvId,number).finally(()=>this.seasonRequests.delete(key));
    this.seasonRequests.set(key,work); return work;
  }
  private async fetchSeason(tvId: number, number: number) {
    const cached = this.db.get('SELECT fetched_at FROM tmdb_seasons WHERE tmdb_id=? AND season=?', tvId, number);
    if (cached && cached.fetched_at > Date.now() - TITLE_TTL) return;
    const d = await this.get(`/tv/${tvId}/season/${number}`, { language: 'ko-KR' });
    if (d?.poster_path) {
      const row = this.db.get("SELECT card FROM tmdb_titles WHERE kind='tv' AND tmdb_id=?", tvId);
      if (row) {
        const card: CardInfo = JSON.parse(row.card);
        card.seasons = { ...card.seasons, [number]: { ...card.seasons?.[number], poster: img('w500', d.poster_path) } };
        this.db.run("UPDATE tmdb_titles SET card=? WHERE kind='tv' AND tmdb_id=?", JSON.stringify(card), tvId);
      }
    }
    const episodes: EpisodeInfo[] = (d?.episodes || []).map((e: any) => ({ number: e.episode_number, name: e.name || undefined, overview: e.overview || undefined, still: img('w300', e.still_path), airDate: e.air_date || undefined, runtime: e.runtime || undefined }));
    this.db.run('INSERT OR REPLACE INTO tmdb_seasons VALUES(?,?,?,?)', tvId, number, JSON.stringify(episodes), Date.now());
  }

  async search(query: string): Promise<MetadataCandidate[]> {
    if (!this.enabled) throw new ApiFailure(409, 'metadata-unavailable');
    const page = await this.get('/search/multi', { query, language: 'ko-KR', include_adult: 'false' });
    return ((page?.results || []) as SearchResult[]).filter(r => ['tv', 'movie'].includes(r.media_type || '')).slice(0, 20).map(r => candidate(r, r.media_type as MetadataKind));
  }
  async change(id: string, body: { action: 'link' | 'off' | 'auto'; kind?: MetadataKind; tmdbId?: number; season?: number }): Promise<MetadataLink> {
    if (!this.enabled) throw new ApiFailure(409, 'metadata-unavailable');
    const media = this.db.get('SELECT title FROM media WHERE id=?', id);
    if (!media) throw new ApiFailure(404, 'media-not-found');
    if (body.action === 'off') this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,status,checked_at) VALUES(?,'off',?)", id, Date.now());
    else if (body.action === 'auto') { this.db.run('DELETE FROM tmdb_links WHERE media_id=?', id); await this.link(id); }
    else {
      if (!body.kind || !body.tmdbId) throw new ApiFailure(400, 'invalid-request');
      const info = await this.title(body.kind, body.tmdbId);
      if (!info) throw new ApiFailure(404, 'metadata-not-found');
      if (!this.db.get('SELECT 1 FROM media WHERE id=?', id)) throw new ApiFailure(404, 'media-not-found');
      const wanted = body.season ?? searchTerms(this.db.displayTitle(id, media.title)).season;
      const season = body.kind === 'tv' && wanted && info.seasons?.[wanted] ? wanted : null;
      this.db.run("INSERT OR REPLACE INTO tmdb_links(media_id,kind,tmdb_id,season,status,score,checked_at) VALUES(?,?,?,?,'manual',100,?)", id, body.kind, body.tmdbId, season, Date.now());
    }
    await this.ensureDetail(id, 6000);
    return linkInfo(this.db, id, true);
  }
  /** Fill in titles that have never been checked, a few at a time. */
  async backfill() {
    if (!this.enabled) return;
    const hasSources = this.db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'");
    const foreignRetry = hasSources ? `OR EXISTS(SELECT 1 FROM tmdb_links l
      JOIN source_media sm ON sm.media_id=l.media_id JOIN source_entries se ON se.id=sm.source_id
      LEFT JOIN tmdb_match_versions v ON v.media_id=l.media_id
      WHERE l.media_id=m.id AND json_extract(se.entry,'$.lang') IS NOT NULL
      AND lower(json_extract(se.entry,'$.lang')) NOT LIKE 'ko%'
      AND (l.status='none' OR l.status='auto' AND l.score<100) AND COALESCE(v.version,0)<${MATCH_VERSION})` : '';
    const rows = this.db.all(`SELECT id FROM media m WHERE json_extract(metadata,'$.live') IS NOT 1
      AND (NOT EXISTS(SELECT 1 FROM tmdb_links l WHERE l.media_id=m.id) ${foreignRetry}) ORDER BY added_at DESC LIMIT 2000`);
    for (let i = 0; i < rows.length && !this.abort.signal.aborted; i += 6) await Promise.allSettled(rows.slice(i, i + 6).map(r => this.link(r.id)));
  }
  close() { this.abort.abort(); }
}

function candidate(r: SearchResult, fallback: MetadataKind): MetadataCandidate {
  const kind = (r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : fallback) as MetadataKind;
  const title = r.name || r.title || '', original = r.original_name || r.original_title;
  return { kind, id: r.id, title, ...(original && original !== title ? { originalTitle: original } : {}), year: yearOf(r.first_air_date || r.release_date), poster: img('w342', r.poster_path), ...(r.overview ? { overview: r.overview.slice(0, 300) } : {}) };
}

/* ---------- Read side: used by the catalog for every card and detail ---------- */

function linked(db: Store, id: string) {
  return db.get("SELECT l.kind,l.tmdb_id,l.season,l.status,t.card,t.detail FROM tmdb_links l JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id WHERE l.media_id=? AND l.status IN ('auto','manual')", id);
}
export function linkInfo(db: Store, id: string, enabled: boolean): MetadataLink {
  const row = db.get('SELECT * FROM tmdb_links WHERE media_id=?', id);
  if (!row) return { status: enabled ? 'pending' : 'none' };
  const title = row.kind ? db.get('SELECT card FROM tmdb_titles WHERE kind=? AND tmdb_id=?', row.kind, row.tmdb_id) : undefined;
  return { status: row.status, ...(row.kind ? { kind: row.kind, id: row.tmdb_id } : {}), ...(row.season != null ? { season: row.season } : {}), ...(title ? { title: JSON.parse(title.card).title } : {}) };
}
/** Remote titles prefer TMDB artwork; local libraries keep their own files first. */
export function overlayCard<T extends MediaCard>(db: Store, card: T, local: boolean): T {
  const row = linked(db, card.id);
  const original = card.originalTitle || db.get('SELECT title FROM media WHERE id=?',card.id)?.title || card.title;
  if (!local && db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'")) {
    const entry = db.get('SELECT entry FROM source_entries WHERE id=?', card.provider.id);
    const lang = entry && JSON.parse(entry.entry).lang;
    if (lang) card = { ...card, provider: { ...card.provider, lang } };
  }
  if (!row) {
    const { baseTitle, seasonInfo, audio } = parseSeasonInfo(original, { kind: card.type === 'movie' ? 'movie' : undefined });
    return { ...card, baseTitle, seasonInfo, audio };
  }
  const info: CardInfo = JSON.parse(row.card), season = row.season != null ? info.seasons?.[row.season] : undefined;
  const poster = season?.poster || info.poster, prefer = <V>(own: V | undefined, theirs: V | undefined) => local ? own ?? theirs : theirs ?? own;
  const sourceSeason = parseSeasonInfo(original);
  const inferredSeason = row.kind === 'tv' && !local && !sourceSeason.final ? sourceSeason.season ?? 1 : undefined;
  const parsed = parseSeasonInfo(original, { season: row.season ?? inferredSeason, seasons: Object.keys(info.seasons || {}).map(Number), kind: row.kind });
  return {
    ...card,
    baseTitle: !local && foreignSource(db,card.id).foreign && /[가-힣]/.test(info.title) ? parseSeasonInfo(info.title).baseTitle : parsed.baseTitle,
    seasonInfo: parsed.seasonInfo,
    audio: parsed.audio,
    ...(!local && foreignSource(db,card.id).foreign && /[가-힣]/.test(info.title) ? { title: localizedTitle(info.title, original), originalTitle: original } : {}),
    ...(prefer(card.poster, poster) ? { poster: prefer(card.poster, poster) } : {}),
    ...(info.backdrop || card.backdrop ? { backdrop: info.backdrop || card.backdrop } : {}),
    ...(info.logo ? { logo: info.logo } : {}),
    ...(card.year ?? season?.year ?? info.year ? { year: card.year ?? season?.year ?? info.year } : {}),
    // "애니" is already the type label; keep the genre for animated movies and series.
    ...(info.genres?.length ? { genres: card.type === 'anime' ? info.genres.filter(g => g !== '애니메이션') : info.genres } : {}),
    ...(info.rating ? { rating: info.rating } : {}),
    ...(info.certification ? { certification: info.certification } : {}),
    ...(info.overview && (!local || !card.overview) ? { overview: info.overview.length > 280 ? info.overview.slice(0, 278).trimEnd() + '…' : info.overview } : {}),
  };
}
const GENERIC_EPISODE = /^(?:제?\s*\d+\s*(?:화|회|편)|에피소드\s*\d+|episode\s*\d+|ep\.?\s*\d+)$/i;
export function overlayDetail(db: Store, detail: MediaDetail, local: boolean, enabled: boolean): MediaDetail {
  const metadata = linkInfo(db, detail.id, enabled);
  const row = linked(db, detail.id);
  if (!row) return enabled ? { ...detail, metadata } : detail;
  const info: CardInfo = JSON.parse(row.card), extra: DetailInfo = JSON.parse(row.detail);
  const foreign = !local && foreignSource(db,detail.id).foreign;
  const seasonCache = new Map<number, EpisodeInfo[] | undefined>();
  const episodesOf = (n: number) => {
    if (!seasonCache.has(n)) { const s = row.kind === 'tv' ? db.get('SELECT payload FROM tmdb_seasons WHERE tmdb_id=? AND season=?', row.tmdb_id, n) : undefined; seasonCache.set(n, s ? JSON.parse(s.payload) : undefined); }
    return seasonCache.get(n);
  };
  const seasons = detail.seasons.map(season => {
    const list = episodesOf(!local && row.season != null ? row.season : season.number);
    if (!list?.length) return season;
    const numbers = new Set(list.map(e => e.number));
    // Sequel seasons are sometimes numbered on from the previous one (13, 14, ...).
    const min = Math.min(...season.episodes.map(e => e.number));
    const offset = season.episodes.some(e => numbers.has(e.number)) ? 0 : min > 1 && numbers.has(1) ? min - 1 : 0;
    const titleKey = tmdbNorm(detail.title);
    return { ...season, episodes: season.episodes.map(ep => {
      const e = Number.isInteger(ep.number) ? list.find(x => x.number === ep.number - offset) : undefined;
      if (!e) return ep;
      const name = e.name && !GENERIC_EPISODE.test(e.name.trim()) && tmdbNorm(e.name) !== titleKey ? e.name : undefined;
      return { ...ep, ...(name ? { name, ...(foreign && /[가-힣]/.test(name) ? { title: name } : {}) } : {}), ...(e.overview && !ep.overview ? { overview: e.overview } : {}), ...(e.still && !ep.thumb ? { thumb: e.still } : {}), ...(e.airDate ? { airDate: e.airDate } : {}), ...(!ep.duration && e.runtime ? { duration: e.runtime * 60 } : {}) };
    }) };
  });
  return {
    ...detail, seasons, metadata,
    ...(info.overview && (!local || !detail.overview || info.overview.length > 20) ? { overview: info.overview } : {}),
    ...(extra.tagline ? { tagline: extra.tagline } : {}),
    ...(detail.type === 'movie' && !detail.runtime && info.runtime ? { runtime: info.runtime * 60 } : {}),
    ...(extra.people.length ? { people: extra.people, cast: extra.people.map(p => p.name) } : {}),
    ...(extra.trailer ? { trailer: extra.trailer } : {}),
    ...(extra.similar.length ? { similar: extra.similar } : {}),
  };
}

/** Source metadata is optional for local-only catalogs/tests. */
export function foreignSource(db: Store, id: string) {
  if (!db.get("SELECT 1 FROM sqlite_master WHERE name='source_entries'")) return { foreign: false, anime: false };
  const source = db.get('SELECT e.entry,e.repository FROM source_media m JOIN source_entries e ON e.id=m.source_id WHERE m.media_id=?',id);
  const entry = source ? JSON.parse(source.entry) : {};
  return { foreign: Boolean(entry.lang && !/^ko(?:-|$)/i.test(entry.lang)), anime: /anime|애니/i.test((entry.name || '') + ' ' + (source?.repository || '')) };
}
export function localizedTitle(korean: string, original: string) {
  const tail = /((?:season\s+\d+|final\s+season|part\s+\d+)(?:\s+(?:season\s+\d+|part\s+\d+))*)\s*$/i.exec(original)?.[1];
  return korean + (tail ? ' ' + tail.replace(/final\s+season/gi,'파이널 시즌').replace(/season/gi,'시즌').replace(/part/gi,'파트') : '');
}
export function subtitleIdentity(db: Store, id: string) {
  const row = linked(db,id);
  if (!row || !foreignSource(db,id).foreign) return undefined;
  const info: CardInfo = JSON.parse(row.card);
  return /[가-힣]/.test(info.title) ? { title: info.title, season: row.season as number | null, aliases: info.originalTitle ? [info.originalTitle] : [] } : undefined;
}

/** Playback classification only; preserve user catalog/source types. */
export function playbackMediaType(db: Store, id: string, type: MediaCard['type']): MediaCard['type'] {
  if (type !== 'series') return type;
  const row = linked(db, id);
  const info: CardInfo | undefined = row ? JSON.parse(row.card) : undefined;
  if (info && !info.animation) return type;
  return foreignSource(db, id).anime || info?.animation && info.originCountries?.includes('JP') ? 'anime' : type;
}
