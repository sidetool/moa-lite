import { ApiFailure } from '../domain.js';

type Video = { url: string; quality?: string };
function https(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !/[\r\n]/.test(value)) return url.href;
  } catch { /* Invalid source URL. */ }
}

/** Conservative subset of the server EDL grammar: one whole, untyped stream.
 * mpv percent quoting counts UTF-8 bytes. Timing lengths, multiple segments,
 * track declarations and unknown directives must never be discarded. */
export function directVideoUrl(value: string): string | undefined {
  if (!value.startsWith('edl://')) return https(value);
  const data = new TextEncoder().encode(value.slice(6));
  if (!data.length || data.length > 2 * 1024 * 1024) return;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fields: string[] = [];
  let pos = 0;
  try {
    while (pos < data.length) {
      const begin = pos;
      while (pos < data.length && ![44, 59, 10].includes(data[pos])) {
        if (data[pos] === 37 && (pos === begin || /^(file|start|length)=$/.test(decoder.decode(data.slice(begin, pos))))) break;
        pos++;
      }
      let field = decoder.decode(data.slice(begin, pos));
      if (data[pos] === 37) {
        if (field && !/^(file|start|length)=$/.test(field)) return;
        const end = data.indexOf(37, pos + 1);
        if (end < 0) return;
        const raw = decoder.decode(data.slice(pos + 1, end));
        if (!/^\d+$/.test(raw)) return;
        const length = Number(raw); pos = end + 1;
        if (!Number.isSafeInteger(length) || length < 1 || pos + length > data.length) return;
        field += decoder.decode(data.slice(pos, pos + length)); pos += length;
      }
      fields.push(field);
      if (pos === data.length) break;
      if (data[pos] !== 44) {
        // A trailing separator is harmless, but another segment is not.
        if (data.slice(pos).every(byte => byte === 59 || byte === 10)) break;
        return;
      }
      pos++;
      if (pos === data.length) return;
    }
    const values: Record<string, string> = {};
    for (const [i, field] of fields.entries()) {
      const named = /^(file|start|length)=(.*)$/s.exec(field);
      const key = named?.[1] ?? ['file', 'start', 'length'][i];
      if (!key || key in values || (!named && i > 0 && field.includes('='))) return;
      values[key] = named ? named[2] : field;
    }
    if ('length' in values || ('start' in values && (!values.start.trim() || Number(values.start) !== 0))) return;
    return https(values.file);
  } catch { return; }
}

export function selectPlaybackStream<T extends Video>(videos: T[], requested?: string) {
  if (!videos.length) throw new ApiFailure(502, 'source-no-videos');
  const playable = videos.flatMap((video, index) => {
    const url = directVideoUrl(video.url);
    return url ? [{ item: { ...video, url }, id: String(index), label: video.quality || `서버 ${index + 1}` }] : [];
  });
  if (!playable.length) throw new ApiFailure(502, 'source-no-playable-video');
  const selected = requested === undefined ? playable[0] : playable.find(stream => stream.id === requested);
  if (!selected) throw new ApiFailure(502, 'playback-stream-unavailable');
  return { item: selected.item, streamId: selected.id, streams: playable.map(({ id, label }) => ({ id, label })) };
}
