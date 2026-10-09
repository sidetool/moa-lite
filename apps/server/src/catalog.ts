import type { Episode, EpisodeProgress, MediaCard, MediaDetail, HomeResponse, HistoryEntry, MediaType, Page, ProviderRef, Row } from '@moa/shared';
import { KidsPolicy } from './kids.js';
import { Store } from './db.js';
import { ApiFailure, normalize } from './util.js';
import { continueTarget, playTarget, summary } from './progress.js';
import { videoStream, type Probe } from './probe.js';
import { overlayCard, overlayDetail } from './tmdb.js';

export const LOCAL_PROVIDER: ProviderRef = { id: 'local', name: '로컬 라이브러리', kind: 'local' };
export function episodeProgress(row: Record<string, any>): EpisodeProgress {
  return { position: row.position, duration: row.duration, completed: Boolean(row.completed), updatedAt: row.updated_at };
}
export class Catalog {
  /** Set when TMDB is configured; detail responses then report the link state. */
  metadata = false;
  kids: KidsPolicy;
  constructor(public db: Store) { this.kids = new KidsPolicy(db); }
  episodes(id: string, profile: string): Episode[] {
    return this.db.all(`SELECT e.*,p.position,p.duration AS progress_duration,p.completed,p.updated_at
      FROM episodes e LEFT JOIN progress p ON p.episode_id=e.id AND p.profile_id=?
      WHERE e.media_id=? ORDER BY e.season,e.number,e.id`, profile,id).map(e => {
      const p = e.updated_at !== null ? { ...e, duration: e.progress_duration } : undefined;
      return { id: e.id, mediaId: e.media_id, season: e.season, number: e.number, title: e.title, duration: e.duration, ...(e.thumb ? { thumb: e.thumb } : {}), ...(p ? { progress: episodeProgress(p) } : {}) };
    });
  }
  card(row: Record<string, any>, profile: string): MediaCard {
    const { poster, backdrop, year, genres, provider, live } = JSON.parse(row.metadata);
    const episodes = this.episodes(row.id, profile);
    const resume = !live ? continueTarget(episodes, row.type === 'movie') : null;
    const current = resume && episodes.find(e => e.id === resume.episodeId);
    return overlayCard(this.db, { id: row.id, title: this.db.displayTitle(row.id, row.title), type: row.type, provider: provider || LOCAL_PROVIDER, ...(live ? { badge: "LIVE" } : {}), addedAt: row.added_at,
      ...(poster ? { poster } : {}), ...(backdrop ? { backdrop } : {}), ...(year ? { year } : {}), ...(genres?.length ? { genres } : {}),
      ...(row.type !== 'movie' ? { episodeCount: this.db.get('SELECT COUNT(*) AS n FROM episodes WHERE media_id=?', row.id)!.n } : {}),
      inWatchlist: Boolean(this.db.get('SELECT 1 FROM watchlist WHERE profile_id=? AND media_id=?', profile, row.id)),
      ...(resume ? { resume } : {}),
      ...(current?.progress && !current.progress.completed && current.progress.position > 0
        ? { progress: summary(current, current.progress, row.type === 'movie') } : {}),
    }, !provider || provider.kind === 'local');
  }
  cards(profile: string, type?: MediaType): MediaCard[] {
    return this.kids.filter(this.db.all(`SELECT * FROM media ${type ? 'WHERE type=?' : ''} ORDER BY added_at DESC,id`, ...(type ? [type] : [])), profile).map(m => this.card(m, profile));
  }
  detail(id: string, profile: string): MediaDetail {
    const row = this.db.get('SELECT * FROM media WHERE id=?', id);
    if (!row) throw new ApiFailure(404, 'media-not-found');
    this.kids.assert(id, profile);
    const episodes = this.episodes(id, profile), meta = JSON.parse(row.metadata);
    const seasons = [...new Set(episodes.map(e => e.season))].map(number => ({ number, title: `시즌 ${number}`, episodes: episodes.filter(e => e.season === number) }));
    const target = playTarget(episodes, row.type === 'movie');
    const file = target && this.db.get('SELECT * FROM files WHERE episode_id=?', target.episodeId);
    const probe: Probe | undefined = file && JSON.parse(file.probe);
    const video = probe && videoStream(probe);
    const local = !meta.provider || meta.provider.kind === 'local';
    const base: MediaDetail = { ...this.card(row, profile), ...meta, seasons, playTarget: target,
      ...(row.type === 'movie' ? { runtime: episodes[0]?.duration } : {}),
      ...(file && probe && video ? { fileInfo: { container: probe.container, video: video.codec_name || '', audio: probe.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name).join(', '), resolution: `${video.width}×${video.height}`, size: file.size } } : {}),
    };
    const detail = overlayDetail(this.db, overlayCard(this.db, base, local), local, this.metadata);
    if (detail.similar) detail.similar = this.kids.candidates(detail.similar, profile);
    return detail;
  }
  watchlist(profile: string): MediaCard[] {
    return this.kids.filter(this.db.all('SELECT m.* FROM media m JOIN watchlist w ON w.media_id=m.id WHERE w.profile_id=? ORDER BY w.added_at DESC', profile), profile).map(m => this.card(m, profile));
  }
  home(profile: string, type?: MediaType, providers?: string[], continueScope: 'tab' | 'all' = 'tab'): HomeResponse {
    const allowed = (c: MediaCard) => providers ? providers.includes(c.provider.id) : c.provider.kind !== "local";
    const allCards = this.cards(profile, type);
    const cards = allCards.filter(allowed), watchlist = this.watchlist(profile).filter(c => (!type || c.type === type) && allowed(c));
    // Home resume history belongs to the profile, independently of tab discovery sources.
    const resumeCards = new Map((continueScope === 'all' ? allCards : cards).map(c => [c.id, c]));
    const ongoing = this.db.all(`SELECT e.media_id,MAX(p.updated_at) AS updated FROM progress p JOIN episodes e ON e.id=p.episode_id WHERE p.profile_id=? AND (p.position>0 OR p.completed=1) GROUP BY e.media_id ORDER BY updated DESC`, profile)
      .flatMap(p => {
        const card = resumeCards.get(p.media_id);
        return card?.resume ? [card] : [];
      });
    const local = cards.filter(c => c.provider.kind === "local");
    const rows: Row[] = [
      { id: 'continue', title: '이어보기', kind: 'continue', layout: 'landscape', items: ongoing.slice(0, 30), more: { path: '/history' } },
      { id: 'watchlist', title: '볼 목록', kind: 'watchlist', layout: 'poster', items: watchlist.slice(0, 30), more: { path: '/my-list' } },
      { id: 'recent', title: '최근 추가', kind: 'recent', layout: 'poster', items: local.slice(0, 30), more: { path: '/local' } },
    ];
    for (const [t, title] of [['anime', '애니'], ['series', '시리즈'], ['movie', '영화']] as const) {
      if (!type || type === t) rows.push({ id: t, title, kind: 'media', layout: 'poster', items: local.filter(c => c.type === t).slice(0, 30), more: { path: `/local?type=${t}` } });
    }
    for (const genre of [...new Set(local.flatMap(c => c.genres || []))].sort()) rows.push({ id: `genre:${genre}`, title: genre, kind: 'genre', layout: 'poster', items: local.filter(c => c.genres?.includes(genre)).slice(0, 30), more: { path: `/local/genre/${encodeURIComponent(genre)}` } });
    return { hero: cards.filter(c => c.backdrop).slice(0, 5), rows: rows.filter(row => row.items.length > 0) };
  }
  page<T>(items: T[], page: number, size = 40): Page<T> { return { items: items.slice((page - 1) * size, page * size), page, hasNextPage: items.length > page * size, total: items.length }; }
  history(profile: string, page: number): Page<HistoryEntry> {
    const records = this.db.all('SELECT p.*,e.media_id FROM progress p JOIN episodes e ON e.id=p.episode_id WHERE p.profile_id=? ORDER BY p.updated_at DESC,p.episode_id DESC', profile);
    const visible = new Set(this.kids.filter(records.map(p => ({ id: p.media_id })), profile).map(p => p.id));
    const grouped = this.db.settings(profile).groupHistory;
    const counts = new Map<string, number>();
    const filtered = records.filter(p => visible.has(p.media_id)).filter(p => {
      const count = counts.get(p.media_id) || 0;
      counts.set(p.media_id, count + 1);
      return !grouped || count === 0;
    });
    const paged = this.page(filtered, page);
    return { ...paged, items: paged.items.map(p => ({ media: this.card(this.db.get('SELECT * FROM media WHERE id=?', p.media_id)!, profile), episode: this.episodes(p.media_id, profile).find(e => e.id === p.episode_id)!, watchedAt: p.updated_at, ...(grouped ? { groupedCount: counts.get(p.media_id)! } : {}) })) };
  }
  search(profile: string, query: string) {
    const q = normalize(query);
    const ids = new Set(this.db.all('SELECT id,title FROM media').filter(m => normalize(m.title).includes(q)).map(m => m.id));
    for (const t of this.db.all('SELECT media_id,title FROM media_titles')) if (normalize(t.title).includes(q)) ids.add(t.media_id);
    const found = this.cards(profile).filter(c => ids.has(c.id) || normalize(c.title).includes(q) || normalize(c.originalTitle || '').includes(q));
    const groups = new Map<string, { provider: MediaCard['provider']; items: MediaCard[] }>();
    groups.set(LOCAL_PROVIDER.id, { provider: LOCAL_PROVIDER, items: [] });
    for (const card of found) { const group = groups.get(card.provider.id) || { provider: card.provider, items: [] }; group.items.push(card); groups.set(card.provider.id,group); }
    return { query, groups: [...groups.values()] };
  }
}
