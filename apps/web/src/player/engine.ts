import type Hls from "hls.js";
import type { ClientCapabilities, PlaybackSession, SubtitleTrack } from "@moa/shared";

export function compatibilityPlayback(): boolean {
  try { const saved = localStorage.getItem("moa.compatibility"); if (saved !== null) return saved === "1"; } catch { /* unavailable storage */ }
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}
export function setCompatibilityPlayback(value: boolean) {
  try { localStorage.setItem("moa.compatibility", value ? "1" : "0"); } catch { /* unavailable storage */ }
}

export function detectCapabilities(compatible = compatibilityPlayback()): ClientCapabilities {
  const ms = (window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? window.MediaSource;
  const test = (codecs: string) => {
    try { return Boolean(ms?.isTypeSupported(`video/mp4; codecs="${codecs}"`)); } catch { return false; }
  };
  return {
    h264: test("avc1.640028"),
    hevc: !compatible && (test("hvc1.2.4.L153.B0") || test("hev1.2.4.L153.B0")),
    av1: !compatible && test("av01.0.08M.08"),
    vp9: !compatible && test("vp09.00.10.08"),
    audioCodecs: (["mp4a.40.2:aac", "mp3:mp3", "opus:opus", "flac:flac", "ac-3:ac3", "ec-3:eac3"] as const)
      .filter(entry => { const [codec] = entry.split(":"); try { return Boolean(ms?.isTypeSupported(`audio/mp4; codecs="${codec}"`)); } catch { return false; } })
      .map(entry => entry.split(":")[1]),
    maxHeight: Math.min(2160, Math.max(720, Math.round(screen.height * (devicePixelRatio || 1))))
  };
}

export interface EngineHandle {
  destroy(): void;
  /** HLS quality levels (empty for direct play). */
  levels(): Array<{ index: number; height: number }>;
  setLevel(index: number): void;
}

export type FatalHandler = (message: string) => void;

/** Attach a playback session to a <video>. hls.js is loaded only when needed. */
export async function attach(video: HTMLVideoElement, session: PlaybackSession, start: number, onFatal: FatalHandler): Promise<EngineHandle> {
  const isHls = session.mime === "application/vnd.apple.mpegurl" || /\.m3u8(\?|$)/.test(session.url);
  const connectionHint = import.meta.env.VITE_MOA_LITE === '1' ? ' PC에서는 연결 확장에 영상 사이트 권한을 허용해 주세요. 모바일에서는 직접 재생을 허용하는 소스가 필요해요.' : '';
  const nativeError = () => onFatal("영상 데이터를 재생하지 못했습니다." + connectionHint);
  const noop: EngineHandle = { destroy() { video.removeEventListener("error",nativeError); video.removeAttribute("src"); video.load(); }, levels: () => [], setLevel() {} };

  if (!isHls || (!(await hlsSupported()) && video.canPlayType("application/vnd.apple.mpegurl"))) {
    video.addEventListener("error",nativeError);
    video.src = start > 0 ? `${session.url}#t=${start}` : session.url;
    return noop;
  }

  const { default: HlsClass } = await import("hls.js");
  const hls: Hls = new HlsClass({
    startPosition: session.live ? -1 : start,
    maxBufferLength: 30,
    maxMaxBufferLength: 120,
    backBufferLength: 60,
    // Transcoded segments can take a moment to appear after a seek.
    fragLoadPolicy: { default: { maxTimeToFirstByteMs: 20_000, maxLoadTimeMs: 60_000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 800, maxRetryDelayMs: 6000 } } }
  });
  let mediaRecoveries = 0;
  hls.on(HlsClass.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) { mediaRecoveries++; hls.recoverMediaError(); return; }
    if (data.type === HlsClass.ErrorTypes.NETWORK_ERROR) onFatal("영상 서버에 연결하지 못했습니다." + connectionHint);
    else onFatal("이 영상을 재생하지 못했습니다.");
  });
  hls.loadSource(session.url);
  hls.attachMedia(video);
  return {
    destroy() { hls.destroy(); },
    levels: () => hls.levels.map((level, index) => ({ index, height: level.height })),
    setLevel(index) { hls.currentLevel = index; }
  };
}

async function hlsSupported() {
  const { default: HlsClass } = await import("hls.js");
  return HlsClass.isSupported();
}

/* ---------- Subtitles ---------- */

type Jassub = Pick<import("jassub").default, "destroy" | "ready" | "timeOffset" | "renderer" | "_demandRender" | "_lastDemandTime">;
type AssStyle = Awaited<ReturnType<Jassub["renderer"]["getStyles"]>>[number];
export type SubtitleAppearance = { size: "small" | "medium" | "large" | "xlarge"; background: "original" | "none" | "soft" | "solid" };

/** Shows one subtitle track at a time: VTT via <track>, ASS via libass (JASSUB). */
export class SubtitleController {
  private trackEl: HTMLTrackElement | null = null;
  private ass: Jassub | null = null;
  private token = 0;
  private offset = 0;
  private shifted = 0;
  private appearance: SubtitleAppearance = { size: "medium", background: "original" };
  private originalStyles: AssStyle[] = [];
  private styling: Promise<void> = Promise.resolve();

  setAppearance(value: SubtitleAppearance) {
    this.appearance = value;
    this.setLift(this.lifted);
    return this.applyAppearance();
  }
  private applyAppearance() {
    const renderer = this.ass, token = this.token;
    this.styling = this.styling.catch(() => {}).then(async () => {
      if (!renderer || token !== this.token || !this.originalStyles.length) return;
      const { size, background } = this.appearance;
      for (const [index, original] of this.originalStyles.entries()) {
        if (token !== this.token) return;
        const style = { ...original, FontSize: original.FontSize * ({ small: .8, medium: 1, large: 1.3, xlarge: 1.65 }[size]) };
        // libass stores colors as RRGGBBAA (inverted alpha). Restore from the
        // original each time so repeated changes never compound font sizes.
        if (background === "soft" || background === "solid") {
          style.BorderStyle = 3; style.Outline = 2; style.Shadow = 0;
          style.OutlineColour = background === "soft" ? 0x80 : 0x00;
          style.BackColour = style.OutlineColour;
        } else if (background === "none") {
          style.BorderStyle = 1; style.Outline = 1.5; style.Shadow = 0; style.OutlineColour = 0;
        }
        await renderer.renderer.setStyle(style, index);
      }
      if (token === this.token && renderer._lastDemandTime) await renderer._demandRender(true);
    });
    return this.styling;
  }

  constructor(private video: HTMLVideoElement, private fonts: string[] = []) {}

  async show(track: SubtitleTrack | null) {
    this.clear();
    const token = this.token;
    if (!track) return;
    if (track.format === "vtt") {
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.label = track.label;
      el.srclang = track.lang ?? "";
      el.src = track.url;
      el.default = true;
      this.video.append(el);
      el.track.mode = "showing";
      this.trackEl = el;
      this.shifted = 0;
      el.addEventListener("load", () => {
        if (this.trackEl === el) this.applyVttOffset();
      }, { once: true });
      return;
    }
    try {
      const [{ default: JASSUB }, fallbackFont] = await Promise.all([
        import("jassub"),
        import("pretendard/dist/public/static/Pretendard-Regular.otf?url").then(module => module.default as string)
      ]);
      if (token !== this.token) return;
      const workerUrl = compatibilityPlayback() ? (await import("./subtitle-worker.ts?worker&url")).default : undefined;
      if (token !== this.token) return;
      const renderer = new JASSUB({
        workerUrl,
        video: this.video,
        subUrl: track.url,
        // Load the fallback before the first frame, including paused seeks.
        fonts: [...this.fonts, fallbackFont],
        // Korean glyphs: default libass fallback has none.
        availableFonts: { pretendard: fallbackFont },
        defaultFont: "pretendard",
        prescaleFactor: 1,
        maxRenderHeight: 1440,
        // JASSUB adds timeOffset to mediaTime; negating it delays subtitles.
        timeOffset: -this.offset
      });
      this.ass = renderer;
      await renderer.ready;
      if (token !== this.token) return;
      this.originalStyles = await renderer.renderer.getStyles();
      if (token === this.token) await this.applyAppearance();
    } catch (error) {
      if (token !== this.token) return;
      this.clear();
      throw error;
    }
  }

  /** Overlapping revision swaps: only the newest one may land. */
  private revision = 0;
  private assSwaps: Promise<void> = Promise.resolve();

  /**
   * Swap in a newer revision of the shown track without clearing the screen first (partial AI translations).
   * Calls may overlap; whichever finishes loading, only the most recent request is applied.
   */
  async replace(track: SubtitleTrack) {
    const token = this.token, revision = ++this.revision;
    const stale = () => token !== this.token || revision !== this.revision;
    if (track.format === "ass" && this.ass) {
      const renderer = this.ass;
      // libass swaps run one at a time so a slow older load can never land after a newer one.
      const swap = this.assSwaps.catch(() => {}).then(async () => {
        if (stale()) return;
        await renderer.renderer.setTrackByUrl(track.url);
        if (token !== this.token) return;
        this.originalStyles = await renderer.renderer.getStyles();
        if (token === this.token) await this.applyAppearance();
      });
      this.assSwaps = swap;
      return swap;
    }
    if (track.format !== "vtt" || !this.trackEl) return this.show(track);
    // Load the new cues hidden, then flip, so the current cue never disappears in between.
    const el = document.createElement("track");
    el.kind = "subtitles";
    el.label = track.label;
    el.srclang = track.lang ?? "";
    el.src = track.url;
    this.video.append(el);
    el.track.mode = "hidden";
    const loaded = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 15_000);
      el.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
      el.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
    if (stale()) { el.remove(); return; }
    if (!loaded) { el.remove(); throw new Error("subtitle-load"); }
    const old = this.trackEl;
    el.track.mode = "showing";
    if (old) { old.track.mode = "disabled"; old.remove(); }
    this.trackEl = el;
    this.shifted = 0;
    this.applyVttOffset();
  }

  private lifted = false;
  private height = 8;
  private cueRows = new WeakMap<VTTCue, { key: string; rows: number }>();
  private cuePositions = new WeakMap<VTTCue,{line:number|AutoKeyword;snapToLines:boolean;lineAlign:LineAlignSetting}>();
  setHeight(percent: number) {
    this.height = Math.max(0, Math.min(30, Number.isFinite(percent) ? percent : 8));
    this.setLift(this.lifted);
  }

  /** Raise VTT cues above the control bar while it is visible. */
  setLift(lifted: boolean) {
    this.lifted = lifted;
    const track = this.trackEl?.track;
    const cues = track?.cues;
    if (!cues) return;

    const style = typeof getComputedStyle === "function" ? getComputedStyle(this.video) : null;
    const fontSize = parseFloat(style?.fontSize || "18") || 18;
    const viewportHeight = this.video.videoWidth && this.video.videoHeight
      ? Math.min(this.video.clientHeight, this.video.clientWidth * this.video.videoHeight / this.video.videoWidth)
      : this.video.clientHeight || 360;
    const viewportWidth = this.video.videoHeight ? viewportHeight * this.video.videoWidth / this.video.videoHeight : this.video.clientWidth || 640;
    const step = fontSize * 1.35;
    const paddingLines = Math.max(0, Math.round(viewportHeight * Math.max(this.height, lifted ? 15 : 0) / 100 / step));
    // Native Chromium positions negative line numbers at the first line, and
    // does not implement lineAlign. Include the complete wrapped block height.
    const measure = style ? document.createElement("div") : null;
    if (measure) {
      measure.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;padding:0;border:0;margin:0;font:600 ${fontSize}px/${step}px "Pretendard Variable",Pretendard,sans-serif;`;
      document.body.append(measure);
    }
    try {
      for (const cue of Array.from(cues) as VTTCue[]) {
        if(!this.cuePositions.has(cue)) this.cuePositions.set(cue,{line:cue.line,snapToLines:cue.snapToLines,lineAlign:cue.lineAlign});
        const original=this.cuePositions.get(cue)!;
        const text = cue.getCueAsHTML?.().textContent ?? cue.text ?? "";
        const width = viewportWidth * (cue.size || 100) / 100 * .95;
        const key = `${width}:${fontSize}:${text}`;
        const cached = this.cueRows.get(cue);
        let rows = cached?.key === key ? cached.rows : Math.max(1, text.split("\n").length);
        if (measure && cached?.key !== key) {
          measure.style.width = `${width}px`;
          measure.textContent = text;
          rows = Math.max(rows, Math.round(measure.getBoundingClientRect().height / step));
        }
        this.cueRows.set(cue, {key, rows});
        // Preserve deliberately placed/vertical cues at position zero, but keep
        // ordinary bottom captions inside the viewport even with large fonts.
        const managed = lifted || this.height > 0 || (!cue.vertical && original.line === "auto");
        const line = managed ? -paddingLines - rows : original.line;
        const snap = managed ? true : original.snapToLines;
        if (cue.line === line && cue.snapToLines === snap && cached?.key === key) continue;
        track!.removeCue(cue);
        cue.line = line;
        cue.snapToLines = snap;
        cue.lineAlign = original.lineAlign;
        track!.addCue(cue);
      }
    } finally { measure?.remove(); }
  }

  /** Shift subtitles by `seconds` (positive = show later). */
  setOffset(seconds: number) {
    this.offset = seconds;
    if (this.ass) this.ass.timeOffset = -seconds;
    this.applyVttOffset();
  }

  private applyVttOffset() {
    const cues = this.trackEl?.track.cues;
    if (!cues) return;
    const delta = this.offset - this.shifted;
    if (delta) {
      for (const cue of Array.from(cues)) { cue.startTime += delta; cue.endTime += delta; }
      this.shifted = this.offset;
    }
    this.setLift(this.lifted);
  }

  clear() {
    this.token++;
    this.trackEl?.remove();
    this.trackEl = null;
    for (const t of Array.from(this.video.textTracks)) t.mode = "disabled";
    // destroy() still terminates JASSUB's worker if ready rejects.
    if (this.ass) void Promise.resolve(this.ass.destroy()).catch(() => {});
    this.ass = null;
    this.originalStyles = [];
  }

  destroy() { this.clear(); }
}
