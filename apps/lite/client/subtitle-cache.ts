export function subtitleSearchTtl(result: { candidates: unknown[]; partial: boolean }) {
  return result.candidates.length ? (result.partial ? 5 * 60_000 : 24 * 60 * 60_000) : 30_000;
}
export function reuseSubtitleSearch(saved: any, queryKey: string, refresh: boolean): boolean {
  return !refresh && saved?.queryKey === queryKey && Array.isArray(saved.result?.candidates);
}
