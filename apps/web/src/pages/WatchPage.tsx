import { preparePlayback, retirePlayback } from '../player/session-lifecycle';
import { subtitlesOffForTitle, rememberSubtitlesOff, subtitleOffsetForTitle, rememberSubtitleOffset } from "../player/subtitle-preference";
import { enterFullscreen } from "../lib/playback-fullscreen";
import { devicePrefs, setDevicePref } from "../lib/device-prefs";
import { isRemoteMode, type RemotePlayerEvent } from "../lib/remote";
import { PlaybackSources } from '../components/PlaybackSources';
import {
  ArrowLeft, Captions, Check, ChevronLeft, ChevronRight, CloudDownload, ExternalLink, FastForward, Pencil, Search, ListVideo, Maximize, Minimize, Pause, PictureInPicture2,
  Play, Rewind, RotateCcw, RotateCw, Settings, Shuffle, SkipForward, SlidersHorizontal, Volume1, Volume2, VolumeX, X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { OnlineSubtitleQuery, OnlineSubtitleSearch, PlaybackSession, SubtitleTrack } from "@moa/shared";
import { useMe, useMedia, useSettings } from "../api/queries";
import { cancelTranslationJob, coveredUntil, isTranslationTrack, savedTranslations, translationModeOf, untranslatedGap, useTranslationConfig, type TranslatedRange, type TranslationJob } from "../api/translation";
import { useSubtitleTranslation } from "../player/subtitle-translation";
import { hasUnlabelledSiteSubtitle } from "../player/subtitle-language";
import { useJimakuSearch } from "../player/jimaku";
import { isKorean, TranslationEntry, TranslationOfferCard, TranslationView } from "../player/TranslationPanel";
import { rememberAuto, useTranslationAutopilot } from "../player/translation-autopilot";
import { trackName } from "../player/track-name";
import { Stepper } from "../player/Stepper";
import { Artwork } from "../components/Artwork";
import { Button, ProgressBar, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";

const KIDS_RESTRICTED = "어린이 프로필에서는 볼 수 없는 작품이에요";
import { clock, cx, episodeTitle } from "../lib/format";
import { attach, detectCapabilities, compatibilityPlayback, setCompatibilityPlayback, SubtitleController, type EngineHandle, type SubtitleAppearance } from "../player/engine";

type Panel = null | "subs" | "settings" | "episodes";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_AFTER = 2600;
const VOLUME_KEY = "moa.volume";
/** Longest a newer translation revision waits for a quiet moment (no translated cue on screen). */
const REVISION_MAX_WAIT = 45_000;

function useSession(episodeId: string, startOverride: number | null) {
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [streamId, setStreamId] = useState<string | undefined>();
  const [compatible, setCompatible] = useState(compatibilityPlayback);
  const [audioTrackId, setAudioTrackId] = useState<string | undefined>();
  const resumeAt = useRef<number | null>(startOverride);

  useEffect(() => {
    let cancelled = false;
    let created: PlaybackSession | null = null;
    setError(null);
    preparePlayback(async () => {
      if (cancelled) return;
      const result = await api<PlaybackSession>("/playback", {
        method: "POST",
        body: { episodeId, capabilities: detectCapabilities(compatible), audioTrackId, streamId, ...(resumeAt.current !== null ? { startPosition: resumeAt.current } : {}) }
      });
      created = result;
      if (cancelled) await retirePlayback(result.sessionId, result.runtimeDependent);
      else setSession(result);
    }).catch(e => { if (!cancelled) setError(e instanceof ApiError && e.code === "kids-restricted" ? KIDS_RESTRICTED : import.meta.env.VITE_MOA_LITE === '1' && e instanceof ApiError && e.code === 'source_browser_unavailable' ? '이 소스는 WebView 실행이 필요해 moa-lite에서 지원하지 않아요.' : import.meta.env.VITE_MOA_LITE === '1' && e instanceof ApiError && e.code === 'playback-stream-unavailable' ? '선택한 서버를 재생할 수 없어요. 다시 시도하면 서버를 자동 선택해요.' : import.meta.env.VITE_MOA_LITE === '1' && e instanceof ApiError && ['source-no-videos', 'source-no-playable-video'].includes(e.code) ? '이 회차에서 재생할 수 있는 영상을 찾지 못했어요. 소스 설정을 확인하거나 다른 소스를 선택해 주세요.' : import.meta.env.VITE_MOA_LITE === '1' && e instanceof ApiError && ['source-invalid-response', 'source-video-extraction-failed'].includes(e.code) ? '소스에서 재생 가능한 영상을 찾지 못했어요. 다른 소스를 선택해 주세요.' : e instanceof ApiError && e.code === "apk_playback_capacity" ? "다른 기기에서 재생 중입니다. 재생이 끝난 뒤 다시 시도해 주세요." : "재생을 준비하지 못했습니다."); });
    return () => {
      cancelled = true;
      if (created) void retirePlayback(created.sessionId, created.runtimeDependent);
    };
  }, [episodeId, audioTrackId, streamId, compatible, attempt]);

  const switchAudio = (id: string, at: number) => { resumeAt.current = at; setSession(null); setAudioTrackId(id); };
  const switchStream = (id: string, at: number) => { resumeAt.current = at; setSession(null); setStreamId(id); };
  const switchCompatibility = (value: boolean, at: number) => { resumeAt.current = at; setCompatibilityPlayback(value); setSession(null); setCompatible(value); };
  const retry = (at: number) => { resumeAt.current = at; setSession(null); if (import.meta.env.VITE_MOA_LITE === '1' && error) setStreamId(undefined); setAttempt(n => n + 1); };
  return { retry, session, error, switchAudio, audioTrackId, switchStream, compatible, switchCompatibility };
}

/** Page zoom never helps while watching and turns double-tap seeks into zoom toggles. */
const SKIP_VISIBLE_MS = 5000;

function useNoPageZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    meta.content = `${original},maximum-scale=1,user-scalable=no`;
    return () => { meta.content = original; };
  }, []);
}

export function WatchPage() {
  useNoPageZoom();
  const { episodeId = "" } = useParams();
  const fullscreenHost = useRef<HTMLDivElement>(null);
  // The fullscreen target survives episode changes; only playback state resets.
  return <div className="watch-fullscreen-host" ref={fullscreenHost}><WatchPlayer key={episodeId} episodeId={episodeId} fullscreenHost={fullscreenHost} /></div>;
}

function WatchPlayer({ episodeId, fullscreenHost }: { episodeId: string; fullscreenHost: RefObject<HTMLDivElement | null> }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const settings = useSettings().data;
  const t = params.get("t");
  const { retry, session, error: sessionError, switchAudio, audioTrackId, switchStream, compatible, switchCompatibility } = useSession(episodeId, t === null ? null : Number(t));
  const media = useMedia(session?.mediaId ?? "");

  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<EngineHandle | null>(null);
  const subs = useRef<SubtitleController | null>(null);
  const hideTimer = useRef<number>(0);
  const lastSaved = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(VOLUME_KEY) ?? 1));
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanelState] = useState<Panel>(null);
  const [subsView, setSubsView] = useState<"main" | "style" | "search" | "translate">("main");
  const [subQuery, setSubQuery] = useState<OnlineSubtitleQuery | null>(null);
  const setPanel = (next: Panel) => { setPanelState(next); setSubsView("main"); };
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [sourcePicker,setSourcePicker] = useState(false);
  const runtimeRecoveries = useRef(0);
  const resumePlaying = useRef<boolean | null>(null);
  const failPlayback = useRef<(message:string)=>void>(()=>{});
  const [fatal, setFatal] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(null);
  const [resumeChip, setResumeChip] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ key: number; side: "left" | "right" | "center"; label: string } | null>(null);
  const [prefs] = useState(devicePrefs);
  const step = prefs.seekStep;
  const [boost, setBoost] = useState(false);
  const [ended, setEnded] = useState(false);
  const [levels, setLevels] = useState<Array<{ index: number; height: number }>>([]);
  const [level, setLevel] = useState(-1);
  const [subOffset, setSubOffset] = useState(0);
  const subOffsetRef = useRef(0);
  const [subHeight, setSubHeight] = useState(() => { try { const saved=localStorage.getItem('moa.subtitleHeight'); return saved === null ? 8 : Math.max(0,Math.min(30,Number(saved) || 0)); } catch { return 8; } });
  const changeSubHeight = (value:number) => { setSubHeight(value); try { localStorage.setItem('moa.subtitleHeight',String(value)); } catch {} };
  useEffect(() => { subs.current?.setHeight(subHeight); },[subHeight,subtitle,session]);
  const [appearance, setAppearance] = useState<SubtitleAppearance | null>(() => {
    try { const value = JSON.parse(localStorage.getItem('moa.subtitleAppearance') || 'null');
      return value && ['small','medium','large','xlarge'].includes(value.size) && ['original','none','soft','solid'].includes(value.background) ? value : null;
    } catch { return null; }
  });
  const subSize = appearance?.size ?? settings?.subtitleSize ?? 'medium';
  const subBackground = appearance?.background ?? 'original';
  const changeAppearance = (patch: Partial<SubtitleAppearance>) => {
    const value = { size: subSize, background: subBackground, ...patch };
    setAppearance(value); try { localStorage.setItem('moa.subtitleAppearance', JSON.stringify(value)); } catch {}
  };
  useEffect(() => { void subs.current?.setAppearance({size:subSize,background:subBackground}).catch(() => {}); }, [subSize,subBackground,subtitle,session]);
  const [extraSubs, setExtraSubs] = useState<SubtitleTrack[]>([]);
  const [online, setOnline] = useState<{ status: "idle" | "searching" | "done" | "error"; result?: OnlineSubtitleSearch; applying?: string }>({ status: "idle" });
  const [notice, setNotice] = useState<string | { text: string; action: { label: string; run: () => void } } | null>(null);
  const onlineAbort = useRef<AbortController | null>(null);
  const applyAbort = useRef<AbortController | null>(null);
  const subtitleChoice = useRef(0);
  const initializedSubtitles = useRef<PlaybackSession | null>(null);

  useEffect(()=>{if(sourcePicker) video.current?.pause();},[sourcePicker]);
  const live = session?.live || false;
  const total = live ? 0 : Number.isFinite(duration) && duration > 0 ? duration : session?.duration || 0;
  const titleLine = session ? [session.mediaTitle, session.episodeLabel && `${session.episodeLabel}${session.episodeTitle ? ` ${episodeTitle(session.episodeTitle)}` : ""}`].filter(Boolean) : [];

  /* ---------- progress ---------- */
  const saveProgress = useCallback((keepalive = false) => {
    const v = video.current;
    if (!session || session.live || !v || !Number.isFinite(v.duration) || !v.duration || v.currentTime < 1) return;
    lastSaved.current = v.currentTime;
    void api("/progress", { method: "POST", body: { episodeId: session.episodeId, position: v.currentTime, duration: v.duration || session.duration }, keepalive }).catch(() => {});
  }, [session]);

  /* ---------- attach ---------- */
  useEffect(() => {
    const v = video.current;
    if (!session || !v) return;
    let disposed = false;
    let advancedStream = false;
    setFatal(null); setEnded(false); setNextDismissed(false); setCountdown(null); setWaiting(true);

    const start = session.startPosition;
    setResumeChip(start > 30 && t === null);
    const onFailure = (message:string) => {
      if (disposed || advancedStream) return;
      if (session.runtimeDependent && runtimeRecoveries.current < 1) {
        advancedStream = true; runtimeRecoveries.current++;
        resumePlaying.current = v.readyState === 0 || !v.paused;
        setNotice("재생 연결을 복구하고 있습니다.");
        retry(session.live ? 0 : v.currentTime || start);
        return;
      }
      const streamIndex = session.streams?.findIndex(stream => stream.id === session.streamId) ?? -1;
      const next = streamIndex >= 0 ? session.streams?.[streamIndex + 1] : undefined;
      if (next) {
        advancedStream = true;
        setNotice("다른 재생 서버에 연결하고 있습니다.");
        switchStream(next.id, session.live ? 0 : v.currentTime || start);
      } else setFatal(message);
    };
    failPlayback.current = onFailure;
    attach(v, session, start, onFailure).then(handle => {
      if (disposed) { handle.destroy(); return; }
      engine.current = handle;
      v.volume = volume;
      v.playbackRate = speed;
      const shouldPlay = resumePlaying.current !== false; resumePlaying.current = null;
      if (shouldPlay) v.play().catch(() => setPlaying(false)); else setPlaying(false);
    }).catch(() => { if(!disposed) onFailure("이 영상을 재생하지 못했습니다."); });
    subs.current = new SubtitleController(v, session.fonts);
    subs.current.setHeight(subHeight);
    void subs.current.setAppearance({size:subSize,background:subBackground}).catch(()=>{});
    return () => {
      disposed = true;
      failPlayback.current = ()=>{};
      saveProgress(true);
      engine.current?.destroy();
      engine.current = null;
      subs.current?.destroy();
      subs.current = null;
      void client.invalidateQueries({ queryKey: ["home"] });
      void client.invalidateQueries({ queryKey: ["media", session.mediaId] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session?.runtimeDependent) return;
    let disposed = false, pending = false;
    const abort = new AbortController();
    const heartbeat = async () => {
      if (disposed || pending) return;
      pending = true;
      try { await api(`/playback/${session.sessionId}/heartbeat`, { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) }); }
      catch (error) {
        if (!disposed && error instanceof ApiError && ['session-expired','playback-restart-required'].includes(error.code))
          failPlayback.current('재생 연결이 만료되었습니다. 다시 연결해 주세요.');
      } finally { pending = false; }
    };
    const visible = () => { if (!document.hidden) void heartbeat(); };
    const leaving = (event: PageTransitionEvent) => { if (!event.persisted) void retirePlayback(session.sessionId, session.runtimeDependent); };
    void heartbeat(); const timer = window.setInterval(() => void heartbeat(), 30_000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible); window.addEventListener('pageshow', visible); window.addEventListener('pagehide', leaving);
    return () => {
      disposed = true; abort.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible); window.removeEventListener('pageshow', visible); window.removeEventListener('pagehide', leaving);
    };
  }, [session]);

  useEffect(() => {
    if (!session || !settings || initializedSubtitles.current === session) return;
    initializedSubtitles.current = session;
    if (subtitleChoice.current) {
      // A new playback session revokes embedded subtitle URLs from the old one.
      setSubtitle(current => current ? session.subtitles.find(track => track.id === current.id) ?? (current.provenance || isTranslationTrack(current) ? current : null) : null);
      return;
    }
    const preferred = settings.defaultSubtitleLang;
    // Saved AI translations are listed but only shown when the viewer picks them.
    const own = session.subtitles.filter(track => !isTranslationTrack(track));
    setSubtitle(subtitlesOffForTitle(session.mediaId) || preferred === "off" ? null
      : own.find(track => track.lang === preferred) ?? own.find(track => track.default) ?? own[0] ?? null);
  }, [session, settings]);

  const shownTrack = useRef<{ controller: SubtitleController | null; track: SubtitleTrack | null }>({ controller: null, track: null });
  useEffect(() => {
    const controller = subs.current;
    let cancelled = false;
    const previous = shownTrack.current;
    shownTrack.current = { controller, track: subtitle };
    // A newer revision of the same track (live AI translation) is swapped in place instead of reloaded.
    const revision = Boolean(controller && subtitle && previous.controller === controller && previous.track?.id === subtitle.id);
    if (revision && previous.track!.url === subtitle!.url) return;
    const load = revision ? controller!.replace(subtitle!).catch(() => controller!.show(subtitle)) : controller?.show(subtitle);
    void load?.then(() => {
      if (!cancelled) controller!.setOffset(subOffsetRef.current);
    }).catch(() => { if (!cancelled) setNotice("자막을 불러오지 못했습니다. 다른 자막을 선택해 주세요."); });
    return () => { cancelled = true; };
  }, [subtitle, session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if(!session?.streams?.length || !waiting || fatal) return;
    const timer=window.setInterval(()=>{const v=video.current;if(v && !document.hidden && (!v.paused || v.readyState===0)) failPlayback.current('영상 응답이 지연되고 있습니다. 다시 연결해 주세요.');},45_000);
    return ()=>clearInterval(timer);
  },[session,waiting,fatal]);

  /* ---------- online Korean subtitles ---------- */
  const allSubs = useMemo(() => {
    const list = session?.subtitles ?? [];
    return [...list, ...extraSubs.filter(extra => !list.some(track => track.id === extra.id))];
  }, [session, extraSubs]);
  const searchOnline = useCallback(async (manual?: OnlineSubtitleQuery) => {
    if (!session) return null;
    onlineAbort.current?.abort();
    const controller = new AbortController();
    onlineAbort.current = controller;
    setOnline({ status: "searching" });
    try {
      const params = manual ? `?${new URLSearchParams({ title: manual.title.trim(), season: String(manual.season), episode: String(manual.episode), episodeOffset: String(manual.episodeOffset) })}` : "";
      const result = await api<OnlineSubtitleSearch>(`/episodes/${encodeURIComponent(session.episodeId)}/subtitles/online${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      setOnline({ status: "done", result });
      return result;
    } catch {
      if (!controller.signal.aborted) setOnline({ status: "error" });
      return null;
    }
  }, [session]);
  const applyOnline = useCallback(async (result: OnlineSubtitleSearch, candidateId: string, quiet = false, choice = subtitleChoice.current) => {
    if (!session) return;
    if (quiet && subtitleChoice.current !== choice) return;
    if (!quiet) choice = ++subtitleChoice.current;
    applyAbort.current?.abort();
    const controller = new AbortController();
    applyAbort.current = controller;
    setOnline(state => ({ ...state, applying: candidateId }));
    try {
      const track = await api<SubtitleTrack>(`/episodes/${encodeURIComponent(session.episodeId)}/subtitles/online`, { method: "POST", body: { searchId: result.searchId, candidateId }, signal: controller.signal });
      if (controller.signal.aborted || subtitleChoice.current !== choice) return;
      setExtraSubs(list => [...list.filter(item => item.id !== track.id), track]);
      setSubtitle(track);
      if (!quiet) rememberSubtitlesOff(session.mediaId, false);
      const who = track.provenance?.creatorName ?? result.candidates.find(item => item.id === candidateId)?.creatorName;
      setNotice(quiet ? `${who ? `${who} 님의 ` : ""}한국어 자막을 찾아 적용했어요` : null);
    } catch {
      if (!controller.signal.aborted) setNotice("자막을 적용하지 못했습니다");
    } finally {
      if (applyAbort.current === controller) setOnline(state => ({ ...state, applying: undefined }));
    }
  }, [session]);

  useEffect(() => {
    // Translations belong to the episode, not the playback session, so they survive audio/stream switches.
    setExtraSubs(list => list.filter(isTranslationTrack)); setOnline({ status: "idle" }); setNotice(null);
    return () => { onlineAbort.current?.abort(); applyAbort.current?.abort(); };
  }, [session]);

  // Translation modes wait for the online Korean search to finish (found and applied, or not).
  const [onlineSettled, setOnlineSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!session || !settings) return;
    const settle = () => setOnlineSettled(session.sessionId);
    if (session.mediaType !== "anime" || !settings.autoFetchSubtitles || settings.defaultSubtitleLang === "off") return settle();
    if (subtitleChoice.current || subtitlesOffForTitle(session.mediaId)) return settle();
    if (session.subtitles.some(isKorean) || (settings.skipSubtitleSearchWithSiteTrack !== false && hasUnlabelledSiteSubtitle(session.subtitles))) return settle();
    let cancelled = false;
    const choice = subtitleChoice.current;
    void searchOnline().then(async result => {
      const best = result?.candidates.slice().sort((a, b) => b.confidence - a.confidence)[0];
      if (!cancelled && result && result.autoApply !== false && best && best.confidence >= 0.5) await applyOnline(result, best.id, true, choice);
    }).finally(() => { if (!cancelled) settle(); });
    return () => { cancelled = true; onlineAbort.current?.abort(); };
  }, [session, settings?.autoFetchSubtitles, settings?.defaultSubtitleLang, settings?.skipSubtitleSearchWithSiteTrack, searchOnline, applyOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- AI translation ---------- */
  const translationConfig = useTranslationConfig().data;
  const translationEnabled = Boolean(translationConfig?.configured && translationConfig.enabled);
  const admin = useMe().data?.role === "admin";
  // Choice counter when a translation started; null for a job resumed from an earlier visit, -1 once the viewer moved on.
  const translationChoice = useRef<number | null>(null);
  // The live revision on screen (its translated cue times) and a newer one waiting for a quiet moment.
  const liveShown = useRef<{ id: string; ranges: TranslatedRange[] } | null>(null);
  const pendingRevision = useRef<{ track: SubtitleTrack; ranges: TranslatedRange[]; since: number } | null>(null);
  const showTranslated = (track: SubtitleTrack) => {
    if (session) rememberSubtitlesOff(session.mediaId, false);
    applyAbort.current?.abort();
    setSubtitle(track);
  };
  /** Swap in a waiting revision when no translated cue of the current one can be on screen (or it waited too long). */
  const swapRevision = () => {
    const next = pendingRevision.current, v = video.current;
    if (!next) return;
    const shown = liveShown.current;
    const quiet = !shown || !v || v.paused || coveredUntil(shown.ranges, v.currentTime) === null;
    if (!quiet && Date.now() - next.since < REVISION_MAX_WAIT) return;
    pendingRevision.current = null;
    liveShown.current = { id: next.track.id, ranges: next.ranges };
    setSubtitle(current => current?.id === next.track.id ? next.track : current);
  };
  const onTranslationTrack = (track: SubtitleTrack, job: TranslationJob) => {
    if (!job.partial) setCompleteTranslations(ids => ids.has(track.id) ? ids : new Set(ids).add(track.id));
    setExtraSubs(list => list.some(item => item.id === track.id) ? list.map(item => item.id === track.id ? track : item) : [...list, track]);
    const final = job.state === "completed";
    if (subtitle?.id === track.id) {
      // Already on screen: newer cues arrive without taking over anything else.
      pendingRevision.current = { track, ranges: job.translatedRanges, since: Date.now() };
      swapRevision();
      if (final && !job.cached) setNotice("AI 번역을 마쳤어요");
      return;
    }
    const startedAt = translationChoice.current;
    // Apply only if the viewer has not picked another subtitle (or turned them off) since the translation started.
    const untouched = startedAt === -1 ? false : startedAt !== null ? subtitleChoice.current === startedAt : subtitleChoice.current === 0 && !(session && subtitlesOffForTitle(session.mediaId));
    if (untouched && (job.state === "running" || job.state === "queued" || final)) {
      liveShown.current = { id: track.id, ranges: job.translatedRanges };
      pendingRevision.current = null;
      showTranslated(track);
      if (final) setNotice(`AI 번역 자막을 적용했어요${job.cached ? " · 저장된 번역" : ""}`);
    } else {
      translationChoice.current = -1;
      if (final) setNotice({ text: "한국어 AI 번역이 끝났어요", action: { label: "적용", run: () => chooseSubtitle(track) } });
    }
  };
  const translation = useSubtitleTranslation(episodeId, onTranslationTrack);
  const jimaku = useJimakuSearch(episodeId);
  const startTranslation = (source: Parameters<typeof translation.start>[0], origin: "manual" | "auto" = "manual") => {
    translationChoice.current = origin === "auto" ? subtitleChoice.current : ++subtitleChoice.current;
    const v = video.current;
    return translation.start(source, { origin, startAt: v && !live ? v.currentTime || session?.startPosition || 0 : 0 });
  };
  const cancelTranslation = () => {
    // A cancelled episode is never restarted automatically in this tab.
    rememberAuto(episodeId, "cancelled");
    pendingRevision.current = null;
    return translation.cancel();
  };
  const liveJob = translation.state.status === "active" ? translation.state.job : null;
  const autoJob = (translation.state.status === "active" || translation.state.status === "reading") && translation.state.origin === "auto";
  // Leaving the episode stops a translation the player started on its own; partial cues stay cached for next time.
  const leaving = useRef({ autoJob, jobId: liveJob?.id, forget: translation.forget });
  leaving.current = { autoJob, jobId: liveJob?.id, forget: translation.forget };
  useEffect(() => () => {
    const { autoJob, jobId, forget } = leaving.current;
    if (!autoJob || !jobId) return;
    forget();
    rememberAuto(episodeId, "started");
    void cancelTranslationJob(jobId, true).catch(() => {});
  }, [episodeId]);

  // Saved translations: listed always; reused automatically only by the ask/auto modes below.
  // Only finished translations may be reused: the saved list (server returns complete ones only) and jobs with
  // partial=false. Partial tracks left after a failure or cancel are listed but never reused automatically.
  const [completeTranslations, setCompleteTranslations] = useState<Set<string>>(() => new Set());
  const [savedLoaded, setSavedLoaded] = useState(false);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void savedTranslations(session.episodeId, controller.signal).then(tracks => {
      if (!controller.signal.aborted && tracks.length) setCompleteTranslations(ids => new Set([...ids, ...tracks.map(track => track.id)]));
      if (!controller.signal.aborted && tracks.length) setExtraSubs(list => [...list.filter(item => !tracks.some(track => track.id === item.id)), ...tracks]);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setSavedLoaded(true); });
    return () => controller.abort();
  }, [session?.episodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const translationMode = translationModeOf(settings);
  const ownTracks = useMemo(() => session?.subtitles.filter(track => !isTranslationTrack(track)) ?? [], [session]);
  const savedTrack = useMemo(() => allSubs.find(track => isTranslationTrack(track) && completeTranslations.has(track.id)) ?? null, [allSubs, completeTranslations]);
  const autopilot = useTranslationAutopilot({
    episodeId,
    mode: translationMode,
    sourcePriority: settings?.translationSourcePriority ?? "site",
    enabled: translationEnabled,
    ready: Boolean(session && !session.live && settings && translationConfig && savedLoaded && onlineSettled === session.sessionId),
    // No separate track can mean burned-in subtitles; this guard also prevents a Jimaku offer/search.
    // Manual translation remains available through TranslationView.
    skip: !settings || settings.defaultSubtitleLang !== "ko" || Boolean(session && subtitlesOffForTitle(session.mediaId))
      || (settings.skipSubtitleSearchWithSiteTrack !== false && hasUnlabelledSiteSubtitle(ownTracks))
      || (settings.skipTranslationWithoutSubtitles !== false && ownTracks.length === 0),
    hasKorean: ownTracks.some(isKorean) || Boolean(subtitle && isKorean(subtitle)),
    saved: savedTrack,
    tracks: ownTracks,
    current: subtitle,
    userChose: subtitleChoice.current !== 0,
    busy: translation.busy,
    jimaku: jimaku.state,
    searchJimaku: () => void jimaku.search(),
    start: (source, origin) => {
      void startTranslation(source, origin);
      if (origin === "auto") setNotice({ text: `한국어 자막이 없어 ${source.label} 자막을 AI로 번역하고 있어요`, action: { label: "취소", run: () => void cancelTranslation() } });
    },
    useSaved: track => { showTranslated(track); setNotice("저장된 AI 번역 자막을 적용했어요"); }
  });
  // A suggestion steps aside after a while; the subtitle menu keeps offering translation.
  useEffect(() => {
    if (!autopilot.offer) return;
    let timer = 0;
    const expire = () => {
      if (root.current?.querySelector(".translate-offer:focus-within")) timer = window.setTimeout(expire, 25_000);
      else autopilot.hide();
    };
    timer = window.setTimeout(expire, 25_000);
    return () => clearTimeout(timer);
  }, [autopilot.offer, autopilot.hide]);
  // Pending revision / "translating here" hint while the live track is on screen.
  const showingLive = Boolean(liveJob?.track && subtitle?.id === liveJob.track.id);
  const translatingHere = showingLive && !live && untranslatedGap(liveJob!.translatedRanges, time, total);

  const chooseSubtitle = (track: SubtitleTrack | null) => {
    if (session) rememberSubtitlesOff(session.mediaId, !track);
    subtitleChoice.current++;
    applyAbort.current?.abort();
    setOnline(state => ({ ...state, applying: undefined }));
    setNotice(null);
    pendingRevision.current = null;
    const live = translation.state.status === "active" ? translation.state.job : null;
    liveShown.current = track && live?.track?.id === track.id ? { id: track.id, ranges: live.translatedRanges } : null;
    setSubtitle(track && live?.track?.id === track.id ? live.track : track);
    // Turning subtitles off also stops a translation the player started on its own (it would only cost money).
    if (!track && autoJob) { void cancelTranslation(); setNotice("자막을 꺼서 자동 번역을 멈췄어요"); }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const nudgeSubs = (delta: number) => {
    const next = Math.round((subOffset + delta) * 10) / 10;
    setSubOffset(next); subOffsetRef.current = next;
    subs.current?.setOffset(next);
    if (session && devicePrefs().rememberSubOffset) rememberSubtitleOffset(session.mediaId, next);
  };
  // Timing usually matches across a release group's episodes, so the offset follows the title.
  useEffect(() => {
    if (!session) return;
    const saved = devicePrefs().rememberSubOffset ? subtitleOffsetForTitle(session.mediaId) : 0;
    subOffsetRef.current = saved; setSubOffset(saved);
    subs.current?.setOffset(saved);
  }, [session?.mediaId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!resumeChip) return;
    const timer = setTimeout(() => setResumeChip(false), 7000);
    return () => clearTimeout(timer);
  }, [resumeChip]);

  useEffect(() => {
    const onHide = () => saveProgress(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [saveProgress]);

  /* ---------- chrome visibility ---------- */
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!video.current?.paused && !root.current?.querySelector(".player-panel")) {
        if (isRemoteMode() && root.current?.contains(document.activeElement) && !document.activeElement?.closest(".translate-offer")) (document.activeElement as HTMLElement).blur();
        setChrome(false);
      }
    }, isRemoteMode() ? 6000 : HIDE_AFTER);
  }, []);
  useLayoutEffect(() => { if (!playing || panel) { setChrome(true); window.clearTimeout(hideTimer.current); } else poke(); }, [playing, panel, poke]);
  useEffect(() => { subs.current?.setLift(chrome); }, [chrome, subtitle]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  /* ---------- actions ---------- */
  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, []);
  const seekBy = useCallback((delta: number, side?: "left" | "right", label?: string) => {
    const v = video.current;
    if (!v || live) return;
    v.currentTime = Math.max(0, Math.min((v.duration || total) - 0.5, v.currentTime + delta));
    setFlash({ key: Date.now(), side: side ?? (delta < 0 ? "left" : "right"), label: label ?? `${delta > 0 ? "+" : ""}${delta}초` });
  }, [total, live]);
  const seekTo = (seconds: number) => { const v = video.current; if (v && !live && Number.isFinite(seconds)) v.currentTime = seconds; };
  /* Remote seeking previews the target on the bar and seeks once the presses stop; holding the key speeds it up. */
  const [remoteSeek, setRemoteSeek] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const pendingTimer = useRef(0);
  const holdStart = useRef(0);
  const lastNudge = useRef(0);
  const nudgeSeek = (direction: 1 | -1, held: boolean) => {
    const v = video.current;
    if (!v || live) return;
    // TVs repeat keys at different rates, so a held key steps by time: at most ~8 steps a second, 3x after 1.5s.
    const now = performance.now();
    if (!held) holdStart.current = now;
    else if (now - lastNudge.current < 120) return;
    lastNudge.current = now;
    const delta = direction * step * (now - holdStart.current > 1500 ? 3 : 1);
    const target = Math.max(0, Math.min((v.duration || total) - 0.5, (pendingSeek.current ?? v.currentTime) + delta));
    pendingSeek.current = target;
    setRemoteSeek(target);
    const offset = Math.round(target - v.currentTime);
    setFlash({ key: Date.now(), side: offset < 0 ? "left" : "right", label: `${offset > 0 ? "+" : ""}${offset}초` });
    window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => {
      if (pendingSeek.current !== null && video.current) video.current.currentTime = pendingSeek.current;
      pendingSeek.current = null; setRemoteSeek(null);
    }, 500);
  };
  useEffect(() => () => window.clearTimeout(pendingTimer.current), []);
  const changeVolume = (value: number) => {
    const v = video.current;
    const next = Math.max(0, Math.min(1, value));
    setVolume(next); setMuted(next === 0);
    if (v) { v.volume = next; v.muted = next === 0; }
    localStorage.setItem(VOLUME_KEY, String(next));
  };
  const toggleMute = () => { const v = video.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
    if (fullscreenHost.current) await enterFullscreen(fullscreenHost.current).catch(() => {});
  }, []);
  const pip = async () => {
    const v = video.current;
    if (!v) return;
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
    else await v.requestPictureInPicture().catch(() => {});
  };
  const goNext = useCallback(() => {
    if (!session?.next) return;
    saveProgress();
    navigate(`/watch/${encodeURIComponent(session.next.episodeId)}`, { replace: true });
  }, [session, navigate, saveProgress]);
  const back = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(session ? `/title/${encodeURIComponent(session.mediaId)}` : "/");
  };

  /* ---------- next-up ---------- */
  const [remoteMarkers, setRemoteMarkers] = useState<PlaybackSession['markers']>();
  const [skipStatus, setSkipStatus] = useState('idle');
  const markerDuration = Math.round(total);
  useEffect(() => {
    setRemoteMarkers(undefined); setSkipStatus('idle');
    if (!session?.streams?.length || live || session.mediaType !== 'anime' || markerDuration < 60) return;
    const controller = new AbortController();
    setSkipStatus('loading');
    void api<{markers:PlaybackSession['markers']|null;status:string}>(`/episodes/${encodeURIComponent(episodeId)}/markers?duration=${markerDuration}`,{signal:controller.signal}).then(result=>{
      if (!controller.signal.aborted) { setRemoteMarkers(result.markers ?? undefined); setSkipStatus(result.status); }
    }).catch(()=>{if(!controller.signal.aborted)setSkipStatus('error');});
    return ()=>controller.abort();
  },[session,episodeId,markerDuration,live]);
  const markers = session?.markers ?? remoteMarkers;
  // Post-credits content (> 20s after the ending song) means the episode is
  // not over at the credits: offer "skip ending" and save next-up for the end.
  const postCredits = Boolean(markers?.creditsEnd && total && total - markers.creditsEnd > 20);
  const creditsAt = postCredits ? total - 15 : markers?.creditsStart ?? (total ? total - 30 : Infinity);
  const inCredits = Boolean(postCredits && markers?.creditsStart !== undefined && time >= markers.creditsStart && time < markers.creditsEnd! - 1);
  const showNext = Boolean(session?.next && !nextDismissed && total && time >= creditsAt && !ended);
  const autoplay = settings?.autoplayNext ?? true;
  const delay = settings?.autoplayDelay ?? 5;
  useEffect(() => {
    if (!showNext || !autoplay || !playing || waiting || panel || sourcePicker) { setCountdown(null); return; }
    setCountdown(delay);
    const timer = setInterval(() => setCountdown(value => (value === null ? null : value - 1)), 1000);
    return () => clearInterval(timer);
  }, [showNext, autoplay, playing, waiting, panel, sourcePicker, delay]);
  useEffect(() => { if (countdown !== null && countdown <= 0) goNext(); }, [countdown, goNext]);

  const intro = markers;
  const inIntro = Boolean(intro?.introStart !== undefined && intro?.introEnd && time >= intro.introStart && time < intro.introEnd - 1);

  // Markers are often a little off, so the skip button steps aside after a few seconds unless the controls are shown.
  const segment = inIntro ? "intro" : inCredits ? "credits" : null;
  const [skipFresh, setSkipFresh] = useState(false);
  useEffect(() => {
    if (!segment) { setSkipFresh(false); return; }
    setSkipFresh(true);
    const timer = window.setTimeout(() => setSkipFresh(false), SKIP_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [segment]);
  const showSkip = skipFresh || chrome;

  // Auto skip runs once per marker, so seeking back into an opening plays it.
  const skipped = useRef<{ intro?: boolean; credits?: boolean }>({});
  useEffect(() => {
    if (!prefs.autoSkip || !playing || waiting) return;
    if (inIntro && !skipped.current.intro) { skipped.current.intro = true; seekTo(intro!.introEnd!); setFlash({ key: Date.now(), side: "center", label: "오프닝 건너뜀" }); }
    else if (inCredits && !skipped.current.credits) { skipped.current.credits = true; seekTo(markers!.creditsEnd!); setFlash({ key: Date.now(), side: "center", label: "엔딩 건너뜀" }); }
  }, [inIntro, inCredits, playing, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- TV remote ---------- */
  useLayoutEffect(() => {
    const onRemote = (raw: Event) => {
      const event = raw as RemotePlayerEvent, key = event.detail.key;
      if (event.defaultPrevented) return;
      const inOffer = Boolean(document.activeElement?.closest(".translate-offer"));
      const handled = () => event.preventDefault();
      if (key.startsWith("Media")) {
        const v=video.current;
        if (key === "MediaPlay") void v?.play().catch(()=>{});
        else if (key === "MediaPause") v?.pause();
        else if (key === "MediaPlayPause") togglePlay();
        else if (key === "MediaFastForward") nudgeSeek(1, event.detail.original.repeat);
        else if (key === "MediaRewind") nudgeSeek(-1, event.detail.original.repeat);
        else if (key === "MediaStop") back();
        else return;
        poke(); handled(); return;
      }
      if (key === "Back") {
        if (sourcePicker) setSourcePicker(false);
        else if (panel === "subs" && subsView !== "main") setSubsView("main");
        else if (panel) setPanel(null);
        else if (autopilot.offer && root.current?.querySelector(".translate-offer")) autopilot.dismiss();
        else if (chrome) { (document.activeElement as HTMLElement)?.blur(); setChrome(false); }
        else back();
        handled(); return;
      }
      if (panel || sourcePicker) return;
      const sideways = key === "ArrowLeft" || key === "ArrowRight";
      if (sideways && !live && !inOffer && (document.activeElement?.getAttribute("role") === "slider" || !chrome)) {
        nudgeSeek(key === "ArrowLeft" ? -1 : 1, event.detail.original.repeat); poke();
        if (!chrome) requestAnimationFrame(() => bar.current?.focus());
        handled(); return;
      }
      if (!chrome && !inOffer && (key.startsWith("Arrow") || key === "Enter") && !(key === "Enter" && document.activeElement?.closest(".next-card,.player-error,.player-end,.player-chip,.player-skip"))) {
        poke(); requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>(".center-play")?.focus());
        handled(); return;
      }
      if (key.startsWith("Arrow") || key === "Enter") poke();
    };
    window.addEventListener("moa:remote-key", onRemote);
    return () => window.removeEventListener("moa:remote-key", onRemote);
  });

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if(sourcePicker) { if(event.key === "Escape") {event.preventDefault();setSourcePicker(false);} return; }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === " " && target.closest("button, a")) return;
      const v = video.current;
      if (!v) return;
      const key = event.key.toLowerCase();
      const handled = true;
      if (key === " " || key === "k") togglePlay();
      else if (key === "arrowleft" || key === "j") seekBy(key === "j" ? -step : -5);
      else if (key === "arrowright" || key === "l") seekBy(key === "l" ? step : 5);
      else if (key === "arrowup") changeVolume(v.volume + 0.1);
      else if (key === "arrowdown") changeVolume(v.volume - 0.1);
      else if (key === "f") void toggleFullscreen();
      else if (key === "m") toggleMute();
      else if (key === "n") goNext();
      else if (key === "c") chooseSubtitle(subtitle ? null : allSubs[0] ?? null);
      else if (key === "escape") { if (panel) setPanel(null); else if (!document.fullscreenElement) back(); }
      else if (/^[0-9]$/.test(key)) seekTo((Number(key) / 10) * (v.duration || total));
      else return;
      if (handled) { event.preventDefault(); poke(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const onFs = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreen(active);
      if (!active) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---------- touch gestures ---------- */
  // One tap toggles the controls; double-tap a side seeks 10s and further taps
  // on that side keep adding 10s (YouTube style); hold for 2x; pinch to fill.
  const lastSurfacePointer = useRef("mouse");
  const lastTap = useRef<{ at: number; side: "left" | "center" | "right" } | null>(null);
  const streak = useRef<{ side: "left" | "right"; until: number; total: number } | null>(null);
  const tapTimer = useRef<number>(0);
  const pressTimer = useRef<number>(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const suppressGestureClick = useRef(false);
  const boosting = useRef(false);
  const pinch = useRef<{ start: number; done: boolean } | null>(null);
  const [fill, setFill] = useState(prefs.videoFill);
  const changeFill = (value: boolean) => {
    setFill(value);
    setDevicePref("videoFill", value);
    setFlash({ key: Date.now(), side: "center", label: value ? "화면 채우기" : "원본 비율" });
  };
  const [fillScale, setFillScale] = useState(1);
  const [videoHeight, setVideoHeight] = useState<number>();
  useEffect(() => { subs.current?.setHeight(subHeight); }, [videoHeight, subHeight, subSize]);
  useEffect(() => {
    const v = video.current, r = root.current;
    if (!v || !r) return;
    const update = () => {
      if (!v.videoWidth || !v.videoHeight) { setFillScale(1); setVideoHeight(undefined); return; }
      setVideoHeight(Math.min(r.clientHeight, r.clientWidth * v.videoHeight / v.videoWidth));
      if (!fill) { setFillScale(1); return; }
      const screenRatio = r.clientWidth / r.clientHeight, videoRatio = v.videoWidth / v.videoHeight;
      setFillScale(Math.max(screenRatio / videoRatio, videoRatio / screenRatio));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(r);
    v.addEventListener("loadedmetadata", update);
    return () => { observer.disconnect(); v.removeEventListener("loadedmetadata", update); };
  }, [fill, session]);
  const distance = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  useEffect(() => () => { window.clearTimeout(tapTimer.current); window.clearTimeout(pressTimer.current); }, []);

  const onSurfacePointerDown = (event: React.PointerEvent) => {
    lastSurfacePointer.current = event.pointerType;
    if (event.pointerType !== "touch") return;
    if (!pointers.current.size) suppressGestureClick.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      endPress();
      window.clearTimeout(tapTimer.current);
      window.clearTimeout(hideTimer.current);
      lastTap.current = null;
      streak.current = null;
      suppressGestureClick.current = true;
      pinch.current = { start: distance(), done: false };
      return;
    }
    // Buttons retain their normal single-tap click. Only the video surface
    // starts a hold; both layers contribute pointers to the same pinch.
    if (pointers.current.size !== 1 || !(event.currentTarget as HTMLElement).classList.contains("player-surface")) return;
    pressTimer.current = window.setTimeout(() => {
      const v = video.current;
      if (v && !v.paused && !pinch.current) { boosting.current = true; setBoost(true); v.playbackRate = 2; }
    }, 450);
  };
  const onSurfacePointerMove = (event: React.PointerEvent) => {
    if (event.pointerType !== "touch" || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const p = pinch.current;
    if (!p || p.done || pointers.current.size !== 2) return;
    const scale = distance() / Math.max(1, p.start);
    if (scale > 1.2) { p.done = true; if (!fill) changeFill(true); }
    else if (scale < 0.83) { p.done = true; if (fill) changeFill(false); }
  };
  const endPress = () => {
    window.clearTimeout(pressTimer.current);
    if (boosting.current) { boosting.current = false; setBoost(false); if (video.current) video.current.playbackRate = speed; return true; }
    return false;
  };
  const seekStep = (side: "left" | "right") => {
    const delta = side === "left" ? -step : step;
    const now = Date.now();
    const total = streak.current && streak.current.side === side && now < streak.current.until ? streak.current.total + delta : delta;
    streak.current = { side, until: now + 900, total };
    seekBy(delta, side, `${total > 0 ? "+" : ""}${total}초`);
  };
  const onSurfacePointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) { if (!pointers.current.size) { pinch.current = null; poke(); } return; }
    if (endPress()) return;
    if (!(event.currentTarget as HTMLElement).classList.contains("player-surface")) return;
    if (panel) { setPanel(null); return; }
    if (event.pointerType !== "touch") { togglePlay(); poke(); return; }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const side = x < 0.35 ? "left" : x > 0.65 ? "right" : "center";
    const now = Date.now();
    if (side === "center" && lastTap.current?.side === "center" && now - lastTap.current.at < 280) {
      window.clearTimeout(tapTimer.current); lastTap.current = null;
      void toggleFullscreen(); return;
    }
    if (side !== "center" && !live) {
      if (streak.current?.side === side && now < streak.current.until) { window.clearTimeout(tapTimer.current); lastTap.current = null; seekStep(side); return; }
      if (lastTap.current?.side === side && now - lastTap.current.at < 280) { window.clearTimeout(tapTimer.current); lastTap.current = null; seekStep(side); return; }
    }
    lastTap.current = { at: now, side };
    window.clearTimeout(tapTimer.current);
    const toggle = () => { lastTap.current = null; setChrome(visible => { if (!visible) window.setTimeout(poke, 0); return !visible; }); };
    // Wait briefly to distinguish center double-tap fullscreen from a tap.
    if (live && side !== "center") toggle(); else tapTimer.current = window.setTimeout(toggle, 280);
  };
  const onSurfacePointerCancel = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (!pointers.current.size) { pinch.current = null; poke(); }
    suppressGestureClick.current = true;
    window.clearTimeout(tapTimer.current);
    lastTap.current = null;
    endPress();
  };

  /* ---------- seek bar ---------- */
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const ratioAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const onBarDown = (event: React.PointerEvent) => {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setScrub(ratioAt(event.clientX));
  };
  const onBarMove = (event: React.PointerEvent) => {
    const r = ratioAt(event.clientX);
    setHover(r);
    if (scrub !== null) setScrub(r);
    poke();
  };
  const onBarUp = (event: React.PointerEvent) => {
    if (scrub === null) return;
    seekTo(ratioAt(event.clientX) * total);
    setScrub(null);
  };
  const shown = scrub !== null ? scrub * total : remoteSeek ?? time;

  const episodes = useMemo(() => media.data?.seasons.flatMap(season => season.episodes) ?? [], [media.data]);
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const error = sessionError ?? fatal;

  return (
    <div
      ref={root}
      className={cx("player", chrome ? "is-chrome" : "is-idle", playing && "is-playing", fill && "is-fill", `cue-${subSize}`, `cue-bg-${subBackground}`)}
      style={{ "--video-height": videoHeight ? `${videoHeight}px` : undefined, "--subtitle-lift": `${chrome ? Math.max(15,subHeight) : subHeight}%` } as React.CSSProperties}
      onPointerMove={event => { if (event.pointerType !== "touch") poke(); }}
    >
      <video
        ref={video}
        className="player-video"
        style={fillScale !== 1 ? { transform: `scale(${fillScale})` } : undefined}
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        onPlay={event => { setPlaying(!event.currentTarget.paused); setEnded(false); }}
        onPause={event => { setPlaying(!event.currentTarget.paused); saveProgress(); swapRevision(); }}
        onSeeked={event => { swapRevision(); if (translation.busy) translation.prioritize(event.currentTarget.currentTime); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={event => { setDuration(event.currentTarget.duration); setLevels(engine.current?.levels() ?? []); }}
        onTimeUpdate={event => {
          const v = event.currentTarget;
          setTime(v.currentTime);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          if (Math.abs(v.currentTime - lastSaved.current) >= 10) saveProgress();
          if (pendingRevision.current) swapRevision();
        }}
        onEnded={() => {
          setEnded(true); setPlaying(false); saveProgress();
          if (session?.next && autoplay) goNext();
        }}
      />

      <div className="player-surface" onPointerDown={onSurfacePointerDown} onPointerMove={onSurfacePointerMove} onPointerUp={onSurfacePointerUp} onPointerCancel={onSurfacePointerCancel} onContextMenu={event => event.preventDefault()} onDoubleClick={event => {
        const native = event.nativeEvent as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
        // dblclick is a MouseEvent even when synthesized from touch input.
        if (lastSurfacePointer.current === "mouse" && !native.sourceCapabilities?.firesTouchEvents) void toggleFullscreen();
      }} />

      {(waiting || !session) && !error && <div className="player-loading"><Spinner size={52} /></div>}
      {flash && <div key={flash.key} className={cx("player-flash", `flash-${flash.side}`)} aria-hidden="true"><div>{flash.side === "left" ? <Rewind size={26} fill="currentColor" /> : flash.side === "right" ? <FastForward size={26} fill="currentColor" /> : null}<span>{flash.label}</span></div></div>}
      {boost && <div className="player-boost"><FastForward size={18} />2배속</div>}

      <header className="player-top">
        <button className="icon-btn icon-btn-l" aria-label="뒤로" onClick={back}><ArrowLeft size={28} /></button>
        <div className="player-title">
          {titleLine[0] && <b>{titleLine[0]}</b>}
          {titleLine[1] && <span>{titleLine[1]}</span>}
        </div>
      </header>

      {!playing && session && !waiting && !error && !ended && (
        <button className="player-bigplay" aria-label="재생" onClick={togglePlay}><Play size={44} fill="currentColor" /></button>
      )}

      {session && !error && !ended && !panel && (
        <div className="player-center" aria-hidden={!chrome}
          onPointerDown={onSurfacePointerDown} onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp} onPointerCancel={onSurfacePointerCancel}
          onClickCapture={event => {
            // Touch browsers may synthesize a button click after a pinch.
            if (suppressGestureClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
          }}>
          {!live && <button className="center-btn" aria-label={`${step}초 뒤로`} data-remote tabIndex={-1} onClick={() => { seekBy(-step); poke(); }}><RotateCcw size={30} /><small>{step}</small></button>}
          <button className="center-btn center-play" aria-label={playing ? "일시정지" : "재생"} data-remote tabIndex={-1} onClick={() => { togglePlay(); poke(); }}>
            {waiting ? <Spinner size={40} /> : playing ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" />}
          </button>
          {!live && <button className="center-btn" aria-label={`${step}초 앞으로`} data-remote tabIndex={-1} onClick={() => { seekBy(step); poke(); }}><RotateCw size={30} /><small>{step}</small></button>}
        </div>
      )}

      {resumeChip && session && (
        <div className="player-chip" role="status">
          <span>{clock(session.startPosition)}부터 이어서 재생</span>
          <button onClick={() => { seekTo(0); setResumeChip(false); }}>처음부터</button>
        </div>
      )}

      {autopilot.offer && !panel && !showNext && !error && !ended && (
        <TranslationOfferCard offer={autopilot.offer} onAccept={() => { if (!autopilot.accept()) { setPanelState("subs"); setSubsView("translate"); } }} onDismiss={autopilot.dismiss}
          onChoose={() => { autopilot.hide(); setPanelState("subs"); setSubsView("translate"); }} />
      )}
      {translatingHere && !panel && <div className="translate-gap" role="status"><Spinner size={14} /><span>이 구간은 번역 중이에요</span></div>}

      {notice && (
        <div className="player-chip player-notice" role="status">
          <Captions size={18} /><span>{typeof notice === "string" ? notice : notice.text}</span>
          {typeof notice === "string"
            ? <button onClick={() => { setNotice(null); setPanel("subs"); }}>변경</button>
            : <button onClick={() => { setNotice(null); notice.action.run(); }}>{notice.action.label}</button>}
        </div>
      )}

      {inIntro && !showNext && showSkip && (
        <Button className="player-skip" variant="secondary" data-remote-initial icon={<SkipForward size={18} />} onClick={() => seekTo(intro!.introEnd!)}>오프닝 건너뛰기</Button>
      )}
      {inCredits && !showNext && showSkip && (
        <Button className="player-skip" variant="secondary" data-remote-initial icon={<SkipForward size={18} />} onClick={() => seekTo(markers!.creditsEnd!)}>엔딩 건너뛰기</Button>
      )}

      {showNext && session?.next && (
        <div className="next-card" role="dialog" aria-label="다음 화">
          <Artwork src={session.next.thumb} title={session.next.title} ratio="landscape" width={480} labelFallback={false} />
          <div className="next-card-body">
            <small>다음 화 · {session.next.label}</small>
            <b>{session.next.title}</b>
            <div className="next-card-actions">
              <Button variant="primary" icon={<Play size={18} fill="currentColor" />} onClick={goNext} className="next-play">
                {countdown !== null ? `${countdown}초 후 재생` : "다음 화 재생"}
                {countdown !== null && <i className="next-countdown" style={{ animationDuration: `${delay}s` }} />}
              </Button>
              <Button variant="ghost" onClick={() => setNextDismissed(true)}>크레딧 보기</Button>
            </div>
          </div>
        </div>
      )}

      {!live && ended && !(session?.next && autoplay) && (
        <div className="player-end">
          <b>{session?.next ? "다음 화를 볼까요?" : "모두 보셨습니다"}</b>
          <div className="hero-actions">
            {session?.next ? <Button variant="primary" size="l" icon={<Play size={20} fill="currentColor" />} onClick={goNext}>다음 화 재생</Button>
              : <Button variant="primary" size="l" icon={<RotateCcw size={20} />} onClick={() => { seekTo(0); void video.current?.play(); }}>다시 보기</Button>}
            <Button variant="secondary" size="l" onClick={back}>나가기</Button>
          </div>
        </div>
      )}

      {error && (
        <div className="player-error" role="alert">
          <b>{error}</b>
          {error === KIDS_RESTRICTED ? <><p>12세 이하 등급이거나 가족·키즈 장르인 작품만 볼 수 있어요. 다른 프로필로 바꿔서 보세요.</p>
          <div className="hero-actions"><Button variant="primary" onClick={back}>나가기</Button></div></> : <>
          <p>잠시 후 다시 시도하거나, 다른 회차를 선택해 주세요.</p>
          <div className="hero-actions">
            <Button variant="primary" onClick={() => { runtimeRecoveries.current = 0; resumePlaying.current = null; setFatal(null); retry(live ? 0 : video.current?.currentTime || time || session?.startPosition || 0); }}>다시 시도</Button>
            <Button variant="secondary" onClick={()=>setSourcePicker(true)}>다른 소스 선택</Button>
            <Button variant="secondary" onClick={back}>나가기</Button>
          </div></>}
        </div>
      )}

      {sourcePicker && <PlaybackSources episodeId={episodeId} position={live?0:video.current?.currentTime || time || session?.startPosition || 0} onClose={()=>setSourcePicker(false)} onPlay={(id,at)=>{saveProgress(true);navigate(`/watch/${encodeURIComponent(id)}?t=${Math.max(0,Math.floor(at))}`);}}/>}
      <footer className="player-bottom">
        {!live && <div className="seek" ref={bar} onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerLeave={() => setHover(null)}
          role="slider" aria-label="재생 위치" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(shown)} aria-valuetext={clock(shown)} tabIndex={0}>
          <div className="seek-rail">
            <i className="seek-buffer" style={{ width: `${total ? (buffered / total) * 100 : 0}%` }} />
            {intro?.introEnd ? <i className="seek-marker" style={{ left: `${(intro.introStart ?? 0) / total * 100}%`, width: `${(intro.introEnd - (intro.introStart ?? 0)) / total * 100}%` }} /> : null}
            {markers?.creditsStart !== undefined && total ? <i className="seek-marker" style={{ left: `${markers.creditsStart / total * 100}%`, width: `${((markers.creditsEnd ?? total) - markers.creditsStart) / total * 100}%` }} /> : null}
            <i className="seek-fill" style={{ width: `${total ? (shown / total) * 100 : 0}%` }} />
          </div>
          <i className="seek-thumb" style={{ left: `${total ? (shown / total) * 100 : 0}%` }} />
          {hover !== null && <span className="seek-tip" style={{ left: `${hover * 100}%` }}>{clock(hover * total)}</span>}
        </div>}

        <div className="player-controls" data-remote-group>
          <div className="controls-left">
            <button className="icon-btn icon-btn-l" data-remote-entry aria-label={playing ? "일시정지 (K)" : "재생 (K)"} title={playing ? "일시정지 (K)" : "재생 (K)"} onClick={togglePlay}>
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </button>
            {!live && <><button className="icon-btn icon-btn-l" aria-label={`${step}초 뒤로 (J)`} title={`${step}초 뒤로 (J)`} onClick={() => seekBy(-step)}><RotateCcw size={26} /></button>
            <button className="icon-btn icon-btn-l" aria-label={`${step}초 앞으로 (L)`} title={`${step}초 앞으로 (L)`} onClick={() => seekBy(step)}><RotateCw size={26} /></button></>}
            <div className="volume">
              <button className="icon-btn icon-btn-l" aria-label="음소거 (M)" title="음소거 (M)" onClick={toggleMute}><VolumeIcon size={26} /></button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="볼륨" onChange={event => changeVolume(Number(event.target.value))} style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} />
            </div>
            <span className="player-time">{live ? <b className="live-label">● LIVE</b> : <>{clock(shown)} <span>/ {clock(total)}</span></>}</span>
          </div>
          <div className="controls-right">
            {session?.next && <button className="icon-btn icon-btn-l" aria-label="다음 화 (N)" title="다음 화 (N)" onClick={goNext}><SkipForward size={26} /></button>}
            {episodes.length > 1 && <button className={cx("icon-btn icon-btn-l", panel === "episodes" && "is-active")} aria-label="회차 목록" title="회차 목록" onClick={() => setPanel(panel === "episodes" ? null : "episodes")}><ListVideo size={26} /></button>}
            {session && (
              <button className={cx("icon-btn icon-btn-l", panel === "subs" && "is-active")} aria-label="자막 및 음성" title="자막 및 음성 (C)" onClick={() => setPanel(panel === "subs" ? null : "subs")}><Captions size={26} /></button>
            )}
            <button className={cx("icon-btn icon-btn-l", panel === "settings" && "is-active")} aria-label="재생 설정" title="재생 설정" onClick={() => setPanel(panel === "settings" ? null : "settings")}><Settings size={26} /></button>
            {"pictureInPictureEnabled" in document && <button className="icon-btn icon-btn-l hide-mobile" aria-label="PIP" title="PIP" onClick={() => void pip()}><PictureInPicture2 size={26} /></button>}
            <button className="icon-btn icon-btn-l" aria-label="전체 화면 (F)" title="전체 화면 (F)" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={26} /> : <Maximize size={26} />}</button>
          </div>
        </div>
      </footer>

      {panel && session && (
        <div className={cx("player-panel", `panel-${panel}`, panel === "subs" && subsView === "main" && session.audioTracks.length > 1 && "panel-split")} role="dialog" aria-label={panel === "episodes" ? "회차 목록" : panel === "subs" ? "자막 및 음성" : "재생 설정"}>
          <header className="panel-head">
            {panel === "subs" && subsView !== "main"
              ? <button className="panel-back" onClick={() => setSubsView("main")}><ChevronLeft size={22} /><b>{subsView === "style" ? "자막 설정" : subsView === "translate" ? "한국어로 번역" : "자막 검색 조건"}</b></button>
              : <b>{panel === "episodes" ? `회차 · ${episodes.length}개` : panel === "subs" ? "자막 및 음성" : "재생 설정"}</b>}
            <button className="icon-btn" aria-label="닫기" onClick={() => setPanel(null)}><X size={20} /></button>
          </header>
          {panel === "subs" && subsView === "main" && (
            <div className="panel-body panel-cols">
              {session.audioTracks.length > 1 && (
                <section className="panel-col">
                  <h3>음성</h3>
                  {session.audioTracks.map(track => {
                    const active = (audioTrackId ?? session.audioTracks.find(item => item.default)?.id ?? session.audioTracks[0].id) === track.id;
                    return (
                      <button key={track.id} className={cx("opt", active && "is-active")} onClick={() => { if (!active) { setPanel(null); switchAudio(track.id, video.current?.currentTime ?? 0); } }}>
                        <Check size={18} className="opt-check" /><span>{trackName(track)}</span>
                      </button>
                    );
                  })}
                </section>
              )}
              <section className="panel-col">
                <h3>자막</h3>
                <button className={cx("opt", !subtitle && "is-active")} onClick={() => chooseSubtitle(null)}><Check size={18} className="opt-check" /><span>끄기</span></button>
                {allSubs.map(track => (
                  <button key={track.id} className={cx("opt", subtitle?.id === track.id && "is-active")} onClick={() => chooseSubtitle(track)}>
                    <Check size={18} className="opt-check" />
                    {isTranslationTrack(track)
                      ? <><span>{track.label.replace(/\s*·\s*AI 번역$/, "") || "한국어"}{track.provenance ? ` · ${track.provenance.creatorName} 원문` : ""}</span><small className="tag-ai">AI 번역</small>{liveJob?.track?.id === track.id ? <small>번역 중</small> : translation.state.status === "failed" && translation.state.job?.track?.id === track.id ? <small className="warn">일부</small> : null}</>
                      : <><span>{trackName(track)}</span>{track.format === "ass" && <small>ASS</small>}</>}
                  </button>
                ))}
                <TranslationEntry config={translationConfig} admin={admin} state={translation.state} tracks={allSubs} onOpen={() => { autopilot.hide(); setSubsView("translate"); }} />
                <div className="online-subs">
                  {online.status === "idle" && (
                    <button className="opt opt-action" onClick={() => void searchOnline()}><CloudDownload size={18} /><span>온라인에서 한국어 자막 찾기</span></button>
                  )}
                  {online.status === "searching" && (
                    <div className="online-searching" role="status"><Spinner size={16} /><span>한국어 자막을 찾는 중…</span></div>
                  )}
                  {online.status === "error" && (
                    <button className="opt opt-action" onClick={() => void searchOnline()}><RotateCw size={18} /><span>찾지 못했어요 · 다시 시도</span></button>
                  )}
                  {online.status === "done" && online.result && (
                    <>
                      <h4>온라인 한국어 자막{online.result.partial ? <small> · 일부 응답 없음</small> : null}</h4>
                      {online.result.query && (
                        <button className="online-query" onClick={() => { setSubQuery(online.result!.query!); setSubsView("search"); }} aria-label="검색 조건 바꾸기">
                          <Search size={15} aria-hidden="true" />
                          <span>{online.result.query.title} · {online.result.query.season}기 {online.result.query.episode}화{online.result.query.episodeOffset ? <small> (전체 {online.result.query.episode + online.result.query.episodeOffset}화)</small> : null}</span>
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      )}
                      {online.result.autoApply === false && online.result.candidates.length > 0 && <p className="panel-note note-warn">회차 번호가 확실하지 않아 자동으로 적용하지 않았어요. 맞는 자막을 골라 주세요.</p>}
                      {online.result.candidates.length === 0 && <p className="panel-note">‘{online.result.resolvedTitle}’ 자막을 가져오지 못했어요.{online.result.issues?.some(issue => issue.kind === 'access-denied') ? " 제작자 사이트에서 접속을 차단했어요. 자막이 없는 것은 아닐 수 있어요." : online.result.issues?.some(issue => issue.kind === 'timeout') ? " 검색 시간이 초과됐어요. 잠시 후 다시 시도해 주세요." : online.result.query ? " 제목이나 시즌·화수를 바꿔서 다시 찾아보세요." : ""}</p>}
                      {online.result.candidates.map(candidate => {
                        const applied = subtitle?.provenance?.creatorName === candidate.creatorName && extraSubs.some(track => track.id === subtitle?.id);
                        const q = online.result!.query;
                        const mismatch = q ? candidate.matchedEpisode !== q.episode && candidate.matchedEpisode !== q.episode + q.episodeOffset : session.episodeLabel && candidate.matchedEpisode !== Number(session.episodeLabel.split("E")[1]);
                        return (
                          <div key={candidate.id} className="online-candidate">
                            <button className={cx("opt", applied && "is-active")} disabled={Boolean(online.applying)} onClick={() => void applyOnline(online.result!, candidate.id)}>
                              {online.applying === candidate.id ? <Spinner size={16} /> : <Check size={18} className="opt-check" />}
                              <span>{candidate.creatorName}</span>
                              <small>{candidate.format.toUpperCase()}</small>
                              {mismatch && <small className="warn">{candidate.matchedEpisode}화</small>}
                              {candidate.confidence < 0.5 && <small className="warn">확인 필요</small>}
                            </button>
                            <a className="icon-btn icon-btn-s" href={candidate.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label={`${candidate.creatorName} 블로그 열기`} title="출처 열기"><ExternalLink size={15} /></a>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </section>
            </div>
          )}
          {panel === "subs" && subsView === "main" && (
            <footer className="panel-foot">
              <button className="panel-link" onClick={() => setSubsView("style")}>
                <SlidersHorizontal size={18} /><span>자막 설정</span>
                <small>{[{ small: "작게", medium: "보통", large: "크게", xlarge: "더 크게" }[subSize], subOffset ? `싱크 ${subOffset > 0 ? "+" : ""}${subOffset.toFixed(1)}초` : null].filter(Boolean).join(" · ")}</small>
                <ChevronRight size={18} />
              </button>
            </footer>
          )}
          {panel === "subs" && subsView === "style" && (
            <div className="panel-body panel-form">
              <div className="pf-row">
                <span className="pf-label">크기</span>
                <div className="seg" role="group" aria-label="자막 크기">{(["small", "medium", "large", "xlarge"] as const).map((size, i) => <button key={size} className={cx(subSize === size && "is-active")} aria-pressed={subSize === size} onClick={() => changeAppearance({ size })}>{["작게", "보통", "크게", "더 크게"][i]}</button>)}</div>
              </div>
              <div className="pf-row">
                <span className="pf-label">배경</span>
                <div className="seg" role="group" aria-label="자막 배경">{(["original", "none", "soft", "solid"] as const).map((background, i) => <button key={background} className={cx(subBackground === background && "is-active")} aria-pressed={subBackground === background} onClick={() => changeAppearance({ background })}>{["기본", "없음", "옅게", "진하게"][i]}</button>)}</div>
              </div>
              <div className="pf-row">
                <span className="pf-label">위치</span>
                <div className="pf-range">
                  <input type="range" min={0} max={30} step={1} value={subHeight} aria-label="자막 높이" onChange={e => changeSubHeight(Number(e.target.value))} style={{ "--fill": `${subHeight / 30 * 100}%` } as React.CSSProperties} />
                  <output>{subHeight === 0 ? "원래" : `+${subHeight}%`}</output>
                  {subHeight !== 8 && <button className="pf-reset" onClick={() => changeSubHeight(8)}>기본</button>}
                </div>
              </div>
              <div className="pf-row">
                <span className="pf-label">싱크</span>
                <div className="sync-row">
                  <button className="seg-btn" aria-label="-0.5" onClick={() => nudgeSubs(-0.5)}>−0.5</button>
                  <button className="seg-btn" aria-label="-0.1" onClick={() => nudgeSubs(-0.1)}>−0.1</button>
                  <button className={cx("sync-value", subOffset !== 0 && "is-shifted")} onClick={() => nudgeSubs(-subOffset)} title="초기화">{subOffset > 0 ? "+" : ""}{subOffset.toFixed(1)}초</button>
                  <button className="seg-btn" aria-label="+0.1" onClick={() => nudgeSubs(0.1)}>+0.1</button>
                  <button className="seg-btn" aria-label="+0.5" onClick={() => nudgeSubs(0.5)}>+0.5</button>
                </div>
              </div>
              <p className="panel-note">자막이 늦게 나오면 −, 빨리 나오면 +. {devicePrefs().rememberSubOffset ? "싱크는 이 작품의 다음 회차에도 이어져요. " : ""}크기·배경·위치는 이 기기에 저장돼요. 영상에 입혀진 자막은 바뀌지 않습니다.</p>
            </div>
          )}
          {panel === "subs" && subsView === "translate" && (
            <TranslationView tracks={allSubs} current={subtitle} state={translation.state} appliedId={subtitle?.id} jimaku={jimaku.state} onSearch={query => void jimaku.search(query)}
              time={time} duration={total}
              onStart={source => void startTranslation(source)} onCancel={() => void cancelTranslation()}
              onApply={track => { chooseSubtitle(track); setSubsView("main"); }} />
          )}
          {panel === "subs" && subsView === "search" && subQuery && (
            <form className="panel-body panel-form sub-search" onSubmit={event => { event.preventDefault(); if (!subQuery.title.trim()) return; setSubsView("main"); void searchOnline({ ...subQuery, mapping: "manual" }); }}>
              <label className="pf-block">
                <span className="pf-label">작품 제목</span>
                <input className="pf-input" value={subQuery.title} maxLength={500} placeholder="예: 주술회전" onChange={e => setSubQuery({ ...subQuery, title: e.target.value })} />
              </label>
              <div className="sub-search-nums">
                <Stepper label="시즌" unit="기" value={subQuery.season} min={1} max={99} onChange={season => setSubQuery({ ...subQuery, season })} />
                <Stepper label="화수" unit="화" value={subQuery.episode} min={0} max={10000} onChange={episode => setSubQuery({ ...subQuery, episode })} />
              </div>
              <Stepper label="이전 시즌까지의 화수" unit="화" value={subQuery.episodeOffset} min={0} max={10000} onChange={episodeOffset => setSubQuery({ ...subQuery, episodeOffset })} />
              <p className="panel-note">영어 사이트는 화수를 처음부터 이어 세는 경우가 많아요. 예를 들어 ‘25화’가 실제로는 주술회전 2기 1화라면 시즌 2, 화수 1, 이전 시즌까지 24화로 맞춰 주세요. 자막 블로그에 ‘25화’로 올라온 자막도 함께 찾아요.</p>
              <div className="sub-search-actions">
                <button type="button" className="pf-reset" onClick={() => { setSubsView("main"); void searchOnline(); }}>자동으로 다시 찾기</button>
                <Button type="submit" variant="primary" icon={<Search size={16} />} disabled={!subQuery.title.trim()}>이 조건으로 찾기</Button>
              </div>
            </form>
          )}
          {panel === "settings" && (
            <div className="panel-body panel-form">
              <div className="pf-block">
                <span className="pf-label">재생 속도</span>
                <div className="seg seg-fill" role="group" aria-label="재생 속도">
                  {SPEEDS.map(value => (
                    <button key={value} className={cx(speed === value && "is-active")} aria-pressed={speed === value} onClick={() => { setSpeed(value); if (video.current) video.current.playbackRate = value; }}>{value === 1 ? "1x" : `${value}x`}</button>
                  ))}
                </div>
              </div>
              <div className="pf-block">
                <span className="pf-label">화질</span>
                {levels.length > 1 ? (
                  <div className="seg seg-fill" role="group" aria-label="화질">
                    <button className={cx(level === -1 && "is-active")} aria-pressed={level === -1} onClick={() => { setLevel(-1); engine.current?.setLevel(-1); }}>자동</button>
                    {[...levels].sort((a, b) => b.height - a.height).map(item => (
                      <button key={item.index} className={cx(level === item.index && "is-active")} aria-pressed={level === item.index} onClick={() => { setLevel(item.index); engine.current?.setLevel(item.index); }}>{item.height}p</button>
                    ))}
                  </div>
                ) : <p className="pf-value">{session.mode === "transcode" ? "서버 변환 · 기기에 맞춰 재생 중" : "원본 화질"}</p>}
              </div>
              {!!session.streams?.length && session.streams.length > 1 && (
                <div className="pf-block">
                  <span className="pf-label">재생 서버</span>
                  <div className="pf-list">
                    {session.streams.map(stream => <button className={cx("opt", session.streamId === stream.id && "is-active")} key={stream.id} onClick={() => { if (session.streamId !== stream.id) { setPanel(null); switchStream(stream.id, live ? 0 : video.current?.currentTime || 0); } }}><Check size={18} className="opt-check" /><span>{stream.label}</span></button>)}
                  </div>
                </div>
              )}
              {!!session.streams?.length && (
                <button className="panel-link" onClick={() => { setPanel(null); setSourcePicker(true); }}><Shuffle size={18} /><span>다른 소스 선택</span><ChevronRight size={18} /></button>
              )}
              <div className="pf-row pf-switch">
                <div><b>화면 채우기</b><small>화면 비율에 맞춰 영상을 꽉 채워요. 가장자리가 조금 잘릴 수 있어요.</small></div>
                <button role="switch" aria-checked={fill} aria-label="화면 채우기" className={cx("switch", fill && "is-on")} onClick={() => changeFill(!fill)}><i /></button>
              </div>
              {!session.streams?.length && (
                <div className="pf-row pf-switch">
                  <div><b>호환 재생</b><small>영상이 검게 보이거나 자막만 나올 때 켜세요.</small></div>
                  <button role="switch" aria-checked={compatible} aria-label="호환 재생" className={cx("switch", compatible && "is-on")} onClick={() => { setPanel(null); switchCompatibility(!compatible, video.current?.currentTime || 0); }}><i /></button>
                </div>
              )}
              {session.mediaType === "anime" && !live && <p className="panel-note" role="status">{markers ? "오프닝·엔딩 건너뛰기 사용 가능" : skipStatus === "loading" ? "오프닝·엔딩 구간 확인 중…" : skipStatus === "error" ? "건너뛰기 구간을 불러오지 못했어요" : "이 회차는 건너뛰기 구간 정보가 없어요"}</p>}
            </div>
          )}
          {panel === "episodes" && (
            <ol className="panel-episodes">
              {episodes.map(episode => {
                const current = episode.id === session.episodeId;
                return (
                  <li key={episode.id}>
                    <Link to={`/watch/${encodeURIComponent(episode.id)}`} replace className={cx("panel-episode", current && "is-current")} aria-current={current ? "true" : undefined}>
                      <span className="panel-episode-thumb"><Artwork src={episode.thumb} title={episode.title} ratio="landscape" width={240} labelFallback={false} />{episode.progress && !episode.progress.completed && episode.duration ? <ProgressBar ratio={episode.progress.position / episode.duration} className="card-progress" /> : null}</span>
                      <span className="panel-episode-body"><b>{episode.name ? `${episode.number}. ${episode.name}` : /^\d+화$/.test(episodeTitle(episode.title)) ? episodeTitle(episode.title) : `${episode.number}. ${episodeTitle(episode.title)}`}</b><small>{current ? "재생 중" : episode.progress?.completed ? "시청 완료" : episode.duration ? clock(episode.duration) : ""}</small></span>
                      {current ? <span className="eq" aria-hidden="true"><i /><i /><i /></span> : episode.progress?.completed ? <Check size={18} className="panel-episode-done" /> : null}
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
