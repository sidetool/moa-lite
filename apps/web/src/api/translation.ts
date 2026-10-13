import { useQuery } from "@tanstack/react-query";
import type { Settings, SubtitleTrack } from "@moa/shared";
import { api } from "../lib/api";

export type { TranslationConfig, TranslationJob, JimakuCandidate, JimakuSearch } from "@moa/shared";
import type { TranslationConfig, TranslationJob, JimakuSearch } from "@moa/shared";

export type TranslatedRange = TranslationJob["translatedRanges"][number];
/** Per profile. manual: only from the subtitle menu; ask: suggest, translate on press; auto: translate certain sources right away. */
export type TranslationMode = Settings["translationMode"];
export const translationModeOf = (settings?: Settings): TranslationMode => settings?.translationMode ?? "manual";
export interface TranslationConfigPatch {
  /** Legacy single key; the UI uses addKeys. */
  apiKey?: string;
  addKeys?: string[];
  removeKeyIds?: string[];
  model?: string;
  enabled?: boolean;
  clearKey?: boolean;
  batchSize?: number;
  /** Minimum wait after one translation request finishes before the next starts (server-wide, also across key switches). */
  requestIntervalMs?: number;
  /** Extra attempts per batch after the first request, including retries on the next key. */
  retryCount?: number;
}
export type TranslationFormat = "ass" | "vtt" | "srt" | "smi";
export interface TranslationRequest {
  content: string; format: TranslationFormat; sourceLabel: string; sourceLanguage?: string;
  /** Seconds; translation starts near here, then fills in the rest. */
  startAt?: number;
}
export type JimakuQuery = JimakuSearch["query"];
// GET  /api/episodes/:id/subtitles/jimaku?title=&season=&episode=   -> JimakuSearch (all optional; candidates valid 30 min)
// POST /api/episodes/:id/subtitles/jimaku/translate { searchId, candidateId } -> TranslationJob

// GET    /api/translation/config                      -> TranslationConfig
// PATCH  /api/admin/translation/config                TranslationConfigPatch -> TranslationConfig
// GET    /api/admin/translation/models                -> { models: string[] }  (also validates the key)
// POST   /api/episodes/:id/subtitles/translate        TranslationRequest -> TranslationJob
// GET    /api/translations/:id                        -> TranslationJob
// POST   /api/translations/:id/priority               { startAt } -> 204  (active jobs; translate around a seek target next)
// DELETE /api/translations/:id                        -> 204
// GET    /api/episodes/:id/subtitles/translations     -> SubtitleTrack[]

/** Server limit for the original subtitle text. */
export const TRANSLATION_MAX_BYTES = 1024 * 1024;
export const TRANSLATION_MAX_KEYS = 8;
export const BATCH_SIZE = { min: 10, max: 300, default: 120 };
export const REQUEST_INTERVAL_MS = { min: 0, max: 60_000, default: 1000 };
export const RETRY_COUNT = { min: 0, max: 5, default: 2 };

export const translationKeys = { config: ["translation-config"] as const, models: ["translation-models"] as const };

export const useTranslationConfig = () =>
  useQuery({ queryKey: translationKeys.config, queryFn: () => api<TranslationConfig>("/translation/config"), staleTime: 60_000, retry: false });

export const isTranslationTrack = (track: Pick<SubtitleTrack, "source"> | null | undefined) => track?.source === "translation";

export const terminalJob = (job: TranslationJob) => job.state === "completed" || job.state === "failed" || job.state === "cancelled";

export const startTranslation = (episodeId: string, body: TranslationRequest) =>
  api<TranslationJob>(`/episodes/${encodeURIComponent(episodeId)}/subtitles/translate`, { method: "POST", body: { ...body } });
export const fetchTranslationJob = (id: string, signal?: AbortSignal) => api<TranslationJob>(`/translations/${encodeURIComponent(id)}`, { signal });
export const cancelTranslationJob = (id: string, keepalive = false) => api<void>(`/translations/${encodeURIComponent(id)}`, { method: "DELETE", keepalive });
export const searchJimaku = (episodeId: string, query?: JimakuQuery, signal?: AbortSignal) =>
  api<JimakuSearch>(`/episodes/${encodeURIComponent(episodeId)}/subtitles/jimaku${query ? `?${new URLSearchParams({ title: query.title.trim(), season: String(query.season), episode: String(query.episode) })}` : ""}`, { signal });
export const translateJimaku = (episodeId: string, searchId: string, candidateId: string, startAt?: number) =>
  api<TranslationJob>(`/episodes/${encodeURIComponent(episodeId)}/subtitles/jimaku/translate`, { method: "POST", body: { searchId, candidateId, ...(startAt ? { startAt } : {}) } });
export const prioritizeTranslation = (id: string, startAt: number) =>
  api<void>(`/translations/${encodeURIComponent(id)}/priority`, { method: "POST", body: { startAt } });

/** End of the translated range containing `at` (seconds), or null when `at` is not translated yet. */
export const coveredUntil = (ranges: TranslatedRange[] | undefined, at: number) =>
  ranges?.find(range => range.start <= at + 0.5 && at < range.end)?.end ?? null;

/**
 * Whether `at` sits in a stretch that is still waiting for translation. Ranges only cover times with
 * translated cues, so ordinary pauses in dialogue are gaps too; only long gaps count as untranslated.
 */
export function untranslatedGap(ranges: TranslatedRange[], at: number, duration: number, longest = 45) {
  if (coveredUntil(ranges, at) !== null) return false;
  const before = Math.max(0, ...ranges.filter(range => range.end <= at).map(range => range.end));
  const after = Math.min(duration || Infinity, ...ranges.filter(range => range.start > at).map(range => range.start));
  return after - before > longest;
}
export const savedTranslations = (episodeId: string, signal?: AbortSignal) =>
  api<SubtitleTrack[]>(`/episodes/${encodeURIComponent(episodeId)}/subtitles/translations`, { signal });
export const patchTranslationConfig = (patch: TranslationConfigPatch) =>
  api<TranslationConfig>("/admin/translation/config", { method: "PATCH", body: { ...patch } });
export const translationModels = () => api<{ models: string[] }>("/admin/translation/models");

/** Readable message for server error codes; unknown codes fall back to a generic line. */
export function translationErrorMessage(code?: string): string {
  const known: Record<string, string> = {
    "translation-not-configured": "관리자가 번역 설정을 마치지 않았어요.",
    "translation-disabled": "관리자가 자막 번역을 꺼 두었어요.",
    "translation-queue-full": "번역 대기열이 가득 찼어요. 잠시 후 다시 시도해 주세요.",
    "translation-permission-denied": "번역 서비스 접근 권한이 없어요. 관리자가 키 권한을 확인해 주세요.",
    "translation-credit-exhausted": "번역 서비스 잔액이나 할당량이 소진됐어요.",
    "translation-key-invalid": "Gemini API 키가 올바르지 않아요. 관리자에게 알려 주세요.",
    "translation-model-invalid": "설정된 번역 모델을 쓸 수 없어요. 관리자에게 알려 주세요.",
    "translation-model-unavailable": "번역 모델을 지금 사용할 수 없어요. 잠시 후 다시 시도해 주세요.",
    "translation-request-rejected": "Gemini가 이 자막의 번역 요청을 거절했어요.",
    "translation-quota": "Gemini 사용 한도를 넘었어요. 관리자에게 알려 주세요.",
    "translation-unavailable": "Gemini가 응답하지 않았어요. 잠시 후 다시 시도해 주세요.",
    "translation-invalid-response": "번역 결과가 올바르지 않았어요. 다시 시도해 주세요.",
    "translation-incomplete": "일부 자막을 번역하지 못했어요. 다시 시도하면 이어서 번역해요.",
    "translation-subtitle-too-large": "자막 파일이 너무 커요. 1MB 이하만 번역할 수 있어요.",
    "translation-invalid-subtitle": "자막 내용을 읽지 못했어요. 다른 자막을 골라 주세요.",
    "translation-job-not-found": "번역 작업을 찾지 못했어요. 다시 시도해 주세요.",
    "translation-failed": "번역하지 못했어요. 다시 시도해 주세요.",
    "translation-batch-invalid": "묶음당 자막 수는 10–300 사이로 정해 주세요.",
    "translation-too-many-keys": "키는 최대 8개까지 등록할 수 있어요.",
    "jimaku-unavailable": "Jimaku에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
    "jimaku-invalid-response": "Jimaku 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.",
    "jimaku-search-expired": "검색 결과가 만료됐어요. 다시 찾아 주세요.",
    "jimaku-file-not-found": "Jimaku에서 이 파일을 찾지 못했어요. 다른 파일을 골라 주세요.",
    "jimaku-file-too-large": "자막 파일이 너무 커요. 다른 파일을 골라 주세요."
  };
  return (code && known[code]) || known["translation-failed"];
}
