import { directoryTitle } from "./directory.js";
import { createHash } from "node:crypto";
import builtInAliases from "./aliases.json" with { type: "json" };
import { PublicHttpClient } from "./http.js";
import { parallel, failureCode } from "./async.js";
import { normalizeTitle, titleKey, seasonTitle } from "./normalize.js";
import type { AliasEntry, ResolvedTitle, SubtitleCreator, Diagnostic } from "./types.js";

export const ANISSIA_API = "https://api.anissia.net";
export const CSORA_ARCHIVE = "https://csora556.blogspot.com/";
export const MELODY_ARCHIVE = "https://melody88.tistory.com/";
export const KAIRAN_ARCHIVE = "https://kairan03.blogspot.com/";
export function stableId(...parts: (string | number)[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24); }

export interface AnimeRecord { animeNo: number; subject: string; originalSubject: string }
function records(value: unknown): AnimeRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is AnimeRecord => !!v && typeof v === "object" &&
    Number.isInteger(v.animeNo) && typeof v.subject === "string" && v.subject.length > 0)
    .map(v => ({ ...v, originalSubject: typeof v.originalSubject === "string" ? v.originalSubject : "" }));
}

export class MetadataClient {
  readonly aliases: AliasEntry[];
  private scheduleCache?: { expires: number; items: AnimeRecord[] };
  constructor(private readonly http: PublicHttpClient, aliases: AliasEntry[] = [], private readonly useAniList = true,
    private readonly report: (diagnostic: Diagnostic) => void = () => {}) {
    this.aliases = [...aliases, ...builtInAliases as AliasEntry[]];
  }

  alias(title: string): AliasEntry | undefined {
    const key = titleKey(title);
    return this.aliases.find(a => [a.korean, ...a.aliases].some(v => titleKey(v) === key));
  }

  private async json(url: string, signal: AbortSignal) {
    const response = await this.http.get(url, { signal, maxBytes: 2 * 1024 * 1024 });
    const value = JSON.parse(response.body.toString("utf8"));
    if (value.code && value.code !== "ok") throw new Error("Anissia API returned an error");
    return value.data;
  }

  async schedule(signal: AbortSignal): Promise<AnimeRecord[]> {
    if (this.scheduleCache && this.scheduleCache.expires > Date.now()) return this.scheduleCache.items;
    const items: AnimeRecord[] = [];
    let successful = 0;
    await parallel(Array.from({ length: 9 }, (_, i) => i), 4, signal, async day => {
      try { items.push(...records(await this.json(`${ANISSIA_API}/anime/schedule/${day}`, signal))); successful++; }
      catch (error) { this.failure("resolve", error, signal); }
    });
    const unique = [...new Map(items.map(item => [item.animeNo, item])).values()];
    if (successful === 9) this.scheduleCache = { expires: Date.now() + 3_600_000, items: unique };
    return unique;
  }

  private find(items: AnimeRecord[], names: string[], season: number): AnimeRecord | undefined {
    const keys = names.map(name => titleKey(normalizeTitle(name).baseTitle));
    const found = items.filter(item => {
      const identity = (raw: string) => {
        // A verified named season; do not collapse the separate final specials.
        if (/^(?:진격의 거인|進撃の巨人|Attack on Titan) The Final Season$/i.test(raw)) return { baseTitle: raw.replace(/ The Final Season$/i, ''), season: 4 };
        // Anissia adds arc names in quotes after an explicit season number.
        const clean = /(?:\d+\s*기|第\s*\d+\s*期)/.test(raw) ? raw.replace(/\s*「[^」]*」\s*$/, '') : raw;
        return normalizeTitle(clean);
      };
      if (identity(item.subject).season !== season) return false;
      return [item.subject, item.originalSubject].filter(Boolean).some(name => keys.includes(titleKey(identity(name).baseTitle)));
    });
    return found.length === 1 ? found[0] : undefined;
  }

  async lookup(names: string[], season: number, signal: AbortSignal): Promise<AnimeRecord | undefined> {
    for (const name of [...new Set(names)].slice(0, 3)) {
      for (let page = 0; page < 3 && !signal.aborted; page++) {
        try {
          const data = await this.json(`${ANISSIA_API}/anime/list/${page}?q=${encodeURIComponent(name)}`, signal);
          const found = this.find(records(data?.content), names, season);
          if (found) return found;
          if (data?.last !== false) break;
        } catch (error) { this.failure("resolve", error, signal); break; }
      }
    }
    return undefined;
  }

  private async aniListNames(base: string, signal: AbortSignal): Promise<string[]> {
    try {
      const response = await this.http.get("https://graphql.anilist.co", {
        method: "POST", signal, maxBytes: 1024 * 1024,
        body: JSON.stringify({ query: "query($search:String!){Page(perPage:5){media(search:$search,type:ANIME){title{romaji english native}synonyms}}}", variables: { search: base } }),
      });
      const json = JSON.parse(response.body.toString("utf8"));
      const media: unknown = json.data?.Page?.media;
      if (!Array.isArray(media)) return [];
      for (const entry of media) {
        const names: string[] = [entry.title?.romaji, entry.title?.english, entry.title?.native, ...(Array.isArray(entry.synonyms) ? entry.synonyms : [])].filter((v): v is string => typeof v === "string" && !!v.trim());
        if (names.some(name => titleKey(normalizeTitle(name).baseTitle) === titleKey(base))) return names;
      }
    } catch (error) { this.failure("resolve", error, signal); }
    return [];
  }

  async resolve(raw: string, season: number | undefined, signal: AbortSignal, aliases: string[] = []): Promise<ResolvedTitle> {
    const normalized = normalizeTitle(raw, season);
    const alias = this.alias(normalized.baseTitle);
    const make = (baseTitle: string, source: ResolvedTitle["source"], confidence: number, animeNo?: number): ResolvedTitle => ({
      aliases: [...new Set([...aliases, ...(alias?.aliases ?? [])])], title: seasonTitle(baseTitle, normalized.season), baseTitle, season: normalized.season,
      episodeOffset: alias?.episodeOffsets?.[String(normalized.season)] ?? this.alias(baseTitle)?.episodeOffsets?.[String(normalized.season)] ?? 0,
      source, confidence, ...(animeNo !== undefined ? { animeNo } : {}),
    });
    if (alias) return make(alias.korean, "alias", 1);
    const registered = directoryTitle([normalized.baseTitle, ...aliases], normalized.season);
    if (registered) return make(registered, 'directory', .9);
    if (/[가-힣]/.test(normalized.baseTitle)) return make(normalized.baseTitle, "input", 0.8);
    const [scheduled, names] = await Promise.all([
      this.schedule(signal), this.useAniList ? this.aniListNames(normalized.baseTitle, signal) : Promise.resolve([]),
    ]);
    aliases = [...new Set([...aliases, ...names])];
    const variants = [normalized.baseTitle, ...aliases];
    const listed = this.find(scheduled, variants, normalized.season) ?? await this.lookup(variants, normalized.season, signal);
    if (listed) return make(normalizeTitle(listed.subject).baseTitle, names.length ? "anilist" : "anissia", 0.96, listed.animeNo);
    return make(normalized.baseTitle, "input", 0.3);
  }

  async creators(resolved: ResolvedTitle, episode: number, signal: AbortSignal): Promise<SubtitleCreator[]> {
    let anime = resolved.animeNo ? { animeNo: resolved.animeNo } : await this.lookup([resolved.baseTitle, ...(resolved.aliases || [])], resolved.season, signal);
    if (!anime && this.useAniList) {
      const input = resolved.aliases?.find(name => /[a-z]/i.test(name)) ?? resolved.baseTitle;
      const names = await this.aniListNames(normalizeTitle(input).baseTitle, signal);
      if (names.length) anime = await this.lookup(names, resolved.season, signal);
    }
    if (!anime) return [];
    try {
      const data: unknown = await this.json(`${ANISSIA_API}/anime/caption/animeNo/${anime.animeNo}`, signal);
      if (!Array.isArray(data)) return [];
      const creators: SubtitleCreator[] = [];
      for (const item of data) {
        if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
        const latestEpisode = String(item.episode ?? "");
        creators.push({
          id: stableId(anime.animeNo, item.name.trim()), name: item.name.trim(),
          website: typeof item.website === "string" ? item.website.trim() : "",
          latestEpisode, updatedAt: typeof item.updDt === "string" ? item.updDt + (/Z|[+-]\d\d:\d\d$/.test(item.updDt) ? "" : "+09:00") : undefined,
          isCurrentEpisode: [episode, episode + resolved.episodeOffset].includes(Number(latestEpisode)),
          aliases: [...new Set([...(resolved.aliases ?? []), ...("subject" in anime ? [anime.subject, anime.originalSubject].filter(Boolean) : [])])], source: "anissia", animeNo: anime.animeNo, title: resolved.title, season: resolved.season,
          episodeOffset: resolved.episodeOffset, confidence: Math.min(resolved.confidence, 0.96),
        });
      }
      return [...new Map(creators.map(c => [titleKey(c.name), c])).values()];
    } catch (error) { this.failure("creators", error, signal); return []; }
  }

  // Public subtitle creator attribution, not a streaming-source or extension repository default.
  archive(resolved: ResolvedTitle, source: boolean | "melody" = false): SubtitleCreator {
    const archive = source === "melody" ? { id: "melody", name: "Melody", website: MELODY_ARCHIVE }
      : source ? { id: "csora", name: "Csora", website: CSORA_ARCHIVE }
      : { id: "kairan", name: "카이란", website: KAIRAN_ARCHIVE };
    return { ...archive, id: stableId(archive.id, resolved.title), aliases: resolved.aliases,
      source: "archive", title: resolved.title, season: resolved.season, episodeOffset: resolved.episodeOffset,
      isCurrentEpisode: false, confidence: Math.min(resolved.confidence, 0.85) };
  }

  private failure(stage: Diagnostic["stage"], error: unknown, signal: AbortSignal) {
    this.report({ stage, code: failureCode(error, signal), message: error instanceof Error ? error.message : "Metadata request failed" });
  }
}
