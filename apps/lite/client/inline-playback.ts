import { parseInlineHls } from '../../server/src/inline-hls.js';

const sessions = new Map<string, string[]>();
export function materializeInline(session: { sessionId: string; url: string; mime: string; originalUrl?: string; headers?: Record<string,string> }) {
  if (!session.url.startsWith('data:')) return;
  const { body, keys } = parseInlineHls(session.url);
  const urls: string[] = [];
  let playlist = body;
  try {
    for (const [raw, bytes] of keys) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
      urls.push(url); playlist = playlist.split(raw).join(url);
    }
    const url = URL.createObjectURL(new Blob([playlist], { type: 'application/vnd.apple.mpegurl' }));
    urls.push(url);
    releaseInline(session.sessionId); sessions.set(session.sessionId, urls);
    session.url = url; session.mime = 'application/vnd.apple.mpegurl';
    // The connector only installs direct-request header rules; it downloads no media.
    const first = body.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))!.trim();
    let declared: string | undefined;
    try { const url = new URL(session.originalUrl || ''); if (url.protocol === 'https:' && !url.username && !url.password) declared = url.href; } catch {}
    const headers = Object.fromEntries(Object.entries(session.headers ?? {}).filter(([name]) => declared || !['authorization','cookie'].includes(name.toLowerCase())));
    return { url: declared ?? first, playlist: body, headers };
  } catch (error) { urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
}
export function releaseInline(id: string) {
  sessions.get(id)?.forEach(url => URL.revokeObjectURL(url)); sessions.delete(id);
}
export function releaseAllInline() { for (const id of sessions.keys()) releaseInline(id); }
