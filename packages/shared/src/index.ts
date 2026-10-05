// MOA API contract shared by apps/web and apps/server.
// Every JSON endpoint is under /api. Profile-scoped endpoints read the
// `X-Moa-Profile` header; requests without a valid profile get 401
// { error: "profile-required" }.

export const PROFILE_HEADER = "X-Moa-Profile";

export type MediaType = "movie" | "series" | "anime";
export type ProviderKind = "local" | "mangayomi-js" | "aniyomi-apk";

export interface ApiError { error: string; message?: string }
export interface Page<T> { items: T[]; page: number; hasNextPage: boolean; total?: number }

/* ---------- Profiles ---------- */

export interface Profile {
  avatar?: string | null;
  id: string;
  name: string;
  /** One of PROFILE_COLORS; the UI renders the avatar from it. */
  color: string;
  kids: boolean;
  createdAt: string;
}
export const PROFILE_COLORS = ["red", "blue", "green", "amber", "violet", "teal"] as const;
// GET    /api/profiles                 -> Profile[]          (no profile header needed)
// POST   /api/profiles                 { name, color?, kids? } -> Profile
// PATCH  /api/profiles/:id             { name?, color?, kids? } -> Profile
// DELETE /api/profiles/:id             -> 204

/* ---------- Images ---------- */
// Image fields are server-relative URLs (e.g. "/api/images/<key>?w=342") or
// absolute https URLs for remote sources. `?w=` requests a resized WebP.
// Any image may be missing; the UI has designed fallbacks.

export interface ProviderRef { id: string; name: string; kind: ProviderKind; lang?: string; iconUrl?: string }

/* ---------- Cards and detail ---------- */

export interface ProgressSummary {
  episodeId: string;
  /** 0..1 progress of that episode. */
  ratio: number;
  /** e.g. "S2:E3 · 12분 남음" or "38분 남음" — ready to display. */
  label: string;
}

export interface SeasonInfo { kind: "season" | "part" | "final" | "movie" | "ova" | "special"; season?: number; part?: number; label: string }

export interface MediaCard {
  seasonInfo?: SeasonInfo;
  audio?: 'sub' | 'dub';
  baseTitle?: string;
  /** Query relevance, 0..1; present when resolve receives query. */
  relevance?: number;
  originalTitle?: string;
  sourceCount?: number;
  /** Distinct languages of the selected grouped sources; local has no language. */
  langs?: string[];
  id: string;
  title: string;
  type: MediaType;
  /** 2:3 poster. */
  poster?: string;
  /** 16:9 landscape image (backdrop or a frame grab). */
  backdrop?: string;
  year?: number;
  genres?: string[];
  provider: ProviderRef;
  /** Number of episodes for series/anime. */
  episodeCount?: number;
  progress?: ProgressSummary;
  inWatchlist?: boolean;
  /** Short label for a corner badge, e.g. "새 에피소드", "4K". */
  badge?: string;
  addedAt?: string;
  /** Title logo (transparent PNG) from metadata, shown instead of text in banners. */
  logo?: string;
  /** 0..10 audience score from metadata. */
  rating?: number;
  /** Age rating, e.g. "15", "ALL". */
  certification?: string;
  overview?: string;
}

export interface EpisodeProgress { position: number; duration: number; completed: boolean; updatedAt: string }

export interface Episode {
  id: string;
  mediaId: string;
  season: number;
  number: number;
  title: string;
  overview?: string;
  /** 16:9 thumbnail. */
  thumb?: string;
  /** Seconds. */
  duration?: number;
  airDate?: string;
  /** Episode name from metadata, when the source only has "N화". */
  name?: string;
  progress?: EpisodeProgress;
}

export interface Season { number: number; title: string; episodes: Episode[] }

export interface FranchiseSeason {
  key: string;
  label: string;
  season?: number;
  part?: number;
  final?: boolean;
  mediaId: string;
  seasonNumber?: number;
  episodeCount?: number;
  year?: number;
  provider: ProviderRef;
  current: boolean;
}
export interface Franchise { title: string; seasons: FranchiseSeason[]; complete: boolean }
// GET /api/media/:id/franchise -> Franchise

export interface MediaDetail extends MediaCard {
  overview?: string;
  rating?: number;
  /** Seconds, movies only. */
  runtime?: number;
  cast?: string[];
  seasons: Season[];
  /** What the main "play" button should start. Null only if nothing is playable. */
  playTarget: { episodeId: string; position: number; label: string } | null;
  /** Same title found through other providers (phase 2). */
  alternatives?: MediaCard[];
  /** Local files: technical info shown in the detail footer. */
  fileInfo?: { container: string; video: string; audio: string; resolution: string; size: number };
  tagline?: string;
  people?: Person[];
  /** YouTube video key. */
  trailer?: string;
  similar?: MetadataCandidate[];
  /** Current metadata link. Absent when metadata is not configured. */
  metadata?: MetadataLink;
}

export type MetadataKind = "tv" | "movie";
export interface Person { name: string; role?: string; photo?: string }
export interface MetadataCandidate { kind: MetadataKind; id: number; title: string; originalTitle?: string; year?: number; poster?: string; overview?: string; seasons?: number }
export interface MetadataLink { status: "auto" | "manual" | "none" | "off" | "pending"; kind?: MetadataKind; id?: number; season?: number; title?: string }
// GET   /api/metadata/status -> { tmdb: boolean }
// GET   /api/media/:id/metadata/search?q= -> MetadataCandidate[]
// PATCH /api/media/:id/metadata { action: "link", kind, tmdbId, season? } | { action: "off" | "auto" } -> MetadataLink
// GET /api/media/:id -> MediaDetail

/* ---------- Browse ---------- */

export interface Row {
  id: string;
  title: string;
  kind: "continue" | "watchlist" | "recent" | "media" | "genre";
  /** Landscape rows (continue watching) use 16:9 cards. */
  layout: "poster" | "landscape";
  items: MediaCard[];
  /** Optional link target for "모두 보기". */
  more?: { path: string };
}

export interface HomeResponse {
  /** 1..5 featured items for the rotating hero. */
  hero: MediaCard[];
  rows: Row[];
}
// GET /api/home?type=movie|series|anime (type optional) -> HomeResponse
// GET /api/media?type=&genre=&provider=&sort=recent|title|year&page= -> Page<MediaCard>
// GET /api/genres?type= -> string[]

export interface SearchGroup { provider: ProviderRef; items: MediaCard[]; error?: string }
// GET /api/search?q= -> { query: string; groups: SearchGroup[] }

/* ---------- Watchlist / history / progress ---------- */
// GET    /api/watchlist                -> MediaCard[]
// PUT    /api/watchlist/:mediaId       -> 204
// DELETE /api/watchlist/:mediaId       -> 204
// GET    /api/history?page=            -> Page<HistoryEntry>
// DELETE /api/history/:episodeId       -> 204
// POST   /api/progress                 { episodeId, position, duration } -> EpisodeProgress
//   Marks completed when position >= 90% of duration or < 120s remain.

export interface HistoryEntry { media: MediaCard; episode: Episode; watchedAt: string }

/* ---------- Playback ---------- */

export interface ClientCapabilities {
  /** Results of MediaSource.isTypeSupported for common codecs. */
  h264: boolean;
  hevc: boolean;
  av1: boolean;
  vp9?: boolean;
  /** Audio codecs the client can decode, e.g. ["aac","mp3","opus","flac","ac3","eac3"]. */
  audioCodecs?: string[];
  /** Max height the client wants, e.g. 1080. */
  maxHeight?: number;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  lang?: string;
  /** "ass" is rendered with libass in the browser; "vtt" via <track>. */
  format: "vtt" | "ass";
  url: string;
  default?: boolean;
  /** Embedded tracks are extracted by the server on demand. */
  embedded?: boolean;
  source?: "embedded" | "local" | "extension" | "upload" | "online" | "translation";
  /** Online subtitles: who made it and where it came from (display as text). */
  provenance?: { creatorName: string; sourceUrl: string };
}

/* ---------- Online Korean subtitles (packages/subtitles-ko) ---------- */

export interface OnlineSubtitleCandidate {
  id: string;
  creatorName: string;
  sourceUrl: string;
  filename: string;
  format: "ass" | "vtt";
  /** Episode the file claims to be for (may differ from the request). */
  matchedEpisode: number;
  /** 0..1 */
  confidence: number;
}

export interface OnlineSubtitleQuery {
  title: string;
  season: number;
  episode: number;
  /** Absolute episode = season-relative episode + episodeOffset. */
  episodeOffset: number;
  aliases?: string[];
  mapping?: 'source' | 'absolute-to-season' | 'part-to-season' | 'manual';
  warnings?: string[];
}

export interface OnlineSubtitleIssue {
  kind: 'access-denied' | 'timeout' | 'fetch-failed' | 'not-found';
  creatorName?: string;
}
export interface OnlineSubtitleSearch {
  /** Summarized failures without network URLs or raw exception text. */
  issues?: OnlineSubtitleIssue[];
  query?: OnlineSubtitleQuery;
  /** False when numbering requires user review. Manual application is still allowed. */
  autoApply?: boolean;
  searchId: string;
  /** Korean title the search actually used, e.g. "최애의 아이 2기". */
  resolvedTitle: string;
  candidates: OnlineSubtitleCandidate[];
  /** Some sources timed out; more may exist. */
  partial: boolean;
  expiresAt: number;
}
// GET    /api/episodes/:id/subtitles/online          -> OnlineSubtitleSearch   (may take up to ~12s)
// POST   /api/episodes/:id/subtitles/online          { searchId, candidateId } -> SubtitleTrack (saved; included in later sessions)
// DELETE /api/episodes/:id/subtitles/:subtitleId     -> 204

export interface AudioTrack { id: string; label: string; lang?: string; default?: boolean }

export interface PlaybackSession {
  /** moa-lite fetches media directly; a connector may apply temporary tab rules. */
  transport?: 'direct' | 'connector';
  headers?: Record<string, string>;
  /** APK process must stay alive; client sends heartbeats while paused and can recreate an expired session once. */
  runtimeDependent?: boolean;
  sessionId: string;
  episodeId: string;
  /** Shown in the player's title bar. */
  mediaId: string;
  mediaTitle: string;
  mediaType: MediaType;
  /** Episode title for series/anime ("3화", "The Stage"); omitted for movies. */
  episodeTitle?: string;
  /** Compact position label, e.g. "S2:E3"; omitted for movies. */
  episodeLabel?: string;
  /** direct = original file over Range; remux/transcode = HLS. */
  mode: "direct" | "remux" | "transcode";
  url: string;
  mime: "video/mp4" | "video/webm" | "application/vnd.apple.mpegurl";
  duration: number;
  live?: boolean;
  streams?: Array<{ id: string; label: string }>;
  streamId?: string;
  startPosition: number;
  subtitles: SubtitleTrack[];
  audioTracks: AudioTrack[];
  /** Episode to offer in the "다음 화" card; null for the last one / movies. */
  next: { episodeId: string; title: string; label: string; thumb?: string } | null;
  /** Optional skip markers (seconds). */
  markers?: {
    introStart?: number;
    introEnd?: number;
    creditsStart?: number;
    /** End of the ending song; content after it (post-credits scene) is still part of the episode. */
    creditsEnd?: number;
    source?: "manual" | "fingerprint" | "aniskip";
  };
  /** Font URLs for ASS rendering (attachments in MKV). */
  fonts?: string[];
}
// POST   /api/playback   { episodeId, capabilities, audioTrackId?, startPosition? } -> PlaybackSession
// DELETE /api/playback/:sessionId -> 204
// Session URLs live under /api/playback/:sessionId/... and expire after
// 30 minutes without requests. They work without the profile header (the URL
// is the capability within the authenticated account) so <video>, <track> and libass can fetch them; if the
// header is present it must match the session's profile. Image URLs likewise.

/* ---------- Local library ---------- */

export interface LibraryFolder { id: string; path: string; type: MediaType; label: string; itemCount: number; lastScanAt?: string }
export interface ScanStatus { running: boolean; phase?: "listing" | "probing" | "thumbnails"; done: number; total: number; startedAt?: string; error?: string }
// GET    /api/library/folders          -> LibraryFolder[]
// POST   /api/library/folders          { path, type, label? } -> LibraryFolder   (path must be under MOA_MEDIA_ROOT)
// DELETE /api/library/folders/:id      -> 204
// GET    /api/library/browse?path=     -> { path: string; dirs: string[] }  (folder picker, within MOA_MEDIA_ROOT)
// POST   /api/library/scan             -> ScanStatus
// GET    /api/library/status           -> ScanStatus

/* ---------- Settings ---------- */

export interface NavigationTab {
  sourceFilters?: Record<string, BrowseSelection>;
  id: string;
  name: string;
  sourceIds: string[];
  includeLocal: boolean;
}

export interface Settings {
  /** Per-profile navigation. Omitted uses source-based defaults. */
  navigation?: NavigationTab[];
  autoplayNext: boolean;
  /** Seconds before the next episode starts automatically. */
  autoplayDelay: number;
  defaultSubtitleLang: string;
  subtitleSize: "small" | "medium" | "large" | "xlarge";
  preferredQuality: "auto" | "1080" | "720" | "480";
  hardwareTranscoding: boolean;
  /** Search Korean subtitles online when an anime episode has none. */
  autoFetchSubtitles: boolean;
  translationMode: "manual" | "ask" | "auto";
  /** Preferred original when automatic translation is needed. */
  translationSourcePriority: "site" | "jimaku";
  /** Do not auto-search/translate unknown-language site tracks; explicit foreign languages are exempt. */
  skipSubtitleSearchWithSiteTrack: boolean;
  /** Skip translation offers, automatic Jimaku lookup and auto translation when the video has no subtitle track. */
  skipTranslationWithoutSubtitles: boolean;
}
// GET   /api/settings -> Settings
// PATCH /api/settings Partial<Settings> -> Settings

// GET /api/health -> { ok: true, version: string }

/* ---------- Video sources ---------- */
export interface VideoSource {
  /** Server-cached source icon; used on the source management screen. */
  iconUrl?: string;
  kind?: "mangayomi-js" | "aniyomi-apk";
  rollbackVersion?: string;
  health?: { ok: boolean; checkedAt: string; action: string; code?: string };
  id: string; name: string; version: string; installedVersion?: string;
  installed: boolean; enabled: boolean; type: MediaType; live: boolean;
  repository: string; lang: string; notes?: string;
}
export interface SourcePreference {
  key: string; title: string; summary?: string; kind: "text" | "boolean" | "select" | "multi-select";
  secret: boolean; configured?: boolean; value?: string | boolean | number | string[];
  choices?: readonly { label: string; value: string | number }[];
}
// GET /api/sources -> VideoSource[]
// POST /api/sources/refresh { url? } -> VideoSource[]
// POST /api/sources/:id/install -> VideoSource
// PATCH /api/sources/:id { enabled?, type?, live? } -> VideoSource
// GET/PATCH /api/sources/:id/preferences -> SourcePreference[]
// GET /api/sources/:id/browse?mode=popular|latest|search&q=&page= -> Page<MediaCard>

export interface NetworkSettings { defaultProxy: string; revision: number }
// GET/PATCH /api/network -> NetworkSettings (server-wide; empty proxy = direct)
// POST /api/network/test { defaultProxy } -> { ok: true, elapsedMs: number, sources: number }

export type FilterValue = string | number | boolean | { index: number; ascending: boolean };
export interface SourceFilter { id: string; position: number; groupPosition?: number; label: string; kind: 'header'|'separator'|'select'|'sort'|'checkbox'|'text'|'tri_state'; options?: string[]; defaultValue?: FilterValue }
export interface FilterChange { position: number; groupPosition?: number; value: FilterValue }
export interface BrowseSchema { revision: string; availableModes: string[]; filters: SourceFilter[] }
export interface BrowseSelection { revision: string; filters: FilterChange[] }
// POST /api/media/groups/resolve { ids: string[], query?: string } -> MediaCard[]
export interface TitleGroup { id: string; manual: boolean; members: MediaCard[] }

/* ---------- Accounts (auth service: /__moa/api) ---------- */
export interface Account { id: string; username: string; role: 'admin' | 'member' }
export interface Invite {
  id: string; code: string; url: string; label: string; maxUses: number | null; uses: number;
  expiresAt: string | null; revoked: boolean; createdAt: string;
  status: 'active' | 'expired' | 'used-up' | 'revoked';
}
export interface AccountSummary extends Account {
  disabled: boolean; createdAt: string; lastLoginAt: string | null; inviteLabel: string | null;
}

/** Admin source removal preview. profilesAffected counts distinct profiles with deleted data or tab references. */
export interface SourceRemovalImpact {
  mediaCount: number;
  episodeCount: number;
  progressCount: number;
  watchlistCount: number;
  profilesAffected: number;
}
export interface SourceRemovalResult { removedIds: string[]; impact: SourceRemovalImpact }
export interface DefaultNavigation { navigation: NavigationTab[] | null }
export type DefaultNavigationUpdate = DefaultNavigation | { fromProfile: true };

/* ---------- Gemini subtitle translation ---------- */
export interface TranslationConfig { configured: boolean; enabled: boolean; model: string; batchSize: number; requestIntervalMs: number; retryCount: number; keys: { id: string; label: string }[] }
export interface TranslationJob {
  revision: number;
  partial: boolean;
  translatedRanges: { start: number; end: number }[];
  id: string; episodeId: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  done: number; total: number; model: string; cached: boolean; error?: string; track?: SubtitleTrack;
}
export interface JimakuCandidate {
  id: string; title: string; filename: string; format: 'ass'|'vtt'|'srt'|'smi'; language: 'ja'; sourceUrl: string;
  episode?: number; match: 'episode'|'movie'|'unverified';
}
export interface JimakuSearch {
  searchId: string; query: { title: string; season: number; episode: number }; candidates: JimakuCandidate[]; warning?: string;
}

export type { RemoteAccessMode, RemoteAccessState, RemoteAccessConfig, RemoteAccessConfigure, RemoteAccessStatus } from './remote-access.js';
