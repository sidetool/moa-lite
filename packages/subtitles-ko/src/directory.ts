import { load } from 'cheerio';
import catalog from './creator-directory.json' with { type: 'json' };
import { normalizeTitle, titleKey, parseSeason } from './normalize.js';
import { validatePublicUrl } from './http.js';
import type { ResolvedTitle, SubtitleCreator } from './types.js';

export interface DirectoryEntry { title: string; aliases: string[]; name: string; website: string; reference: string }

/** Public factual references only. The downloaded extension's code/data is not bundled. */
export function parseCreatorDirectory(html: string, reference: string): DirectoryEntry[] {
  const $ = load(html), entries: DirectoryEntry[] = [];
  $('.tt_article_useless_p_margin p, .entry-content p').each((_, element) => {
    const row = $(element), text = row.text().replace(/\s+/g, ' ').trim();
    const heading = text.split(/[★☆●◈◆■▶▷]/)[0]?.trim() || '';
    const title = heading.split(/\s*\([A-Za-z0-9]/)[0]?.replace(/[ (]+$/, '').trim() || '';
    if (!/[가-힣]/.test(title) || title.length > 200 || !/[★☆●◈◆■▶▷]/.test(text)) return;
    const alternate = heading.match(/\(([A-Za-z][^)]*)\)?/)?.[1]?.replace(/,?\s*20\d{2}$/, '').trim();
    row.find('a[href]').each((_, anchor) => {
      try {
        const website = validatePublicUrl(new URL($(anchor).attr('href')!, reference).href);
        const name = $(anchor).text().trim();
        if (!name || name.length > 60 || website.origin === new URL(reference).origin) return;
        entries.push({ title, aliases: alternate ? [alternate] : [], name, website: website.href, reference });
      } catch { /* Skip invalid references. */ }
    });
  });
  return entries;
}

// A bare numeric suffix is deliberately kept: it can be part of a title.
function matches(entry: DirectoryEntry, resolved: ResolvedTitle) {
  const season = parseSeason(entry.title) ?? entry.aliases.map(parseSeason).find(Boolean) ?? 1;
  if (season !== resolved.season) return false;
  const names = [resolved.baseTitle, ...(resolved.aliases ?? [])].map(name => titleKey(normalizeTitle(name).baseTitle));
  return [entry.title, ...entry.aliases].some(name => {
    const identity = normalizeTitle(name);
    return names.includes(titleKey(identity.baseTitle));
  });
}
export function directoryCreators(resolved: ResolvedTitle, entries: DirectoryEntry[] = catalog.entries): SubtitleCreator[] {
  const found = entries.filter(entry => matches(entry, resolved));
  const seen = new Set<string>();
  return found.flatMap(entry => {
    const key = entry.website;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: `directory:${entry.website}`, name: entry.name, website: entry.website,
      aliases: [...new Set([...(resolved.aliases ?? []), entry.title, ...entry.aliases])],
      source: 'directory' as const, title: resolved.title, season: resolved.season,
      episodeOffset: resolved.episodeOffset, confidence: Math.min(resolved.confidence, .9), isCurrentEpisode: false }];
  }).slice(0, 8);
}

export function directoryTitle(names: string[], season: number): string | undefined {
  const matchesByTitle = catalog.entries.filter(entry => matches(entry, {title:names[0]!,baseTitle:names[0]!,aliases:names.slice(1),season,episodeOffset:0,source:'input',confidence:0}));
  const titles = [...new Set(matchesByTitle.map(entry => normalizeTitle(entry.title).baseTitle))];
  return titles.length === 1 ? titles[0] : undefined;
}
export function creatorHome(raw: string): string {
  const url = new URL(raw);
  return /^(?:m\.)?blog\.naver\.com$/.test(url.hostname)
    ? `naver:${url.searchParams.get('blogId') || url.pathname.split('/')[1]}` : url.origin;
}
