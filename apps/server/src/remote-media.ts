import { ApiFailure } from './util.js';

/** Parse cue boundaries even when an extension removes blank lines while decrypting SRT. */
export function subtitleVtt(text: string) {
  const body=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trimStart();
  if(/^WEBVTT(?:\s|$)/.test(body))return body;
  const cues=[...body.matchAll(/^(?:\d+[ \t]*\n)?[ \t]*(\d{2}:\d{2}:\d{2}[,.]\d{3}[ \t]+-->[ \t]+\d{2}:\d{2}:\d{2}[,.]\d{3})[^\n]*\n/gm)];
  if(!cues.length)throw new ApiFailure(502,'unsupported-subtitle-format');
  return 'WEBVTT\n\n'+cues.map((cue,i)=>cue[1].replace(/,/g,'.')+'\n'+body.slice(cue.index!+cue[0].length,cues[i+1]?.index).trim()+'\n').join('\n');
}
/** Match the upstream fallback for opaque/signed HLS URLs. */
export function remoteMediaType(url: string) {
  if (url.startsWith('edl://')) return 'application/vnd.apple.mpegurl';
  return /\.mp4(?:\?|$)/i.test(url) ? 'video/mp4' : /\.webm(?:\?|$)/i.test(url) ? 'video/webm' : 'application/vnd.apple.mpegurl';
}
export function inlineSubtitle(file: string): {content: string; format: 'ass' | 'vtt'} {
  let content = file;
  if (file.startsWith('data:')) {
    const comma = file.indexOf(',');
    if (comma < 0) throw new ApiFailure(502, 'unsupported-subtitle-format');
    const data = file.slice(comma + 1);
    content = /;base64$/i.test(file.slice(0, comma))
      ? new TextDecoder().decode(Uint8Array.from(atob(data), ch => ch.charCodeAt(0))) : decodeURIComponent(data);
  }
  content = content.replace(/^\uFEFF/, '').trimStart();
  return /^\[Script Info\]/i.test(content) && /^\[Events\]/im.test(content)
    ? {content, format:'ass'} : {content:subtitleVtt(content), format:'vtt'};
}
