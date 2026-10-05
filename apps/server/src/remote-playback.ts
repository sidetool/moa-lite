import { subtitleVtt, remoteMediaType } from './remote-media.js';
import { APK_RELAY } from './apk-bridge.js';
import { playbackMediaType } from './tmdb.js';
import { parseEdl, edlPlaylist, edlMaster } from './edl.js';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { publicStream, type SourceVideo } from '@moa/extensions';
import type { PlaybackSession, SubtitleTrack } from '@moa/shared';
import { Store } from './db.js';
import { Catalog } from './catalog.js';
import { Sources } from './sources.js';
import type { OnlineSubtitles } from './online.js';
import { ApiFailure } from './util.js';

const token = () => randomBytes(24).toString('base64url');
interface Asset { url: string; headers: Record<string,string>; subtitle?: 'ass' | 'vtt'; playlist?: string; subtitleText?: string }
interface RemoteSession { leaseLost?: boolean; renewAt?: number; renewing?: boolean; renewFailures?: number; apkLease?: string; proxy?: string; profile: string; touched: number; assets: Map<string,Asset>; reverse: Map<string,string>; abort: AbortController; response: PlaybackSession }
/** Rewrite every HLS URI (segments, variants, keys, maps, subtitles, low-latency parts). */
export function rewritePlaylist(body: string, base: string, map: (url: string) => string) {
  if (!body.trimStart().startsWith('#EXTM3U')) throw new ApiFailure(502, 'invalid-playlist');
  if (/#EXT-X-DEFINE|\{\$/.test(body)) throw new ApiFailure(502, 'unsupported-playlist-variables');
  return body.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return map(new URL(line.trim(), base).href);
    return line.replace(/\bURI="([^"]+)"/g, (_all, uri) => `URI="${map(new URL(uri, base).href)}"`);
  }).join('\n');
}
export class RemotePlayback {
  sessions = new Map<string,RemoteSession>();
  private timer: NodeJS.Timeout;
  constructor(private db: Store, private catalog: Catalog, private sources: Sources, private transport = publicStream, private online?: OnlineSubtitles, private clock = Date.now) {
    this.timer = setInterval(() => { void this.maintain(); }, 15_000); this.timer.unref();
  }
  async maintain() {
    const now = this.clock(), pending: Promise<void>[] = [];
    for (const [id,s] of this.sessions) {
      if (now - s.touched > (s.apkLease ? 3 : 30) * 60_000) { this.remove(id); continue; }
      if (!s.apkLease || s.leaseLost || s.renewing || now < (s.renewAt ?? 0)) continue;
      s.renewing = true;
      pending.push(this.sources.apk.renew(s.apkLease).then(() => {
        if (this.sessions.get(id) !== s) return;
        s.renewFailures = 0; s.renewAt = this.clock() + 45_000;
      }).catch(error => {
        if (this.sessions.get(id) !== s) return;
        if (error instanceof Error && /^(apk_lease_expired|apk_asset_not_found)$/.test(error.message)) s.leaseLost = true;
        // A transport timeout is not proof that the stream died. Keep serving it and retry control traffic.
        else { s.renewFailures = (s.renewFailures ?? 0) + 1; s.renewAt = this.clock() + Math.min(30_000, 5_000 * 2 ** Math.min(s.renewFailures, 3)); }
      }).finally(() => { s.renewing = false; }));
    }
    await Promise.all(pending);
  }
  heartbeat(id:string, profile:string) {
    const s=this.get(id,profile);
    if(s.leaseLost)throw new ApiFailure(409,'playback-restart-required');
  }
  get(id: string, profile?: string) { const s = this.sessions.get(id); if (!s) throw new ApiFailure(404, 'session-expired'); if (profile && profile !== s.profile) throw new ApiFailure(403, 'session-forbidden'); s.touched = this.clock(); return s; }
  remove(id: string) { const s = this.sessions.get(id); s?.abort.abort(); this.sessions.delete(id); return this.sources.apk?.release(s?.apkLease); }
  close() { clearInterval(this.timer); for (const id of this.sessions.keys()) this.remove(id); }
  private asset(id: string, s: RemoteSession, asset: Asset) {
    const u = new URL(asset.url);
    if (u.protocol !== 'https:' || u.username || u.password) throw new ApiFailure(502, 'unsupported-stream-url');
    const identity = JSON.stringify(asset); let key = s.reverse.get(identity);
    if (!key) {
      if (s.assets.size > 50_000) throw new ApiFailure(502, 'stream-asset-limit');
      key = token(); s.assets.set(key, asset); s.reverse.set(identity, key);
    }
    return `/api/playback/${id}/remote/${key}`;
  }
  private edl(id: string, s: RemoteSession, item: SourceVideo) {
    const headers = item.headers || {};
    const playlist = (body: string) => {
      const key = token(); s.assets.set(key, { url: '', headers: {}, playlist: body });
      return `/api/playback/${id}/remote/${key}`;
    };
    const streams = parseEdl(item.url);
    if (streams[0].type === 'audio' || streams.slice(1).some(t => t.type !== 'audio')) throw new ApiFailure(502, 'unsupported-edl-streams');
    const media = (stream: ReturnType<typeof parseEdl>[number]) => playlist(edlPlaylist(stream, url => this.asset(id,s,{ url, headers })));
    const audio = streams.slice(1).map((stream,i) => ({ url: media(stream), label: `Audio ${i+1}` }));
    for (const track of (item.audios || []).slice(0,16)) {
      if (!track.file.startsWith('edl://')) throw new ApiFailure(502, 'unsupported-edl-audio');
      const parsed = parseEdl(track.file);
      if (parsed.length !== 1 || parsed[0].type === 'video') throw new ApiFailure(502, 'unsupported-edl-audio');
      audio.push({ url: media(parsed[0]), label: track.label || 'Audio' });
    }
    return playlist(edlMaster(media(streams[0]), audio));
  }
  async create(profile: string, episodeId: string, startOverride?: number, requestedStream?: string): Promise<PlaybackSession> {
    const mapping = this.sources.remoteEpisode(episodeId);
    if (!mapping) throw new ApiFailure(404, 'episode-not-found');
    if ([...this.sessions.values()].filter(s => s.profile === profile).length >= 6) throw new ApiFailure(429, 'too-many-playback-sessions');
    const videos = await this.sources.videos(episodeId);
    try {
    if (!videos.length) throw new ApiFailure(502, 'no-streams');
    const index = requestedStream === undefined ? 0 : Number(requestedStream);
    if (!Number.isInteger(index) || index < 0 || index >= videos.length) throw new ApiFailure(400, 'invalid-stream');
    const item: SourceVideo = videos[index];
    const detail = this.catalog.detail(mapping.media_id, profile), source = this.sources.row(mapping.source_id);
    const ep = detail.seasons.flatMap(s => s.episodes).find(e => e.id === episodeId)!;
    const episodes = detail.seasons.flatMap(s => s.episodes), next = episodes[episodes.indexOf(ep) + 1];
    const live = Boolean(source.live), id = token();
    const state: RemoteSession = { apkLease: videos.apkLease, proxy: this.sources.proxy(), profile, touched: this.clock(), renewAt: this.clock()+45_000, assets: new Map(), reverse: new Map(), abort: new AbortController(), response: {} as PlaybackSession };
    const headers = item.headers || {};
    const mime = remoteMediaType(item.url);
    let inlineBytes=0;
    const subtitles: SubtitleTrack[] = (item.subtitles || []).slice(0,32).flatMap((track,i) => {
      if (typeof track?.file !== 'string' || !track.file) return [];
      if (!/^https:\/\//.test(track.file)) {
        const size=Buffer.byteLength(track.file);if(size>1024*1024 || inlineBytes+size>4*1024*1024)return [];
        let body=track.file.replace(/^\uFEFF/,'').trimStart();
        const format: 'ass'|'vtt' = /^\[Script Info\]/i.test(body) && /^\[Events\]/im.test(body) ? 'ass' : 'vtt';
        if(format==='vtt'&&!/^WEBVTT(?:\s|$)/.test(body)){
          if(!/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/m.test(body))return [];
          try { body=subtitleVtt(body); } catch { return []; }
        }
        inlineBytes+=size;const key=token();state.assets.set(key,{url:'',headers:{},subtitle:format,subtitleText:body});
        return [{id:`extension-${i}`,label:track.label||`자막 ${i+1}`,lang:/한국|korean|\bko\b/i.test(track.label)?'ko':undefined,format,source:'extension',url:`/api/playback/${id}/remote/${key}`}];
      }
      const format = /\.(ass|ssa)(?:\?|$)/i.test(track.file) ? 'ass' : 'vtt';
      // HLS subtitle renditions are handled by hls.js, not a standalone <track>.
      if (/\.m3u8(?:\?|$)/i.test(track.file)) return [];
      return [{ id: `extension-${i}`, label: track.label || `자막 ${i+1}`, lang: /한국|korean|\bko\b/i.test(track.label) ? 'ko' : undefined, format, source: 'extension', url: this.asset(id,state,{ url: track.file, headers, subtitle: format }) }];
    });
    const saved = this.online?.saved(episodeId) || [];
    subtitles.unshift(...saved.map((row,i) => ({ ...this.online!.track(row, `/api/playback/${id}/subtitles/${row.id}.${row.format}`), default: i === 0 })));
    state.response = { ...(videos.apkLease ? { runtimeDependent: true } : {}), sessionId: id, episodeId, mediaId: detail.id, mediaTitle: detail.title, mediaType: playbackMediaType(this.db, detail.id, detail.type), episodeTitle: ep.title, ...(live || detail.type === 'movie' ? {} : { episodeLabel: `S${ep.season}:E${ep.number}` }), live, streams: videos.map((v,i) => ({ id: String(i), label: v.quality || `서버 ${i+1}` })), streamId: String(index), mode: 'direct', mime, url: item.url.startsWith('edl://') ? this.edl(id,state,item) : this.asset(id,state,{ url: item.url, headers }), duration: ep.duration || 0, startPosition: live ? 0 : startOverride ?? (ep.progress?.completed ? 0 : ep.progress?.position || 0), subtitles, audioTracks: [], next: !live && next ? { episodeId: next.id, title: detail.title, label: next.title, thumb: next.thumb } : null };
    this.sessions.set(id,state); return state.response;
    } catch(error) { this.sources.apk?.release(videos.apkLease); throw error; }
  }
  savedSubtitle(id: string, track: string, profile?: string) {
    const s = this.get(id,profile);
    const sub = s.response.subtitles.find(t => t.source === 'online' && `${t.id}.${t.format}` === track);
    if (!sub) throw new ApiFailure(404,'subtitle-not-found');
    return this.online!.content(s.response.episodeId,sub.id,undefined,s.profile);
  }
  async proxy(req: FastifyRequest, reply: FastifyReply, id: string, assetId: string) {
    const s = this.get(id,req.moaProfile);
    if(s.leaseLost)throw new ApiFailure(410,'playback-restart-required');
    const asset = s.assets.get(assetId);
    if (!asset) throw new ApiFailure(404,'asset-not-found');
    if(asset.subtitleText!==undefined)return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type(asset.subtitle==='ass'?'text/x-ssa; charset=utf-8':'text/vtt; charset=utf-8').send(asset.subtitleText);
    if (asset.playlist) return reply.header('Cache-Control','private, no-store').type('application/vnd.apple.mpegurl').send(asset.playlist);
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) return reply.code(416).send();
    const abort = new AbortController(), signal = AbortSignal.any([s.abort.signal,abort.signal]);
    const close = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close',close);
    let upstream: Awaited<ReturnType<typeof publicStream>>;
    try { upstream = new URL(asset.url).origin === APK_RELAY ? await this.sources.apk.stream(asset.url,s.apkLease,req.headers.range,signal) : await this.transport(asset.url, { ...asset.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) },signal,s.proxy); }
    catch { reply.raw.off('close',close); throw new ApiFailure(502,'stream-unavailable'); }
    const { response, url } = upstream, status = response.statusCode || 502;
    if (![200,206].includes(status)) { response.destroy(); reply.raw.off('close',close); return reply.code(status === 416 ? 416 : 502).send({ error: 'stream-unavailable' }); }
    const type = String(response.headers['content-type'] || '');
    const playlist = /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(url);
    reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
    if (playlist || asset.subtitle) {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response) { size += chunk.length; if (size > (playlist ? 2 : 8) * 1024 * 1024) throw new Error('asset-limit'); chunks.push(Buffer.from(chunk)); }
        let body = Buffer.concat(chunks).toString('utf8');
        if (playlist) body = rewritePlaylist(body,url,target => {
          const headers = { ...asset.headers };
          if (new URL(target).origin !== new URL(asset.url).origin) { for (const key of Object.keys(headers)) if (/^(authorization|cookie)$/i.test(key)) delete headers[key]; }
          return this.asset(id,s,{ url: target, headers });
        });
        else if (asset.subtitle === 'vtt' && !body.trimStart().startsWith('WEBVTT')) {
          body = subtitleVtt(body);
        }
        return reply.type(playlist ? 'application/vnd.apple.mpegurl' : asset.subtitle === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8').send(body);
      } finally { response.destroy(); reply.raw.off('close',close); }
    }
    for (const name of ['content-length','content-range','accept-ranges']) if (response.headers[name]) reply.header(name,response.headers[name]);
    // Do not serve provider HTML/script under MOA's origin.
    reply.type(/^(video|audio)\//.test(type) ? type : 'application/octet-stream');
    response.once('close',() => reply.raw.off('close',close));
    return reply.code(status).send(response);
  }
}
