/** A bounded subset of data URLs for extension-generated finite HLS media playlists. */
export const INLINE_HLS_LIMIT = 512 * 1024;
/** Admit only the subset that the playback adapter can safely serve. */
export function isInlineHls(url: string): boolean {
  if (!url.startsWith('data:')) return false;
  try { parseInlineHls(url); return true; } catch { return false; }
}
const fail = (): never => { throw new Error('unsupported-inline-hls'); };
function decode(url: string, mime: string, limit: number): Uint8Array {
  const prefix = `data:${mime};base64,`;
  const normalized = url.replace(/^data:\/\//, 'data:');
  if (!normalized.startsWith(prefix) || normalized.length > prefix.length + Math.ceil(limit / 3) * 4) return fail();
  const value = normalized.slice(prefix.length);
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail();
  const binary = atob(value);
  if (binary.length > limit || btoa(binary) !== value) return fail();
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return bytes;
}
export function parseInlineHls(url: string): { body: string; keys: Map<string, Uint8Array> } {
  const bytes = decode(url, 'application/vnd.apple.mpegurl', INLINE_HLS_LIMIT);
  let body: string;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(); }
  if (!body.startsWith('#EXTM3U\n') && !body.startsWith('#EXTM3U\r\n')) return fail();
  if (!/^#EXT-X-ENDLIST\s*$/m.test(body) || !/^#EXTINF:/m.test(body) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) return fail();
  if (/#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF|MEDIA:|SESSION-|DEFINE|PART|PRELOAD-HINT|RENDITION-REPORT)|\{\$/.test(body)) return fail();
  const keys = new Map<string, Uint8Array>(); let segments = 0;
  const external = (value: string) => {
    let target: URL; try { target = new URL(value); } catch { return fail(); }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || value.length > 16_384) return fail();
  };
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.startsWith('#')) { external(line.trim()); if (++segments > 10_000) return fail(); continue; }
    const uris = [...line.matchAll(/\bURI="([^"]+)"/g)];
    if (/\bURI\s*=/.test(line) && uris.length !== 1) return fail();
    if (line.startsWith('#EXT-X-KEY:')) {
      if (/^#EXT-X-KEY:METHOD=NONE\s*$/.test(line)) continue;
      if (!/(?:^|[:,])METHOD=AES-128(?:,|$)/.test(line) || uris.length !== 1 || /KEYFORMAT/.test(line)) return fail();
      const value = uris[0][1]; const key = decode(value, 'application/octet-stream', 16);
      if (key.length !== 16) return fail();
      keys.set(value, key); if (keys.size > 32) return fail();
    } else for (const [, value] of uris) { external(value); }
  }
  if (!segments) return fail();
  return { body, keys };
}
