import type { SubtitleTrack } from '@moa/shared';
import { api, currentProfileId } from '../lib/api';

type SubtitlePreference = Pick<SubtitleTrack, 'id' | 'source' | 'label' | 'lang' | 'format'> & { episodeId: string };
const choiceKey = (episodeId: string) => `moa.subtitleChoice:${JSON.stringify([currentProfileId(), episodeId])}`;
const choices = new Map<string, SubtitlePreference | null>();
export function subtitlePreference(episodeId: string): SubtitlePreference | null | undefined {
  const key = choiceKey(episodeId);
  if (choices.has(key)) return choices.get(key);
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const value = JSON.parse(raw);
    if (value === null) return null;
    return value && typeof value.id === 'string' && typeof value.episodeId === 'string' && typeof value.label === 'string' && ['vtt', 'ass'].includes(value.format) ? value : undefined;
  } catch { return undefined; }
}
export function rememberSubtitle(episodeId: string, track: SubtitleTrack | null, originEpisodeId?: string) {
  const previous = subtitlePreference(episodeId);
  const value = track ? { id: track.id, source: track.source, label: track.label, lang: track.lang, format: track.format, episodeId: originEpisodeId ?? (previous?.id === track.id ? previous.episodeId : episodeId) } : null;
  const key = choiceKey(episodeId);
  try { localStorage.setItem(key, JSON.stringify(value)); choices.delete(key); } catch { choices.set(key, value); }
}
export async function restoreSubtitle(episodeId: string, tracks: SubtitleTrack[], preference: SubtitlePreference, signal: AbortSignal): Promise<SubtitleTrack | null> {
  const saved = ['upload', 'translation', 'online'].includes(preference.source ?? '');
  const matches = (track: SubtitleTrack) => track.source === preference.source && track.label === preference.label && track.lang === preference.lang && track.format === preference.format;
  const current = tracks.find(track => track.id === preference.id && (saved || matches(track)));
  if (current) return current;
  if (preference.episodeId === episodeId && !saved) {
    const matching = tracks.filter(matches);
    return matching.length === 1 ? matching[0] : null;
  }
  if (preference.source !== 'translation') return null;
  const items = await api<SubtitleTrack[]>(`/episodes/${encodeURIComponent(preference.episodeId)}/subtitles/translations`, { signal });
  return items.find(track => track.id === preference.id) ?? null;
}

const key = (mediaId: string) => `moa.subtitlesOff:${JSON.stringify([currentProfileId(), mediaId])}`;
// Preserve the choice for this app session even when browser storage is unavailable.
const fallback = new Map<string, boolean>();
export function subtitlesOffForTitle(mediaId: string): boolean {
  const id = key(mediaId);
  if (fallback.has(id)) return fallback.get(id)!;
  try { return localStorage.getItem(id) === '1'; } catch { return fallback.get(id) ?? false; }
}
export function rememberSubtitlesOff(mediaId: string, off: boolean) {
  const id = key(mediaId);
  try {
    if (off) localStorage.setItem(id, '1'); else localStorage.removeItem(id);
    fallback.delete(id);
  } catch { fallback.set(id, off); }
}

/** Subtitle timing offset (seconds) remembered per profile and title; release groups keep the same timing across episodes. */
const offsetKey = (mediaId: string) => `moa.subtitleOffset:${JSON.stringify([currentProfileId(), mediaId])}`;
export function subtitleOffsetForTitle(mediaId: string): number {
  try { const value = Number(localStorage.getItem(offsetKey(mediaId))); return Number.isFinite(value) ? value : 0; } catch { return 0; }
}
export function rememberSubtitleOffset(mediaId: string, seconds: number) {
  try { if (seconds) localStorage.setItem(offsetKey(mediaId), String(seconds)); else localStorage.removeItem(offsetKey(mediaId)); } catch { /* private mode */ }
}
