// Development-only API stand-in (VITE_MOCK=1). It answers the same contract
// as apps/server so screens can be built before the server lands.
import type { VideoSource, Episode, HomeResponse, MediaCard, MediaDetail, PlaybackSession, Profile, ProviderRef, Row, Settings, SubtitleTrack } from "@moa/shared";
import type { JimakuCandidate, JimakuSearch, TranslationConfig, TranslationJob } from "./translation";

const local: ProviderRef = { id: "local", name: "내 라이브러리", kind: "local" };
const ext: ProviderRef = { id: "ext-demo", name: "데모 확장", kind: "mangayomi-js" };
const img = (name: string) => `/__mock/${name}.jpg`;
const now = Date.now();

const oshiEpisodes: Episode[] = Array.from({ length: 13 }, (_, i) => ({
  id: `oshi-e${i + 1}`,
  mediaId: "oshi",
  season: 2,
  number: i + 1,
  title: `${i + 1}화`,
  thumb: img(`oshi-${i + 1}`),
  duration: 1420 + (i % 3) * 30,
  progress: i < 2 ? { position: 1420, duration: 1420, completed: true, updatedAt: new Date(now - 86_400_000).toISOString() }
    : i === 2 ? { position: 612, duration: 1450, completed: false, updatedAt: new Date(now - 3_600_000).toISOString() } : undefined
}));

const cards: MediaCard[] = [
  { id: "oshi", title: "예제 시리즈 2기", type: "anime", backdrop: img("oshi-3"), year: 2024, genres: ["드라마", "미스터리"], provider: local, episodeCount: 13,
    progress: { episodeId: "oshi-e3", ratio: 612 / 1450, label: "S2:E3 · 14분 남음" }, badge: "새 에피소드", addedAt: new Date(now - 7_200_000).toISOString() },
  { id: "lalaland", title: "라라랜드", type: "movie", backdrop: img("lalaland-a"), year: 2016, genres: ["뮤지컬", "로맨스"], provider: local,
    progress: { episodeId: "lalaland-m", ratio: .31, label: "1시간 29분 남음" }, addedAt: new Date(now - 86_400_000 * 2).toISOString() },
  { id: "demo-1", title: "밤의 도시를 걷다", type: "series", backdrop: img("oshi-7"), year: 2025, genres: ["드라마"], provider: ext, episodeCount: 8 },
  { id: "demo-2", title: "여름의 끝에서", type: "movie", backdrop: img("lalaland-b"), year: 2023, genres: ["로맨스"], provider: ext },
  { id: "demo-3", title: "스테이지 뒤편", type: "anime", backdrop: img("oshi-10"), year: 2024, genres: ["음악"], provider: ext, episodeCount: 12 },
  { id: "demo-4", title: "포스터가 없는 아주 긴 제목의 작품 예시", type: "series", year: 2022, genres: ["스릴러"], provider: ext, episodeCount: 16 },
  { id: "demo-5", title: "원피스 (예시)", type: "anime", backdrop: img("oshi-11"), provider: local, episodeCount: 128 },
  { id: "demo-6", title: "그 겨울", type: "movie", backdrop: img("oshi-12"), year: 2021, genres: ["드라마"], provider: ext },
  { id: "demo-7", title: "작은 무대", type: "anime", backdrop: img("oshi-5"), year: 2025, genres: ["코미디"], provider: ext, episodeCount: 10 },
  { id: "demo-8", title: "레드 카펫", type: "series", backdrop: img("oshi-9"), year: 2020, genres: ["드라마", "미스터리"], provider: ext, episodeCount: 6 }
];

const byId = new Map(cards.map(card => [card.id, card]));
let watchlist = new Set(["lalaland", "demo-3"]);
let profiles: Profile[] = [
  { id: "p1", name: "코호", color: "violet", kids: false, createdAt: new Date().toISOString() },
  { id: "p2", name: "가족", color: "teal", kids: false, createdAt: new Date().toISOString() }
];
let settings: Settings = { groupHistory: true, autoplayNext: true, autoplayDelay: 5, defaultSubtitleLang: "ko", subtitleSize: "medium", preferredQuality: "auto", hardwareTranscoding: true, autoFetchSubtitles: true, translationMode: "manual", translationSourcePriority: "site", skipSubtitleSearchWithSiteTrack: true, skipTranslationWithoutSubtitles: true };

function detail(id: string): MediaDetail | null {
  const card = byId.get(id);
  if (!card) return null;
  if (id === "oshi") {
    return {
      ...card, inWatchlist: watchlist.has(id),
      overview: "연예계의 빛과 그림자를 배경으로, 쌍둥이 남매가 어머니의 죽음에 얽힌 진실을 좇는다. 2.5차원 무대를 둘러싼 새로운 이야기가 시작된다.",
      rating: 8.6, cast: ["타카하시 리에", "오오츠카 유이"],
      seasons: [{ number: 2, title: "시즌 2", episodes: oshiEpisodes }],
      playTarget: { episodeId: "oshi-e3", position: 612, label: "이어보기 S2:E3" },
      fileInfo: { container: "MKV", video: "HEVC 10bit", audio: "AAC 2.0", resolution: "1080p", size: 5_300_000_000 }
    };
  }
  const movie = card.type === "movie";
  const episodes: Episode[] = movie
    ? [{ id: `${id}-m`, mediaId: id, season: 1, number: 1, title: card.title, duration: 7680, thumb: card.backdrop }]
    : Array.from({ length: card.episodeCount ?? 6 }, (_, i) => ({ id: `${id}-e${i + 1}`, mediaId: id, season: 1, number: i + 1, title: `${i + 1}화`, duration: 2700 }));
  return {
    ...card, inWatchlist: watchlist.has(id),
    overview: movie ? "꿈을 좇는 두 사람이 로스앤젤레스에서 만나 사랑에 빠지지만, 성공이 가까워질수록 서로의 길이 엇갈리기 시작한다." : undefined,
    runtime: movie ? 7680 : undefined, rating: movie ? 8.0 : undefined,
    seasons: [{ number: 1, title: movie ? "영화" : "시즌 1", episodes }],
    playTarget: { episodeId: episodes[0].id, position: id === "lalaland" ? 2380 : 0, label: id === "lalaland" ? "이어보기" : "재생" },
    fileInfo: id === "lalaland" ? { container: "MKV", video: "HEVC 10bit", audio: "E-AC3 5.1", resolution: "1080p", size: 2_800_000_000 } : undefined
  };
}

function home(type?: string): HomeResponse {
  const pool = cards.filter(card => !type || card.type === type);
  const rows: Row[] = [
    { id: "continue", title: "이어보기", kind: "continue", layout: "landscape", items: pool.filter(card => card.progress) },
    { id: "watchlist", title: "볼 목록", kind: "watchlist", layout: "poster", items: pool.filter(card => watchlist.has(card.id)), more: { path: "/my-list" } },
    { id: "recent", title: "최근 추가된 작품", kind: "recent", layout: "poster", items: pool },
    { id: "anime", title: "애니메이션", kind: "media", layout: "poster", items: pool.filter(card => card.type === "anime"), more: { path: "/anime" } },
    { id: "movies", title: "영화", kind: "media", layout: "poster", items: pool.filter(card => card.type === "movie"), more: { path: "/movies" } },
    { id: "genre-drama", title: "드라마 장르", kind: "genre", layout: "poster", items: pool.filter(card => card.genres?.includes("드라마")) }
  ].filter(row => row.items.length) as Row[];
  return { hero: pool.filter(card => card.backdrop).slice(0, 4), rows };
}

let sessionCount = 0;
const retiredSessions = new Set<string>();
function playback(episodeId: string): PlaybackSession {
  const sessionId = `mock-${++sessionCount}-${episodeId}`;
  const oshi = oshiEpisodes.findIndex(item => item.id === episodeId);
  const next = oshi >= 0 && oshi < oshiEpisodes.length - 1 ? oshiEpisodes[oshi + 1] : null;
  const movie = episodeId.endsWith("-m");
  const mediaId = oshi >= 0 ? "oshi" : episodeId.replace(/-(m|e\d+)$/, "");
  const card = byId.get(mediaId);
  return {
    sessionId, episodeId, mode: "direct",
    mediaId, mediaTitle: card?.title ?? "작품", mediaType: card?.type ?? "series",
    episodeTitle: movie ? undefined : oshi >= 0 ? oshiEpisodes[oshi].title : "1화",
    episodeLabel: movie ? undefined : oshi >= 0 ? `S2:E${oshi + 1}` : "S1:E1",
    // A public HLS test stream keeps the player testable without the server; browser checks can point
    // `moa.mockVideo` at a local MP4 instead.
    ...(localStorage.getItem("moa.mockVideo")
      ? { url: localStorage.getItem("moa.mockVideo")!, mime: "video/mp4" as const }
      : { url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", mime: "application/vnd.apple.mpegurl" as const }),
    duration: 596, startPosition: episodeId === "oshi-e3" ? 95 : 0, audioTracks: [{ id: "a1", label: "일본어", lang: "ja", default: true }, ...(oshi >= 0 ? [{ id: "a2", label: "영어", lang: "en" }] : [])],
    // demo-3 has no subtitles at all (Jimaku is the only way to Korean).
    subtitles: mediaId === "demo-3" ? [] : oshi >= 0
      // Session-bound like the server's: the URL stops working once the session is retired.
      ? [{ id: "s0", label: "일본어 (파일)", lang: "ja", format: "vtt", url: `/api/playback/${sessionId}/subtitles/s0.vtt`, default: true, source: "local" }]
      : [{ id: "s1", label: "한국어", lang: "ko", format: "vtt", url: "data:text/vtt,WEBVTT%0A%0A00:00:01.000 --> 00:00:06.000%0A자막 미리보기입니다.", default: true },
         ...(mediaId === "lalaland" ? [{ id: "s2", label: "영어", lang: "en", format: "vtt" as const, url: "data:text/vtt,WEBVTT%0A%0A00:00:01.000 --> 00:00:30.000%0AEnglish preview subtitle.", source: "local" as const }] : [])],
    next: next ? { episodeId: next.id, title: `${next.number}화`, label: `S2:E${next.number}`, thumb: next.thumb } : null,
    markers: { introStart: 20, introEnd: 80, creditsStart: 480, creditsEnd: 540, source: "fingerprint" }
  };
}

/* Subtitle translation: jobs advance with wall-clock time so polling shows progress. */
let tmdbConfig: { configured: boolean; source: string; credentialType: string | null; hasSavedCredential: boolean } = { configured: false, source: "none", credentialType: null, hasSavedCredential: false };
let remoteAt = 0;
let remote: any = { mode: "off", state: "off", url: null, urls: [], loginUrl: null, funnel: false, lastError: null, externallyManaged: false, available: true, desiredEnabled: false, gatewayServiceUrl: "http://moa-gateway:8080", warning: null, config: { mode: "off", publicHostname: "", funnel: false, cloudflareToken: null, tailscaleAuthKey: null } };
let translationConfig: TranslationConfig = { configured: false, enabled: false, model: "gemini-flash-latest", batchSize: 120, requestIntervalMs: 1000, retryCount: 2, keys: [] };
// Secrets stay here; the config only carries masked labels. A key containing "fail" fails jobs, "bad" fails validation.
let translationSecrets: Array<{ id: string; secret: string }> = [];
const activeKey = () => translationSecrets.find(item => !item.secret.includes("bad"))?.secret ?? "";
const mask = (secret: string) => `${secret.slice(0, 4)}…${secret.slice(-4)}`;
function setSecrets(next: typeof translationSecrets) {
  translationSecrets = next.slice(0, 8);
  const keys = translationSecrets.map(item => ({ id: item.id, label: mask(item.secret) }));
  translationConfig = { ...translationConfig, keys, configured: keys.length > 0, enabled: translationConfig.enabled && keys.length > 0 };
}
// Like the server: work is shared per cache key (same original), batches run near `startAt` first
// (25 cues, then batchSize), ranges list the times of translated cues only, and partial tracks get a new revision URL.
type MockJob = { id: string; episodeId: string; key: string; state: TranslationJob["state"]; error?: string; model: string; cached: boolean; origin?: { creatorName: string; sourceUrl: string } };
type MockWork = { cues: Array<{ start: number; end: number }>; translated: number[]; queue: number[]; revision: number; complete: boolean; failed?: string; nextAt: number; first: boolean };
const translationJobs = new Map<string, MockJob>();
const translationWork = new Map<string, MockWork>();
const translatedTracks = new Map<string, SubtitleTrack[]>();
const BATCH_MS = Math.max(1200, Number(localStorage.getItem("moa.mockTranslationBatchMs")) || 1200);
function hash(text: string) { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const clock = (s: number) => new Date(s * 1000).toISOString().slice(11, 23);
function cuesOf(content: string, fallback: number) {
  const found = [...content.matchAll(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g)]
    .map(m => ({ start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000 }));
  if (found.length >= 10) return found;
  // Short mock originals: spread `fallback` cues over the 600 s mock episode, 3 s of speech every ~10 s.
  return Array.from({ length: fallback }, (_, i) => ({ start: 5 + i * 590 / fallback, end: 8 + i * 590 / fallback }));
}
function queueFrom(work: MockWork, at: number) {
  const missing = work.cues.map((_, i) => i).filter(i => !work.translated.includes(i));
  const from = missing.findIndex(i => work.cues[i].end > at);
  return from <= 0 ? missing : [...missing.slice(from), ...missing.slice(0, from)];
}
const ranges = (work: MockWork) => work.translated.map(i => work.cues[i]).sort((a, b) => a.start - b.start)
  .reduce<Array<{ start: number; end: number }>>((list, cue) => { const last = list.at(-1); if (last && cue.start <= last.end) last.end = Math.max(last.end, cue.end); else list.push({ ...cue }); return list; }, []);
function trackOf(job: MockJob, work: MockWork): SubtitleTrack | undefined {
  if (!work.revision) return undefined;
  const body = work.translated.slice().sort((a, b) => a - b).map(i => `${clock(work.cues[i].start)} --> ${clock(work.cues[i].end)}\n[AI] ${i + 1}번째 대사`).join("\n\n");
  return { id: `translation-${job.key}`, label: "한국어 · AI 번역", lang: "ko", format: "vtt", source: "translation", default: false, ...(job.origin ? { provenance: job.origin } : {}),
    url: `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n${body}\n`)}#revision=${work.revision}` };
}
function advance(key: string) {
  const work = translationWork.get(key)!;
  const active = [...translationJobs.values()].some(job => job.key === key && (job.state === "queued" || job.state === "running"));
  while (active && !work.complete && !work.failed && Date.now() >= work.nextAt && work.queue.length) {
    let size = work.first ? Math.min(25, translationConfig.batchSize) : translationConfig.batchSize;
    // The server wraps to earlier cues in a separate batch.
    const wrap = work.queue.findIndex((id, index) => index > 0 && id < work.queue[index - 1]);
    if (wrap > 0) size = Math.min(size, wrap);
    if (activeKey().includes("fail") && work.translated.length + Math.min(size, work.queue.length) >= work.cues.length / 2) { work.failed = "translation-unavailable"; break; }
    work.first = false;
    work.translated.push(...work.queue.splice(0, size));
    work.revision++;
    work.nextAt += BATCH_MS;
  }
  if (!work.queue.length && !work.complete && !work.failed) work.complete = true;
  for (const job of translationJobs.values()) {
    if (job.key !== key || (job.state !== "queued" && job.state !== "running")) continue;
    if (work.complete) {
      job.state = "completed";
      const track = trackOf(job, work)!;
      translatedTracks.set(job.episodeId, [...(translatedTracks.get(job.episodeId) ?? []).filter(item => item.id !== track.id), track]);
    } else if (work.failed) Object.assign(job, { state: "failed", error: work.failed });
    else job.state = work.revision || Date.now() >= work.nextAt - BATCH_MS / 2 ? "running" : "queued";
  }
}
function publicJob(job: MockJob): TranslationJob {
  advance(job.key);
  const work = translationWork.get(job.key)!;
  const track = trackOf(job, work);
  return { id: job.id, episodeId: job.episodeId, state: job.state, done: work.translated.length, total: work.cues.length, model: job.model, cached: job.cached,
    ...(job.error ? { error: job.error } : {}), ...(track ? { track } : {}), revision: work.revision, partial: !work.complete, translatedRanges: ranges(work) };
}
function createJob(episodeId: string, key: string, content: string, fallback: number, startAt = 0, origin?: MockJob["origin"]) {
  let work = translationWork.get(key);
  if (!work) translationWork.set(key, work = { cues: cuesOf(content, fallback), translated: [], queue: [], revision: 0, complete: false, nextAt: 0, first: true });
  const cached = work.complete;
  if (!cached) { work.failed = undefined; work.queue = queueFrom(work, startAt); work.nextAt = Date.now() + 900; }
  const counters = window as unknown as { __moaJobsCreated?: number };
  counters.__moaJobsCreated = (counters.__moaJobsCreated ?? 0) + 1;
  const job: MockJob = { id: `job-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, episodeId, key, state: cached ? "completed" : "queued", model: translationConfig.model, cached, origin };
  translationJobs.set(job.id, job);
  return job;
}
const jimakuSearches = new Map<string, { episodeId: string; candidates: JimakuCandidate[] }>();
function jimakuSearch(episodeId: string, params: URLSearchParams): JimakuSearch {
  const session = playback(episodeId);
  const movie = session.mediaType === "movie";
  const fallback = Number(session.episodeLabel?.split("E")[1] ?? 1);
  const query = { title: params.get("title") || (movie ? "Example Film" : "Example Series"), season: Number(params.get("season") ?? (movie ? 1 : 2)), episode: Number(params.get("episode") ?? fallback) };
  const pad = String(query.episode).padStart(2, "0");
  const candidates: JimakuCandidate[] = /없는|none/i.test(query.title) ? [] : movie
    ? [{ id: "j1", title: query.title, filename: `${query.title}.2016.ja.srt`, format: "srt", language: "ja", sourceUrl: "https://example.com/subtitles/1", match: "movie" }]
    : [
        { id: "j1", title: query.title, filename: `[Example] ${query.title} S${query.season} - ${pad}.ass`, format: "ass", language: "ja", sourceUrl: "https://example.com/subtitles/2", episode: query.episode, match: "episode" },
        { id: "j2", title: query.title, filename: `${query.title} ${pad} (WEB).srt`, format: "srt", language: "ja", sourceUrl: "https://example.com/subtitles/2", episode: query.episode, match: "episode" },
        { id: "j3", title: query.title, filename: `${query.title} 第${query.season}期 全話.zip.ass`, format: "ass", language: "ja", sourceUrl: "https://example.com/subtitles/2", match: "unverified" }
      ];
  const searchId = `js-${Date.now().toString(36)}`;
  jimakuSearches.set(searchId, { episodeId, candidates });
  return { searchId, query, candidates };
}
// The real server keeps this state; persist it per tab so reloads and page.goto behave the same.
const MOCK_TRANSLATION = "moa.mockTranslation";
function saveTranslationState() {
  try { sessionStorage.setItem(MOCK_TRANSLATION, JSON.stringify({ settings, translationConfig, translationSecrets, jobs: [...translationJobs], tracks: [...translatedTracks], work: [...translationWork], searches: [...jimakuSearches] })); } catch { /* ignore */ }
}
function loadTranslationState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(MOCK_TRANSLATION) || "null");
    if (!saved) return;
    settings = { ...settings, ...saved.settings }; translationConfig = saved.translationConfig; translationSecrets = saved.translationSecrets;
    saved.jobs.forEach(([id, job]: [string, MockJob]) => translationJobs.set(id, job));
    saved.tracks.forEach(([id, tracks]: [string, SubtitleTrack[]]) => translatedTracks.set(id, tracks));
    saved.work.forEach(([id, work]: [string, MockWork]) => translationWork.set(id, work));
    saved.searches.forEach(([id, search]: [string, { episodeId: string; candidates: JimakuCandidate[] }]) => jimakuSearches.set(id, search));
  } catch { /* ignore */ }
}

/* Video sources (management screen preview): icons that load, fail or are missing, and language editions sharing a name. */
const icon = (color: string, letter: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`)}`;
const sourceRepo = "https://example.com/index.min.json";
let videoSources: VideoSource[] = [
  { id: "sample-kr", name: "Sample KR", lang: "ko", version: "1.2.0", installedVersion: "1.2.0", installed: true, enabled: true, type: "series", live: false, repository: sourceRepo, kind: "mangayomi-js", iconUrl: icon("#16a34a", "코") },
  { id: "example-en", name: "Example Source A", lang: "en", version: "0.9.1", installed: false, enabled: false, type: "anime", live: false, repository: sourceRepo, kind: "mangayomi-js", iconUrl: icon("#2563eb", "P") },
  { id: "multi-en", name: "Sample Multilingual", lang: "en", version: "14.3", installedVersion: "14.2", installed: true, enabled: true, type: "anime", live: false, repository: sourceRepo, kind: "aniyomi-apk", iconUrl: "/api/images/source-icons/missing.png" },
  { id: "multi-all", name: "Sample Multilingual", lang: "all", version: "14.3", installed: false, enabled: false, type: "anime", live: false, repository: sourceRepo, kind: "aniyomi-apk" },
  { id: "m-live", name: "라이브 채널", lang: "ko", version: "2.0.0", installedVersion: "2.0.0", installed: true, enabled: false, type: "series", live: true, repository: sourceRepo, kind: "mangayomi-js" }
];

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  loadTranslationState();
  window.fetch = async (input, init) => {
    const response = await handle(input, init);
    if (/translation|jimaku|settings/.test(String(input instanceof Request ? input.url : input))) saveTranslationState();
    return response;
  };
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    await delay(350 + Math.random() * 450); // keep skeletons visible
    const path = url.pathname.slice(4);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/health") return json({ ok: true, version: "mock" });
    if (path === "/profiles" && method === "GET") return json(profiles);
    if (path === "/profiles" && method === "POST") { const p = { id: `p${Date.now()}`, name: body.name, color: body.color ?? "blue", kids: Boolean(body.kids), createdAt: new Date().toISOString() }; profiles = [...profiles, p]; return json(p); }
    if (path === "/home") return json(home(url.searchParams.get("type") ?? undefined));
    if (path.startsWith("/media/")) { const d = detail(decodeURIComponent(path.slice(7))); return d ? json(d) : json({ error: "not-found" }, 404); }
    if (path === "/media") { const type = url.searchParams.get("type"); const items = cards.filter(card => !type || card.type === type); return json({ items, page: 1, hasNextPage: false, total: items.length }); }
    if (path === "/genres") return json(["드라마", "로맨스", "뮤지컬", "미스터리", "음악", "코미디", "스릴러"]);
    if (path === "/search") { const q = (url.searchParams.get("q") ?? "").toLowerCase(); const hit = cards.filter(card => card.title.toLowerCase().includes(q)); return json({ query: q, groups: [{ provider: local, items: hit.filter(card => card.provider.id === "local") }, { provider: ext, items: hit.filter(card => card.provider.id !== "local") }] }); }
    if (path === "/watchlist") return json(cards.filter(card => watchlist.has(card.id)));
    if (path.startsWith("/watchlist/")) { const id = decodeURIComponent(path.slice(11)); watchlist = new Set(watchlist); if (method === "PUT") watchlist.add(id); else watchlist.delete(id); return json(null, 204); }
    if (path === "/history") return json({ items: [], page: 1, hasNextPage: false });
    if (path === "/progress") return json({ position: body.position, duration: body.duration, completed: false, updatedAt: new Date().toISOString() });
    if (path === "/playback" && method === "POST") { const session = playback(body.episodeId); return json({ ...session, subtitles: [...session.subtitles, ...(translatedTracks.get(body.episodeId) ?? [])] }); }
    const sessionFile = /^\/playback\/([^/]+)\/subtitles\/s0\.vtt$/.exec(path);
    if (sessionFile) {
      if (retiredSessions.has(sessionFile[1])) { (window as unknown as { __moaStaleReads?: number }).__moaStaleReads = ((window as unknown as { __moaStaleReads?: number }).__moaStaleReads ?? 0) + 1; return json({ error: "session-expired" }, 410); }
      return new Response(`WEBVTT\n\n00:00:01.000 --> 00:00:30.000\n日本語字幕 ${sessionFile[1].replace(/^mock-\d+-/, "")}\n`, { headers: { "Content-Type": "text/vtt" } });
    }
    if (/^\/playback\/[^/]+$/.test(path) && method === "DELETE") { retiredSessions.add(path.split("/")[2]); return json(null, 204); }
    if (path.startsWith("/playback/")) return json(null, 204);
    if (/^\/episodes\/[^/]+\/subtitles\/online$/.test(path) && method === "GET") {
      await delay(2500);
      if (path.includes("demo-3")) return json({ searchId: "s-0", resolvedTitle: "스테이지 뒤편", partial: false, expiresAt: Date.now() + 300_000, candidates: [] });
      return json({ searchId: "s-1", resolvedTitle: "예제 시리즈 2기", partial: true, expiresAt: Date.now() + 300_000, candidates: [
        { id: "c1", creatorName: "예제 제작자 A", sourceUrl: "https://example.com/creator-a", filename: "03.ass", format: "ass", matchedEpisode: 3, confidence: 0.92 },
        { id: "c2", creatorName: "예제 제작자 B", sourceUrl: "https://example.com/creator-b", filename: "03.ass", format: "ass", matchedEpisode: 3, confidence: 0.81 },
        { id: "c3", creatorName: "예제 제작자 C", sourceUrl: "https://example.com/x", filename: "04.smi", format: "vtt", matchedEpisode: 4, confidence: 0.35 }
      ] });
    }
    if (/^\/episodes\/[^/]+\/subtitles\/online$/.test(path) && method === "POST") {
      const who = body.candidateId === "c2" ? "예제 제작자 B" : body.candidateId === "c3" ? "예제 제작자 C" : "예제 제작자 A";
      return json({ id: `online-${body.candidateId}`, label: `${who} · 한국어`, lang: "ko", format: "vtt", source: "online", provenance: { creatorName: who, sourceUrl: "https://example.com" },
        url: `data:text/vtt,WEBVTT%0A%0A00:00:00.000 --> 00:10:00.000%0A${encodeURIComponent(who)} 님의 한국어 자막` });
    }
    if (path === "/admin/tmdb/config") {
      if (method === "PATCH") tmdbConfig = "clear" in body ? { configured: false, source: "none", credentialType: null, hasSavedCredential: false } : { configured: true, source: "database", credentialType: "apiKey" in body ? "apiKey" : "token", hasSavedCredential: true };
      return json(tmdbConfig);
    }
    if (path.startsWith("/admin/remote-access")) {
      const action = path.split("/")[3];
      if (action === "configure") remote = { ...remote, mode: body.mode, funnel: body.funnel ?? remote.funnel, config: { ...remote.config, mode: body.mode, publicHostname: body.publicHostname ?? remote.config.publicHostname, funnel: body.funnel ?? remote.config.funnel, cloudflareToken: body.cloudflareToken ? "********" : remote.config.cloudflareToken } };
      if (action === "start") { remote = { ...remote, desiredEnabled: true, state: "starting", url: null, urls: [] }; remoteAt = Date.now(); }
      if (action === "stop") remote = { ...remote, desiredEnabled: false, state: "off", url: null, urls: [], loginUrl: null };
      if (remote.desiredEnabled && remote.state !== "connected" && Date.now() - remoteAt > 2500) {
        const url = remote.mode === "cloudflare-quick" ? "https://quiet-river-sample-demo.trycloudflare.com" : remote.mode === "cloudflare-token" ? `https://${remote.config.publicHostname}` : "https://moa.tail1234.ts.net";
        remote = remote.mode === "tailscale" && remote.state === "starting" ? { ...remote, state: "needs-login", loginUrl: "https://login.tailscale.com/a/example" } : { ...remote, state: "connected", url, urls: [url], loginUrl: null };
        remoteAt = Date.now();
      }
      return json(remote);
    }
    if (path === "/translation/config") return json(translationConfig);
    if (path === "/admin/translation/config" && method === "PATCH") {
      const added = [...(typeof body.apiKey === "string" ? [body.apiKey] : []), ...(Array.isArray(body.addKeys) ? body.addKeys : [])].map((key: string) => key.trim()).filter(Boolean);
      if (translationSecrets.length + added.length > 8) return json({ error: "translation-too-many-keys" }, 400);
      if (body.clearKey) setSecrets([]);
      if (Array.isArray(body.removeKeyIds)) setSecrets(translationSecrets.filter(item => !body.removeKeyIds.includes(item.id)));
      if (added.length) setSecrets([...translationSecrets, ...added.filter((secret: string) => !translationSecrets.some(item => item.secret === secret)).map((secret: string, i: number) => ({ id: `k${Date.now().toString(36)}${i}`, secret }))]);
      if (typeof body.model === "string") translationConfig = { ...translationConfig, model: body.model };
      if (body.requestIntervalMs !== undefined && !(Number.isInteger(body.requestIntervalMs) && body.requestIntervalMs >= 0 && body.requestIntervalMs <= 60_000)) return json({ error: "translation-config-invalid" }, 400);
      if (body.retryCount !== undefined && !(Number.isInteger(body.retryCount) && body.retryCount >= 0 && body.retryCount <= 5)) return json({ error: "translation-config-invalid" }, 400);
      if (body.requestIntervalMs !== undefined) translationConfig = { ...translationConfig, requestIntervalMs: body.requestIntervalMs };
      if (body.retryCount !== undefined) translationConfig = { ...translationConfig, retryCount: body.retryCount };
      if (typeof body.batchSize === "number") translationConfig = { ...translationConfig, batchSize: Math.min(300, Math.max(10, Math.round(body.batchSize))) };
      if (typeof body.enabled === "boolean") translationConfig = { ...translationConfig, enabled: body.enabled && translationConfig.configured };
      return json(translationConfig);
    }
    if (path === "/admin/translation/models") {
      if (!translationConfig.configured) return json({ error: "translation-not-configured" }, 400);
      if (!activeKey()) return json({ error: "translation-key-invalid" }, 400);
      return json({ models: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"] });
    }
    if (/^\/episodes\/[^/]+\/subtitles\/translate$/.test(path) && method === "POST") {
      if (!translationConfig.configured) return json({ error: "translation-not-configured" }, 409);
      if (!translationConfig.enabled) return json({ error: "translation-disabled" }, 409);
      if (typeof body.content !== "string" || !body.content.trim()) return json({ error: "translation-invalid-subtitle" }, 400);
      if (new TextEncoder().encode(body.content).length > 1024 * 1024) return json({ error: "translation-subtitle-too-large" }, 413);
      return json(publicJob(createJob(decodeURIComponent(path.split("/")[2]), hash(`${body.format}:${body.content}`), body.content, 60, body.startAt)));
    }
    if (/^\/episodes\/[^/]+\/subtitles\/jimaku$/.test(path) && method === "GET") {
      await delay(1200);
      const counters = window as unknown as { __moaJimakuSearches?: number };
      counters.__moaJimakuSearches = (counters.__moaJimakuSearches ?? 0) + 1;
      return json(jimakuSearch(decodeURIComponent(path.split("/")[2]), url.searchParams));
    }
    if (/^\/episodes\/[^/]+\/subtitles\/jimaku\/translate$/.test(path) && method === "POST") {
      if (!translationConfig.configured) return json({ error: "translation-not-configured" }, 409);
      if (!translationConfig.enabled) return json({ error: "translation-disabled" }, 409);
      const episodeId = decodeURIComponent(path.split("/")[2]);
      const search = jimakuSearches.get(body.searchId);
      if (!search || search.episodeId !== episodeId) return json({ error: "jimaku-search-expired" }, 410);
      const candidate = search.candidates.find(item => item.id === body.candidateId);
      if (!candidate) return json({ error: "jimaku-file-not-found" }, 404);
      return json(publicJob(createJob(episodeId, hash(`jimaku:${candidate.filename}`), "", 60, body.startAt, { creatorName: "Jimaku", sourceUrl: candidate.sourceUrl })));
    }
    if (/^\/translations\/[^/]+\/priority$/.test(path) && method === "POST") {
      const job = translationJobs.get(decodeURIComponent(path.split("/")[2]));
      if (!job) return json({ error: "translation-job-not-found" }, 404);
      const work = translationWork.get(job.key)!;
      if (job.state === "queued" || job.state === "running") work.queue = queueFrom(work, Number(body.startAt) || 0);
      (window as unknown as { __moaPriority?: number[] }).__moaPriority = [...((window as unknown as { __moaPriority?: number[] }).__moaPriority ?? []), Number(body.startAt)];
      return json(null, 204);
    }
    if (/^\/translations\/[^/]+$/.test(path)) {
      const job = translationJobs.get(decodeURIComponent(path.split("/")[2]));
      if (!job) return json({ error: "translation-job-not-found" }, 404);
      if (method === "DELETE") { advance(job.key); if (job.state === "queued" || job.state === "running") job.state = "cancelled"; return json(null, 204); }
      return json(publicJob(job));
    }
    if (/^\/episodes\/[^/]+\/subtitles\/translations$/.test(path)) return json(translatedTracks.get(decodeURIComponent(path.split("/")[2])) ?? []);
    // `moa.mockRole=member` previews the screens a regular profile sees.
    if (path === "/me") return json(localStorage.getItem("moa.mockRole") === "member" ? { id: "m1", username: "member", role: "member" } : { id: "a1", username: "admin", role: "admin" });
    if (path === "/sources" && method === "GET") return json(videoSources);
    if (path === "/source-repositories" && method === "GET") return json([{ url: sourceRepo, kind: "mangayomi-js", checkedAt: new Date().toISOString() }]);
    if (/^\/sources\/[^/]+\/preferences$/.test(path)) return json([]);
    const sourceAction = /^\/sources\/([^/]+)(\/install)?$/.exec(path);
    if (sourceAction && (method === "PATCH" || method === "POST")) {
      const id = decodeURIComponent(sourceAction[1]);
      videoSources = videoSources.map(item => item.id !== id ? item : sourceAction[2] ? { ...item, installed: true, enabled: true, installedVersion: item.version } : { ...item, ...body });
      return json(videoSources.find(item => item.id === id));
    }
    if (path === "/settings") { if (method === "PATCH") settings = { ...settings, ...body }; return json(settings); }
    if (path === "/library/folders") return json([{ id: "f1", path: "/media/library", type: "anime", label: "내 영상", itemCount: 2, lastScanAt: new Date(now - 600_000).toISOString() }]);
    if (path === "/library/status") return json({ running: false, done: 15, total: 15 });
    if (path === "/library/scan") return json({ running: true, phase: "probing", done: 3, total: 15 });
    if (path === "/library/browse") return json({ path: url.searchParams.get("path") || "/media", dirs: ["library"] });
    return json({ error: "not-found" }, 404);
  };
}
