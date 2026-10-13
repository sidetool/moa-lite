import { parseSeasonInfo, seasonIdentity, searchRelevance } from './season-info.js';
import { createHash, randomUUID } from 'node:crypto';
import { parseSeason } from '@moa/subtitles-ko';
import type { MediaCard, TitleGroup } from '@moa/shared';
import { Catalog } from './catalog.js';
import { ApiFailure, normalize } from './util.js';

// Deliberately retain season, year and edition words. Similar titles are only suggestions.
export function titleIdentity(title: string, type: string, year?: number): string {
  const canonical = title.normalize('NFKC').toLowerCase()
    .replace(/(?:season|시즌)\s*(\d+)|(\d+)\s*기/gi, (_, a, b) => ` season ${Number(a || b)} `)
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
  return JSON.stringify([canonical, type, year || null]);
}

// TV 링크는 특별편·다른 판본도 본편의 상위 작품으로 연결할 수 있다.
// 자동 묶기를 놓치더라도 본편 시즌에 잘못 편입하지 않도록 보수적으로 판단한다.
function hasTvEdition(title: string) {
  const text = title.normalize('NFKC');
  // 라틴 문자로만 된 끝 병기는 부제로 취급하지 않는다. 판본 단어 검사는 유지한다.
  const subtitles = text.replace(/[:–—-]\s*\p{Script=Latin}[\p{Script=Latin}\p{M}\d\s'’.!?&()-]*$/u, '');
  return /극장판|劇場版|특별편|스페셜|총집편|총집|재편집|더빙|자막|무삭제|\b(?:movie|ova|oad|specials?|recap|dub(?:bed)?|sub(?:bed)?|bd|blu[ -]?ray)\b/i.test(text)
    || /편(?=$|[\s\p{P}])|제\s*\d+\s*장|第\s*\d+\s*章|\bpart\s*\d+|파트\s*\d+|\d+\s*(?:부|쿨)(?=$|[\s\p{P}])/iu.test(text)
    || /[~〜～:：]|\s[-–—]\s|[-–—][^-–—]+[-–—]/u.test(subtitles);
}

export function titleGroupSeason(title: string, tmdbTitle?: string): number | undefined {
  const text = title.normalize('NFKC');
  const parsed = parseSeason(text);
  if (parsed != null) return parsed;
  const roman = text.match(/\s(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s|[~〜:–—-])/i);
  if (roman) return parseSeason(`Season ${roman[1]}`);
  const number = text.trim().match(/\s([1-9]\d?)$/)?.[1];
  if (number && tmdbTitle && !tmdbTitle.normalize('NFKC').match(/\d+/g)?.some(n => Number(n) === Number(number))) return Number(number);
  return undefined;
}
interface GroupMember { id: string; provider: string; tmdb?: string; useTmdb: boolean; count?: number }

export class TitleGroups {
  constructor(private catalog: Catalog) {
    catalog.db.db.exec(`CREATE TABLE IF NOT EXISTS title_group_overrides(profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,group_id TEXT NOT NULL,PRIMARY KEY(profile_id,media_id));`);
  }
  mapping(profile: string) {
    const db = this.catalog.db;
    const rows = db.all(`SELECT m.*,l.kind AS tmdb_kind,l.tmdb_id,l.season AS tmdb_season, t.card AS tmdb_card, (SELECT COUNT(*) FROM episodes e WHERE e.media_id=m.id) AS episode_count
      FROM media m LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
      LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id`);
    const overrides = new Map(db.all('SELECT * FROM title_group_overrides WHERE profile_id=?',profile).map(r => [r.media_id,r.group_id]));
    const result = new Map<string,string>(), titles = new Map<string,GroupMember[]>(), buckets = new Map<string,GroupMember[]>();
    const enabled = new Set(db.all('SELECT id FROM source_entries WHERE enabled=1').map(r => r.id));
    const localSeasons = new Map<string,number[]>();
    for (const e of db.all(`SELECT DISTINCT e.media_id,e.season FROM episodes e JOIN media m ON m.id=e.media_id
      WHERE json_extract(m.metadata,'$.provider.id') IS NULL OR json_extract(m.metadata,'$.provider.id')='local'
      ORDER BY e.media_id,e.season`)) {
      const seasons = localSeasons.get(e.media_id) || []; seasons.push(e.season); localSeasons.set(e.media_id,seasons);
    }
    for (const r of this.catalog.kids.filter(rows, profile)) {
      const meta = JSON.parse(r.metadata), provider = meta.provider?.id || 'local';
      if (provider !== 'local' && !enabled.has(provider)) continue;
      let title = r.title, localMultiple = false;
      if (provider === 'local' && r.type !== 'movie' && !/(?:season|시즌)\s*\d+|\d+\s*기/i.test(title)) {
        const seasons = localSeasons.get(r.id) || [];
        localMultiple = seasons.length !== 1;
        title += seasons.length === 1 ? ` season ${seasons[0]}` : ` local seasons ${seasons.join(',') || 'unknown'}`;
      }
      const excluded = meta.live || /(?:\.{3}|…)\s*$/.test(r.title);
      const info = r.tmdb_card ? JSON.parse(r.tmdb_card) : undefined;
      const parsed = parseSeasonInfo(title, { season: r.tmdb_season ?? titleGroupSeason(r.title, info?.title), seasons: Object.keys(info?.seasons || {}).map(Number), kind: r.tmdb_kind });
      const edition = seasonIdentity(parsed);
      const identity = excluded ? r.id : JSON.stringify([titleIdentity(parsed.identityTitle, r.type, meta.year), edition]);
      const tmdb = !excluded && r.tmdb_id != null ? r.tmdb_kind === 'movie' ? JSON.stringify(['movie',r.tmdb_id,parsed.part ?? null,parsed.half ?? null])
        : r.tmdb_kind === 'tv' ? JSON.stringify(['tv',r.tmdb_id,edition]) : undefined : undefined;
      const special = ['movie','ova','special'].includes(parsed.seasonInfo?.kind || '');
      const member: GroupMember = { id:r.id, provider, tmdb, count: r.episode_count || meta.episodeCount || undefined,
        useTmdb:Boolean(tmdb) && (r.tmdb_kind === 'movie' || !localMultiple && !special && !hasTvEdition(parsed.identityTitle)) };
      const bucket = titles.get(identity) || []; bucket.push(member); titles.set(identity,bucket);
    }
    const fallback = new Map<string,string>();
    for (const [identity,bucket] of titles) {
      const linked = new Set(bucket.flatMap(r => r.tmdb ? [r.tmdb] : []));
      const partitions = new Map<string,GroupMember[]>();
      for (const r of bucket) {
        // 기존 제목 묶음을 나누는 유일한 사유는 확인된 TMDB 정체성 충돌이다.
        const key = linked.size > 1 ? JSON.stringify([identity,r.tmdb || null]) : identity;
        const members = partitions.get(key) || []; members.push(r); partitions.set(key,members);
      }
      for (const [key,members] of partitions) {
        const titleKey = `auto:${createHash('sha256').update(key).digest('hex')}`;
        for (const r of members) fallback.set(r.id,titleKey);
        const tmdb = members.find(r => r.tmdb)?.tmdb;
        // 제목 묶음 전체가 함께 이동해야 판본 표시 차이로 기존 묶음이 깨지지 않는다.
        if (!tmdb || members.some(r => r.tmdb && !r.useTmdb)) continue;
        const candidates = buckets.get(tmdb) || []; candidates.push(...members); buckets.set(tmdb,candidates);
      }
    }
    for (const [tmdb,bucket] of buckets) {
      const key = `auto:${createHash('sha256').update(`tmdb:${tmdb}`).digest('hex')}`;
      for (const r of bucket) fallback.set(r.id,key);
    }
    // Counts are source observations, never TMDB totals. Unknown counts must not bridge
    // conflicting observed cuts (e.g. 12-episode cour versus 22-episode full season).
    const counts = new Map<string,Set<number>>();
    const members = [...titles.values()].flat();
    for (const r of members) {
      const key = fallback.get(r.id)!;
      const set = counts.get(key) || new Set<number>(); if (r.count) set.add(r.count); counts.set(key,set);
    }
    for (const r of members) {
      const key = fallback.get(r.id)!;
      const conflict = counts.get(key)!.size > 1;
      const count = r.count || 'unknown';
      result.set(r.id, overrides.get(r.id) || (conflict ? `${key}:episodes:${count}` : key));
    }
    return result;
  }
  group(id: string, profile: string): TitleGroup {
    const map = this.mapping(profile), key = map.get(id);
    if (!key) throw new ApiFailure(404,'media-not-found');
    return { id:key, manual:key.startsWith('manual:'), members:[...map].filter(([,g]) => g === key).map(([mid]) => this.catalog.card(this.catalog.db.get('SELECT * FROM media WHERE id=?',mid)!,profile)) };
  }
  resolve(ids: string[], profile: string, query?: string): MediaCard[] {
    const map = this.mapping(profile), groups = new Map<string,MediaCard[]>();
    for (const id of new Set(ids)) {
      const k = map.get(id); if (!k) continue;
      const cards = groups.get(k) || [];
      cards.push(this.catalog.card(this.catalog.db.get('SELECT * FROM media WHERE id=?',id)!,profile)); groups.set(k,cards);
    }
    return [...groups.values()].map(cards => {
      const rank = (c: MediaCard) => c.provider.lang === 'ko' ? 0 : c.provider.lang === 'all' || c.provider.kind === 'local' ? 1 : 2;
      const representative = cards.reduce((best, card) => rank(card) < rank(best) ? card : best);
      return { ...representative,
        langs: [...new Set(cards.flatMap(c => c.provider.lang ? [c.provider.lang] : []))].sort(),
        ...(query?.trim() ? { relevance: Math.max(...cards.map(c => searchRelevance(c,query))) } : {}),
        sourceCount: new Set(cards.map(c => c.provider.id)).size };
    });
  }
  continueWatching(recent: MediaCard[], candidates: Record<string, any>[], profile: string): MediaCard[] {
    if (!recent.length) return [];
    const mapping = this.mapping(profile), members = new Map<string, Record<string, any>[]>(), seen = new Set<string>();
    for (const row of candidates) {
      const key = mapping.get(row.id) ?? row.id;
      const group = members.get(key) ?? []; group.push(row); members.set(key, group);
    }
    return recent.flatMap(card => {
      const key = mapping.get(card.id) ?? card.id;
      if (seen.has(key)) return [];
      seen.add(key);
      if (!card.resume) return [];
      const group = members.get(key)!.map(row => this.catalog.card(row, profile));
      const rank = (item: MediaCard) => item.provider.lang === 'ko' ? 0 : item.provider.lang === 'all' || item.provider.kind === 'local' ? 1 : 2;
      const representative = group.reduce((best, item) => rank(item) < rank(best) ? item : best);
      return [{ ...representative, resume: card.resume, progress: card.progress,
        sourceCount: new Set(group.map(item => item.provider.id)).size,
        langs: [...new Set(group.flatMap(item => item.provider.lang ? [item.provider.lang] : []))].sort() }];
    });
  }
  change(id: string, profile: string, action: string, otherId?: string) {
    const group = this.group(id,profile), db = this.catalog.db;
    db.transaction(() => {
      if (action === 'reset') db.run('DELETE FROM title_group_overrides WHERE profile_id=? AND media_id=?',profile,id);
      else if (action === 'separate') db.run('INSERT OR REPLACE INTO title_group_overrides VALUES(?,?,?)',profile,id,`manual:${randomUUID()}`);
      else {
        if (!otherId || otherId === id) throw new ApiFailure(400,'invalid-group-target');
        const other = this.group(otherId,profile), key = `manual:${randomUUID()}`;
        for (const m of [...group.members,...other.members]) db.run('INSERT OR REPLACE INTO title_group_overrides VALUES(?,?,?)',profile,m.id,key);
      }
    });
    return this.group(id,profile);
  }
  candidates(q: string, profile: string) {
    if (!normalize(q)) return [];
    const map = this.mapping(profile);
    return this.catalog.search(profile, q).groups.flatMap(group => group.items).filter(card => map.has(card.id)).slice(0,40);
  }
}
