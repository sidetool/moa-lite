import { directoryCreators, creatorHome } from "./directory.js";
import builtInAliases from "./aliases.json" with { type: "json" };
import { deadline, abortable, parallel, failureCode } from "./async.js";
import { PublicHttpClient } from "./http.js";
import { MetadataClient, stableId } from "./metadata.js";
import { BlogCollector } from "./blogs.js";
import { normalizeTitle, titleKey, validateEpisode, validateOffset } from "./normalize.js";
import type { Diagnostic, RequestOptions, ResolvedTitle, SubtitleCandidate, SubtitleClientOptions, SubtitleCreator, SubtitleQuery } from "./types.js";

export type * from "./types.js";
export { normalizeTitle, parseSeason, parseEpisodes } from "./normalize.js";
export { toVtt, decodeSubtitleBuffer, detectSubtitleEncoding, convertSubtitle } from "./convert.js";
export { extractSubtitleBuffer, safeZipPath } from "./archive.js";
export type { ExtractOptions, ExtractedSubtitle } from "./archive.js";
export { UnsafeUrlError, ResponseLimitError } from "./http.js";

function positive(value: number | undefined, fallback: number, name: string, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) throw new RangeError(`${name} must be 1–${max}`);
  return result;
}

export function deduplicateCandidates(candidates: SubtitleCandidate[]): SubtitleCandidate[] {
  const unique = new Map<string, SubtitleCandidate>();
  for (const candidate of candidates) {
    const key = `${titleKey(candidate.creatorName)}:${candidate.season}:${candidate.episode}`;
    const previous = unique.get(key);
    if (!previous || candidate.confidence > previous.confidence) unique.set(key, candidate);
  }
  return [...unique.values()].sort((a, b) => b.confidence - a.confidence || a.creatorName.localeCompare(b.creatorName, "ko"));
}

export function knownAnimeIdentity(title: string, season?: number) {
  const normalized = normalizeTitle(title, season);
  const alias = builtInAliases.find(a => [a.korean, ...a.aliases].some(name => titleKey(name) === titleKey(normalized.baseTitle)));
  const offsets = alias?.episodeOffsets as Record<string,number> | undefined;
  const episodeOffset = offsets?.[String(normalized.season)] ?? 0;
  const nextOffset = offsets?.[String(normalized.season + 1)];
  return { aliases: alias?.aliases.filter(name => !/[가-힣]/.test(name)) ?? [], episodeOffset, episodeCount: nextOffset === undefined ? undefined : nextOffset - episodeOffset };
}

export class SubtitleClient {
  private readonly metadata: MetadataClient;
  private readonly collector: BlogCollector;
  private readonly concurrency: number;
  private readonly cacheTtl: number;
  private readonly configKey: string;
  constructor(private readonly options: SubtitleClientOptions = {}) {
    this.concurrency = positive(options.concurrency, 4, "concurrency", 16);
    this.cacheTtl = positive(options.cacheTtlMs, 86_400_000, "cacheTtlMs", 30 * 86_400_000);
    const http = new PublicHttpClient(
      positive(options.requestTimeoutMs, 4000, "requestTimeoutMs", 60_000),
      positive(options.maxResponseBytes, 20 * 1024 * 1024, "maxResponseBytes", 20 * 1024 * 1024),
    );
    this.metadata = new MetadataClient(http, options.aliases, options.enableAniList ?? true, d => this.report(d));
    this.collector = new BlogCollector(http, {
      maxZipBytes: positive(options.maxZipBytes, 40 * 1024 * 1024, "maxZipBytes", 40 * 1024 * 1024),
      maxZipEntries: positive(options.maxZipEntries, 300, "maxZipEntries", 1000),
      aliases: this.metadata.aliases,
    }, d => this.report(d));
    this.configKey = stableId(JSON.stringify(this.metadata.aliases), String(options.enableKairan ?? true), String(options.enableCsora ?? true), String(options.enableAniList ?? true), String(options.enableMelody ?? true));
  }

  async resolveTitle(raw: string, options: RequestOptions & { season?: number } = {}): Promise<ResolvedTitle> {
    normalizeTitle(raw, options.season);
    const scope = deadline(options);
    try {
      scope.signal.throwIfAborted();
      const resolved = await this.metadata.resolve(raw, options.season, scope.signal);
      scope.signal.throwIfAborted();
      return resolved;
    }
    finally { scope.dispose(); }
  }

  async resolveKoreanTitle(raw: string, options: RequestOptions & { season?: number } = {}): Promise<string> {
    return (await this.resolveTitle(raw, options)).title;
  }

  /** Verified alternate titles for AniList; no fuzzy translation. */
  async animeAliases(raw: string, options: RequestOptions & { season?: number } = {}): Promise<string[]> {
    const normalized = normalizeTitle(raw, options.season);
    const known = knownAnimeIdentity(raw, normalized.season);
    if (known.aliases.length) return known.aliases;
    const scope = deadline(options);
    try {
      const listed = await this.metadata.lookup([normalized.baseTitle], normalized.season, scope.signal);
      return listed?.originalSubject ? [listed.originalSubject] : [];
    } finally { scope.dispose(); }
  }

  private async resolveQuery(query: SubtitleQuery, signal: AbortSignal): Promise<ResolvedTitle> {
    const resolved = await this.metadata.resolve(query.title, query.season, signal, query.aliases);
    if (query.episodeOffset !== undefined) resolved.episodeOffset = query.episodeOffset;
    return resolved;
  }

  private validateQuery(query: SubtitleQuery) {
    normalizeTitle(query.title, query.season); validateEpisode(query.episode);
    if (query.episodeOffset !== undefined) validateOffset(query.episodeOffset);
  }

  async listCreators(query: SubtitleQuery): Promise<SubtitleCreator[]> {
    this.validateQuery(query);
    const scope = deadline(query);
    try {
      scope.signal.throwIfAborted();
      const resolved = await this.resolveQuery(query, scope.signal);
      const creators = await this.metadata.creators(resolved, query.episode, scope.signal);
      if (this.options.enableKairan !== false && !creators.some(c => c.website.startsWith("https://kairan03.blogspot.com/"))) creators.push(this.metadata.archive(resolved));
      if (this.options.enableCsora !== false && !creators.some(c => c.website.startsWith("https://csora556.blogspot.com/"))) creators.push(this.metadata.archive(resolved, true));
      if (this.options.enableMelody !== false && !creators.some(c => c.website.startsWith("https://melody88.tistory.com/"))) creators.push(this.metadata.archive(resolved, "melody"));
      const known = new Set(creators.map(c => creatorHome(c.website)));
      return [...creators, ...directoryCreators(resolved).filter(c => !known.has(creatorHome(c.website)))];
    } catch (error) { this.error("creators", error, scope.signal); return []; }
    finally { scope.dispose(); }
  }

  async fetchCreatorSubtitle(options: RequestOptions & { creator: SubtitleCreator; episode: number }): Promise<SubtitleCandidate | null> {
    validateEpisode(options.episode); normalizeTitle(options.creator.title, options.creator.season); validateOffset(options.creator.episodeOffset);
    const scope = deadline(options);
    try { return await this.collector.collect(options.creator, options.episode, scope.signal); }
    catch (error) { this.error("download", error, scope.signal); return null; }
    finally { scope.dispose(); }
  }

  private async cacheOperation<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    const scope = deadline({ signal, timeoutMs: 500 });
    try { return await abortable(fn(), scope.signal); }
    catch (error) { this.error("cache", error, scope.signal); return undefined; }
    finally { scope.dispose(); }
  }

  async searchSubtitles(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    this.validateQuery(query);
    const normalized = normalizeTitle(query.title, query.season);
    const cacheKey = `subtitles-ko:v4:${stableId(this.configKey, JSON.stringify(query.aliases || []), titleKey(normalized.baseTitle), normalized.season, query.episode, query.episodeOffset ?? "default")}`;
    const scope = deadline(query);
    const collected: SubtitleCandidate[] = [];
    try {
      scope.signal.throwIfAborted();
      if (this.options.cache) {
        const cached = await this.cacheOperation(() => this.options.cache!.get(cacheKey), scope.signal);
        if (cached && cached.expiresAt > Date.now() && cached.value.length) return deduplicateCandidates(cached.value);
      }
      const resolved = await this.resolveQuery(query, scope.signal);
      const archives = [
        ...(this.options.enableKairan !== false ? [this.metadata.archive(resolved)] : []),
        ...(this.options.enableCsora !== false ? [this.metadata.archive(resolved, true)] : []),
      ];
      let creators: SubtitleCreator[] = [];
      const archiveTask = parallel(archives, this.concurrency, scope.signal, async archive => {
        try { const candidate = await this.collector.collect(archive, query.episode, scope.signal); if (candidate) collected.push(candidate); }
        catch (error) { this.error("download", error, scope.signal); }
      });
      const creatorTask = this.metadata.creators(resolved, query.episode, scope.signal).then(async found => {
        // A known article is distinct from its creator's archive homepage.
        const location = (url: string) => { const parsed = new URL(url); parsed.hash = ""; return parsed.href; };
        const known = new Set(found.map(c => location(c.website)));
        found = [...found, ...directoryCreators(resolved).filter(c => !known.has(location(c.website)))];
        creators = found;
        // Skip duplicate homepages, never an article merely sharing their prefix.
        const pending = found.filter(c => !archives.some(a => location(c.website) === location(a.website)));
        await parallel(pending, this.concurrency, scope.signal, async creator => {
          const directOnly = archives.some(a => creatorHome(a.website) === creatorHome(creator.website));
          try { const result = await this.collector.collect(creator, query.episode, scope.signal, false, directOnly); if (result) collected.push(result); }
          catch (error) { this.error("download", error, scope.signal); }
        });
      });
      await abortable(Promise.allSettled([archiveTask, creatorTask]), scope.signal);
      // The legacy archive fills misses without adding requests/latency to already successful lookups.
      const melody = this.metadata.archive(resolved, "melody");
      if (!collected.length && !scope.signal.aborted && this.options.enableMelody !== false && !creators.some(c => c.website.startsWith(melody.website))) {
        const candidate = await this.collector.collect(melody, query.episode, scope.signal);
        if (candidate) collected.push(candidate);
      }
      // Only widen discovery after all ordinary lookups fail; do not compete with
      // another creator's already-in-flight subtitle download.
      if (!collected.length && !scope.signal.aborted) {
        await parallel(archives, this.concurrency, scope.signal, async archive => {
          try { const candidate = await this.collector.collect(archive, query.episode, scope.signal, true); if (candidate) collected.push(candidate); }
          catch (error) { this.error("download", error, scope.signal); }
        });
      }
      for (const candidate of collected) {
        const creator = creators.find(c => titleKey(c.name) === titleKey(candidate.creatorName));
        if (creator) candidate.creatorId = creator.id;
      }
      const results = deduplicateCandidates(collected);
      // Do not cache failures/empty searches or a timed-out partial search as a complete result.
      if (results.length && !scope.signal.aborted && this.options.cache) {
        await this.cacheOperation(() => this.options.cache!.set(cacheKey, { value: results, expiresAt: Date.now() + this.cacheTtl }), scope.signal);
      }
      return results;
    } catch (error) { this.error("download", error, scope.signal); return deduplicateCandidates(collected); }
    finally { scope.dispose(); }
  }

  private error(stage: Diagnostic["stage"], error: unknown, signal: AbortSignal) {
    this.report({ stage, code: failureCode(error, signal), message: error instanceof Error ? error.message : "Subtitle operation failed" });
  }
  private report(diagnostic: Diagnostic) {
    try { this.options.onDiagnostic?.(diagnostic); } catch { /* Observer errors must not discard results. */ }
  }
}

export function createSubtitleClient(options: SubtitleClientOptions = {}): SubtitleClient { return new SubtitleClient(options); }
const defaultClient = createSubtitleClient();
export const resolveKoreanTitle = defaultClient.resolveKoreanTitle.bind(defaultClient);
export const listCreators = defaultClient.listCreators.bind(defaultClient);
export const searchSubtitles = defaultClient.searchSubtitles.bind(defaultClient);
export const fetchCreatorSubtitle = defaultClient.fetchCreatorSubtitle.bind(defaultClient);
