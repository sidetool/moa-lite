export { normalizeTitle, parseSeason, parseEpisodes } from '../../../packages/subtitles-ko/src/normalize.js';
import aliases from '../../../packages/subtitles-ko/src/aliases.json';
import { normalizeTitle, titleKey } from '../../../packages/subtitles-ko/src/normalize.js';
export function knownAnimeIdentity(title: string, season?: number) {
  const normalized = normalizeTitle(title, season);
  const alias = aliases.find(a => [a.korean, ...a.aliases].some(name => titleKey(name) === titleKey(normalized.baseTitle)));
  const offsets = alias?.episodeOffsets as Record<string, number> | undefined;
  const episodeOffset = offsets?.[String(normalized.season)] ?? 0;
  const next = offsets?.[String(normalized.season + 1)];
  return { aliases: alias?.aliases.filter(name => !/[가-힣]/.test(name)) ?? [], episodeOffset, episodeCount: next === undefined ? undefined : next - episodeOffset };
}
/** Preserve ASS/VTT. Other formats are converted by the original server parser. */
export function convertSubtitle(content: string, format: string): { content: string; format: 'ass' | 'vtt' } {
  if (format === 'ass' && /^\s*\[Script Info\]/i.test(content)) return { content, format: 'ass' };
  if (format === 'vtt' && /^\s*WEBVTT/.test(content)) return { content, format: 'vtt' };
  if (format === 'srt') return { content: 'WEBVTT\n\n' + content.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'), format: 'vtt' };
  throw new Error('unsupported_subtitle_format');
}
