export interface AliasEntry {
  korean: string;
  aliases: string[];
  /** Verified number of episodes before each season. Never guessed. */
  episodeOffsets?: Record<string, number>;
  /** Explicit arc labels that identify a release season even without a season digit. */
  seasonTitles?: Record<string, string[]>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Entire operation, including resolution/cache/downloads. Default 12,000 ms. */
  timeoutMs?: number;
}

export interface SubtitleQuery extends RequestOptions {
  /** Verified alternate titles, e.g. TMDB Japanese original title. */
  aliases?: string[];
  title: string;
  season?: number;
  episode: number;
  /** Override absolute episode numbering for a known series. */
  episodeOffset?: number;
}

export interface ResolvedTitle {
  aliases?: string[];
  title: string;
  baseTitle: string;
  season: number;
  episodeOffset: number;
  source: "alias" | "anissia" | "anilist" | "input" | "directory";
  confidence: number;
  animeNo?: number;
}

export interface SubtitleCreator {
  /** Verified alternate names used for discovery, while season/episode checks stay strict. */
  aliases?: string[];
  id: string;
  name: string;
  website: string;
  /** Anissia reports the latest caption, not every available episode. */
  latestEpisode?: string;
  updatedAt?: string;
  isCurrentEpisode: boolean;
  source: "anissia" | "archive" | "search" | "directory";
  animeNo?: number;
  title: string;
  season: number;
  episodeOffset: number;
  confidence: number;
}

export interface SubtitleCandidate {
  id: string;
  creatorId: string;
  creatorName: string;
  sourceUrl: string;
  format: "ass" | "vtt";
  content: string;
  filename: string;
  /** Always the requested season-relative episode. */
  episode: number;
  /** Actual episode number found in the attachment/post. */
  matchedEpisode: number;
  title: string;
  season: number;
  confidence: number;
}

export interface CacheEntry {
  value: SubtitleCandidate[];
  expiresAt: number;
}

/** Implement this in SQLite/Redis/etc. Values contain subtitle content. */
export interface SubtitleCache {
  get(key: string): Promise<CacheEntry | null | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export interface Diagnostic {
  stage: "resolve" | "creators" | "page" | "download" | "cache";
  code: "error" | "timeout" | "aborted" | "not-found";
  creatorName?: string;
  message: string;
}

export interface SubtitleClientOptions {
  cache?: SubtitleCache;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  /** Bound outbound HTTP requests (including redirects) per client instance. */
  maxRequests?: number;
  maxResponseBytes?: number;
  maxZipBytes?: number;
  maxZipEntries?: number;
  concurrency?: number;
  aliases?: AliasEntry[];
  enableAniList?: boolean;
  enableKairan?: boolean;
  enableCsora?: boolean;
  enableMelody?: boolean;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}
