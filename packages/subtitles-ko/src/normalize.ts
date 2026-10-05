const seasonPattern = /(?:\bS(\d{1,2})(?=E\d|\b)|\bSeason\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b|시즌\s*(\d{1,2})|(\d{1,2})\s*기|第\s*(\d{1,2})\s*期|\b(\d{1,2})(?:st|nd|rd|th)\b)/i;
const romans: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

export function parseSeason(raw: string): number | undefined {
  const text = raw.normalize("NFKC").replace(/[._]/g, " ");
  const match = text.match(seasonPattern);
  if (match) return Number(match.slice(1).find(Boolean)) || undefined;
  const roman = text.trim().match(/\s(II|III|IV|V|VI|VII|VIII|IX|X)$/i)?.[1]?.toUpperCase();
  return roman ? romans[roman] : undefined;
}

export function normalizeTitle(raw: string, season?: number): { baseTitle: string; season: number } {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) throw new TypeError("title must contain 1–500 characters");
  const parsedSeason = season ?? parseSeason(raw) ?? 1;
  if (!Number.isInteger(parsedSeason) || parsedSeason < 1 || parsedSeason > 99) throw new RangeError("season must be 1–99");
  let text = raw.normalize("NFKC").replace(/\.(?:mkv|mp4|avi|webm|ass|srt|smi|vtt)$/i, "");
  // Square brackets used as release-group/technical tags. Preserve a title that is the entire bracketed input.
  text = text.replace(/^\[[^\]]+\]\s*(?=\S)/, "").replace(/\[[^\]]*(?:\d{3,4}p|HEVC|AVC|[A-F\d]{8})[^\]]*\]/gi, "");
  text = text.replace(/[【】「」『』\[\]]/g, " ").replace(/[._]/g, " ");
  text = text.replace(seasonPattern, " ").replace(/\bE\d{1,4}(?:\.\d)?\b/gi, " ");
  text = text.replace(/\s(?:II|III|IV|V|VI|VII|VIII|IX|X)$/i, " ");
  text = text.replace(/\s*-\s*\d{1,4}(?:\.\d)?(?:\s.*)?$/, " ").replace(/\s\d{1,4}(?:\.\d)?\s*(?:화|話)\s*$/, " ");
  text = text.replace(/\([^)]*(?:\d{3,4}p|HEVC|WEB|BD|AAC|자막|더빙)[^)]*\)/gi, " ");
  const baseTitle = text.replace(/\s+/g, " ").trim();
  if (!baseTitle) throw new TypeError("title is empty after normalization");
  return { baseTitle, season: parsedSeason };
}

export function titleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function seasonTitle(base: string, season: number): string {
  return season === 1 ? base : `${base} ${season}기`;
}

/** Parse episode tokens, keeping season numbers, title numbers and quality tags out. */
export function parseEpisodes(raw: string): number[] {
  let text = raw.normalize("NFKC").split(/[\\/]/).at(-1) ?? raw;
  const batch = text.match(/(?<!\d)(\d{1,3})\s*[-~～]\s*(\d{1,3})\s*(?:화|話|\.(?:zip|ass|srt|smi)|$)/i);
  if (batch) {
    const start = Number(batch[1]), end = Number(batch[2]);
    if (start <= end && end - start <= 200) return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  const explicit = [...text.matchAll(/(?:\bS\d{1,2}E|\bEP?(?:ISODE)?\s*|第|#)(\d{1,4}(?:\.\d)?)(?!\d)|(?<!\d)(\d{1,4}(?:\.\d)?)\s*(?:화|話)(?!\p{L})/giu)];
  if (explicit.length) return [...new Set(explicit.map(m => Number(m[1] ?? m[2])))];
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\.(?:ass|ssa|smi|srt|vtt|zip|7z|rar|tar)$/i, " ");
  text = text.replace(seasonPattern, " ").replace(/\b\d{3,4}p\b/gi, " ");
  const range = text.match(/(?:^|\s)(\d{1,3})\s*[~～]\s*(\d{1,3})(?=\s|$)/);
  if (range) {
    const start = Number(range[1]), end = Number(range[2]);
    if (start <= end && end - start <= 200) return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  // A terminal number or release separator is reliable; numbers embedded in titles are not.
  const match = text.trim().match(/(?:^|\s[-–]\s*|\s)(\d{1,4}(?:\.\d)?)(?:\s*(?:END|완|자막|v\d+))?$/i);
  return match && Number(match[1]) < 2000 ? [Number(match[1])] : [];
}

export function validateEpisode(episode: number): void {
  if (!Number.isFinite(episode) || episode < 0 || episode > 10000) throw new RangeError("episode must be 0–10000");
}

export function validateOffset(offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new RangeError("episodeOffset must be 0–10000");
}
