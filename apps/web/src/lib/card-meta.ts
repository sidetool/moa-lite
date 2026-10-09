import type { MediaCard, SeasonInfo } from "@moa/shared";

export type { SeasonInfo };
export const seasonInfo = (card: MediaCard) => card.seasonInfo;
// Display ordering only: retain original audio words in the server's grouping identity.
export const baseTitle = (card: MediaCard) => (card.baseTitle || card.title).replace(/더빙판?|자막판?|\b(?:dub(?:bed)?|sub(?:bed)?)\b/gi, '').replace(/\(\s*\)|\[\s*\]/g, '').trim();
export const relevance = (card: MediaCard) => card.relevance;

const LANG_LABEL: Record<string, string> = {
  en: "영어", ja: "일본어", zh: "중국어", es: "스페인어", fr: "프랑스어", de: "독일어", pt: "포르투갈어", it: "이탈리아어",
  ru: "러시아어", ar: "아랍어", id: "인도네시아어", vi: "베트남어", th: "태국어", tr: "튀르키예어", hi: "힌디어",
};
/** Two-letter code for a source that is explicitly in another language; Korean and multi-language sources return nothing. */
export function foreignCode(lang?: string): string | undefined {
  const code = lang?.toLowerCase().split(/[-_]/)[0];
  return code && !["ko", "all", "multi", "und"].includes(code) ? code : undefined;
}
export const foreignLang = (card: MediaCard) => foreignCode(card.provider.lang);
export const langLabel = (code: string) => LANG_LABEL[code] ?? code.toUpperCase();

/** Fallback for cards that arrive without the source language: fill it from the installed source list. */
export function withLang(card: MediaCard, langs: Map<string, string>): MediaCard {
  const lang = langs.get(card.provider.id);
  return lang && !card.provider.lang ? { ...card, provider: { ...card.provider, lang } } : card;
}

const KIND_ORDER: Record<SeasonInfo["kind"], number> = { season: 0, part: 0, final: 1, movie: 2, ova: 3, special: 4 };
/** Franchise order: seasons and parts in sequence, then the final season, movies, OADs and specials. */
export function compareSeason(a: MediaCard, b: MediaCard) {
  const x = seasonInfo(a), y = seasonInfo(b);
  const kind = (x ? KIND_ORDER[x.kind] : 0) - (y ? KIND_ORDER[y.kind] : 0);
  if (kind) return kind;
  const season = (x?.season ?? (x?.kind === "final" ? 99 : 1)) - (y?.season ?? (y?.kind === "final" ? 99 : 1));
  if (season) return season;
  return (x?.part ?? 0) - (y?.part ?? 0) || Number(a.audio === "dub") - Number(b.audio === "dub") || (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title, "ko");
}

export interface ResumeAction { episodeId: string; label: string; kind: "resume" | "next"; path: string }
/** Where a "continue" action should land: the unfinished episode, or the next one after a finished episode. */
export function resumeTarget(card: MediaCard): ResumeAction | null {
  const target = card.resume ?? (card.progress && { episodeId: card.progress.episodeId, label: card.progress.label, kind: "resume" as const, position: undefined });
  if (!target) return null;
  // The server's position is authoritative: 0 for an unseen next episode, the saved spot otherwise.
  const path = `/watch/${encodeURIComponent(target.episodeId)}${target.position !== undefined ? `?t=${Math.floor(target.position)}` : ""}`;
  // Unfinished viewing keeps the richer "S2:E3 · 12분 남음" summary.
  const label = target.kind === "resume" && card.progress?.episodeId === target.episodeId ? card.progress.label : target.label;
  return { episodeId: target.episodeId, label, kind: target.kind, path };
}
