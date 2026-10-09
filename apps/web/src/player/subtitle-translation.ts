import { useCallback, useEffect, useRef, useState } from "react";
import { PROFILE_HEADER, type SubtitleTrack } from "@moa/shared";
import { ApiError, currentProfileId } from "../lib/api";
import {
  cancelTranslationJob, coveredUntil, fetchTranslationJob, prioritizeTranslation, startTranslation, terminalJob, translationErrorMessage, TRANSLATION_MAX_BYTES,
  type TranslationFormat, type TranslationJob
} from "../api/translation";

/** What to translate: a session track, a file the viewer picked or a Jimaku candidate. */
export interface TranslationSource {
  label: string;
  /** Creates the server job near `startAt` seconds; re-run on retry (a track URL may need to be read again). */
  create: (episodeId: string, signal: AbortSignal, startAt?: number) => Promise<TranslationJob>;
}

/** A source whose original text the browser reads and uploads. */
export function contentSource(label: string, language: string | undefined, load: (signal: AbortSignal) => Promise<{ content: string; format: TranslationFormat }>): TranslationSource {
  return {
    label,
    create: async (episodeId, signal, startAt) => {
      const { content, format } = await load(signal);
      if (tooLarge(content)) throw new TranslationReadError(translationErrorMessage("translation-subtitle-too-large"));
      signal.throwIfAborted();
      return startTranslation(episodeId, { content, format, sourceLabel: label.slice(0, 200), ...(language ? { sourceLanguage: language } : {}), ...(startAt ? { startAt } : {}) });
    }
  };
}

/** "auto": started by the player itself (translation mode), not by a press. */
export type TranslationOrigin = "manual" | "auto";
export type TranslationState =
  | { status: "idle" }
  | { status: "reading"; source: TranslationSource; origin: TranslationOrigin }
  | { status: "active"; source: TranslationSource | null; label: string; job: TranslationJob; origin: TranslationOrigin }
  /** `job` is kept when some cues were translated before the failure. */
  | { status: "failed"; source: TranslationSource | null; label: string; message: string; job?: TranslationJob }
  | { status: "completed"; label: string; job: TranslationJob };

const POLL_MS = 1500;
const PRIORITY_MS = 2500;
const jobKey = (episodeId: string) => `moa.translationJob:${JSON.stringify([currentProfileId(), episodeId])}`;
const SOURCE_LANG: Record<string, string> = { en: "en", eng: "en", ja: "ja", jpn: "ja", jp: "ja" };

export const sourceLanguage = (lang?: string) => (lang ? SOURCE_LANG[lang.toLowerCase()] ?? lang.toLowerCase() : undefined);

const tooLarge = (content: string) => new TextEncoder().encode(content).length > TRANSLATION_MAX_BYTES;

/** Reads a session track the same way the player does: same-origin URLs carry the profile and cookies. */
export async function readTrack(track: SubtitleTrack, signal: AbortSignal) {
  const url = new URL(track.url, location.href);
  const headers: Record<string, string> = {};
  const profile = currentProfileId();
  if (profile && url.origin === location.origin) headers[PROFILE_HEADER] = profile;
  const response = await fetch(url, { headers, credentials: "same-origin", signal });
  if (!response.ok) throw new TranslationReadError("원문 자막을 읽지 못했어요. 다른 자막을 골라 주세요.");
  if (Number(response.headers.get("content-length")) > TRANSLATION_MAX_BYTES) { await response.body?.cancel(); throw new TranslationReadError(translationErrorMessage("translation-subtitle-too-large")); }
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationReadError("원문 자막을 읽지 못했어요.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > TRANSLATION_MAX_BYTES) { await reader.cancel(); throw new TranslationReadError(translationErrorMessage("translation-subtitle-too-large")); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const content = decode(bytes.buffer);
  if (!content.trim()) throw new TranslationReadError("원문 자막이 비어 있어요.");
  return { content, format: track.format as TranslationFormat };
}

/** Subtitle files are often not UTF-8 (Japanese SMI/SRT is commonly Shift_JIS). */
function decode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  for (const encoding of ["utf-8", "shift_jis", "euc-kr"]) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(buffer); } catch { /* next */ }
  }
  return new TextDecoder("windows-1252").decode(buffer);
}

export function fileFormat(name: string, content: string): TranslationFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "ass" || ext === "ssa") return "ass";
  if (ext === "vtt") return "vtt";
  if (ext === "srt") return "srt";
  if (ext === "smi" || ext === "sami") return "smi";
  const head = content.trimStart().slice(0, 200);
  if (head.startsWith("WEBVTT")) return "vtt";
  if (/^\[Script Info\]/i.test(head)) return "ass";
  if (/^<sami/i.test(head)) return "smi";
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return "srt";
  return null;
}

export async function readSubtitleFile(file: File) {
  if (file.size > TRANSLATION_MAX_BYTES * 2) throw new TranslationReadError("자막 파일이 너무 커요. 1MB 이하만 번역할 수 있어요.");
  const content = decode(await file.arrayBuffer());
  const format = fileFormat(file.name, content);
  if (!format) throw new TranslationReadError("ASS·SRT·VTT·SMI 자막 파일만 번역할 수 있어요.");
  if (tooLarge(content)) throw new TranslationReadError("자막 파일이 너무 커요. 1MB 이하만 번역할 수 있어요.");
  return { content, format };
}

export class TranslationReadError extends Error {}

function failure(error: unknown) {
  if (error instanceof TranslationReadError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 413) return translationErrorMessage("translation-subtitle-too-large");
    return translationErrorMessage(error.code);
  }
  return "번역 서버에 연결하지 못했어요. 다시 시도해 주세요.";
}

/**
 * Runs one translation job at a time for an episode. The job id is kept for
 * this tab so reopening the episode picks the progress back up instead of
 * starting (and paying for) a new job. `onTrack` fires for every new revision:
 * partial tracks from the first finished batch on, and the final one.
 */
export function useSubtitleTranslation(episodeId: string, onTrack: (track: SubtitleTrack, job: TranslationJob) => void) {
  const [state, setState] = useState<TranslationState>({ status: "idle" });
  const latest = useRef(onTrack);
  latest.current = onTrack;
  const run = useRef<AbortController | null>(null);
  const reported = useRef<string | null>(null);

  const remember = (job: TranslationJob | null, label?: string, origin?: TranslationOrigin) => {
    try {
      if (job && !terminalJob(job)) sessionStorage.setItem(jobKey(episodeId), JSON.stringify({ id: job.id, label, origin }));
      else sessionStorage.removeItem(jobKey(episodeId));
    } catch { /* private mode */ }
  };
  const report = (job: TranslationJob) => {
    if (!job.track) return;
    const revision = `${job.id}:${job.track.url}:${job.revision ?? ""}:${job.state}`;
    if (reported.current === revision) return;
    reported.current = revision;
    latest.current(job.track, job);
  };

  const follow = useCallback(async (job: TranslationJob, label: string, source: TranslationSource | null, origin: TranslationOrigin, controller: AbortController) => {
    let misses = 0;
    while (!controller.signal.aborted) {
      report(job);
      if (terminalJob(job)) break;
      setState({ status: "active", source, label, job, origin });
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      if (controller.signal.aborted) return;
      try { job = await fetchTranslationJob(job.id, controller.signal); misses = 0; }
      catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) { job = { ...job, state: "failed", error: "translation-job-not-found" }; break; }
        if (++misses >= 4) { setState({ status: "failed", source, label, message: "번역 진행 상황을 확인하지 못했어요.", job }); return; }
      }
    }
    if (controller.signal.aborted) return;
    remember(null);
    if (job.state === "completed" && job.track) setState({ status: "completed", label, job });
    else if (job.state === "cancelled") setState({ status: "idle" });
    else setState({ status: "failed", source, label, message: translationErrorMessage(job.error), ...(job.track ? { job } : {}) });
  }, [episodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async (source: TranslationSource, options: { startAt?: number; origin?: TranslationOrigin } = {}) => {
    const origin = options.origin ?? "manual";
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setState({ status: "reading", source, origin });
    try {
      const job = await source.create(episodeId, controller.signal, options.startAt && options.startAt > 1 ? Math.floor(options.startAt) : undefined);
      if (controller.signal.aborted) { if (!terminalJob(job)) void cancelTranslationJob(job.id).catch(() => {}); return; }
      remember(job, source.label, origin);
      await follow(job, source.label, source, origin, controller);
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "failed", source, label: source.label, message: failure(error) });
    }
  }, [episodeId, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(async () => {
    const current = state;
    if (current.status === "reading") { run.current?.abort(); setState({ status: "idle" }); return; }
    if (current.status !== "active") return;
    try {
      await cancelTranslationJob(current.job.id);
    } catch (error) {
      // Already finished or gone; the next poll settles the state.
      if (!(error instanceof ApiError && error.status === 404)) return;
    }
    run.current?.abort();
    remember(null);
    setState({ status: "idle" });
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a seek into an untranslated stretch, ask the server to translate there next.
  // Throttled; only the latest target is sent.
  const pending = useRef<{ timer: number; at: number | null; last: number }>({ timer: 0, at: null, last: 0 });
  const prioritize = useCallback((at: number) => {
    if (state.status !== "active" || coveredUntil(state.job.translatedRanges, at) !== null) return;
    const id = state.job.id, slot = pending.current;
    slot.at = Math.max(0, Math.floor(at));
    const send = () => {
      if (slot.at === null) return;
      const target = slot.at; slot.at = null; slot.last = Date.now();
      void prioritizeTranslation(id, target).catch(() => {});
    };
    window.clearTimeout(slot.timer);
    const wait = PRIORITY_MS - (Date.now() - slot.last);
    if (wait <= 0) send(); else slot.timer = window.setTimeout(send, wait);
  }, [state]);
  useEffect(() => () => window.clearTimeout(pending.current.timer), []);

  // Resume a job started earlier in this tab (e.g. after leaving and reopening the episode).
  useEffect(() => {
    let saved: { id: string; label?: string; origin?: TranslationOrigin } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(jobKey(episodeId)) || "null"); } catch { /* ignore */ }
    if (!saved?.id) return;
    const controller = new AbortController();
    run.current = controller;
    const label = saved.label || "자막", origin = saved.origin ?? "manual";
    void fetchTranslationJob(saved.id, controller.signal)
      .then(job => follow(job, label, null, origin, controller))
      .catch(() => { if (!controller.signal.aborted) remember(null); });
    return () => controller.abort();
  }, [episodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Stop following the job and drop it from this tab's resume list (the player cancels it separately). */
  const forget = useCallback(() => { run.current?.abort(); remember(null); }, [episodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handoff = (targetEpisode: string) => {
    if (state.status !== 'active') return false;
    try {
      sessionStorage.setItem(jobKey(targetEpisode), JSON.stringify({ id: state.job.id, label: state.label, origin: state.origin }));
      if (targetEpisode !== episodeId) sessionStorage.removeItem(jobKey(episodeId));
      return true;
    } catch { return false; }
  };

  /** A job for this episode is running or was picked back up from earlier in this tab. */
  const busy = state.status === "reading" || state.status === "active";
  // Leaving the player stops watching the job; the server finishes and keeps the result.
  useEffect(() => () => run.current?.abort(), []);

  return { state, start, cancel, prioritize, forget, handoff, busy };
}
