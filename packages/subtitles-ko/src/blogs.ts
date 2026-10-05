import { BloggerIndex } from "./blogger-index.js";
import { load } from "cheerio";
import { PublicHttpClient, validatePublicUrl, type HttpResponse } from "./http.js";
import { extractSubtitleBuffer } from "./archive.js";
import { decodeSubtitleBuffer } from "./convert.js";
import { normalizeTitle, parseEpisodes, parseSeason, titleKey } from "./normalize.js";
import { stableId } from "./metadata.js";
import { failureCode } from "./async.js";
import type { AliasEntry, Diagnostic, SubtitleCandidate, SubtitleCreator } from "./types.js";

interface Link { url: string; label: string }
interface PostLink { url: string; priority: number }
const filePattern = /\.(?:ass|ssa|srt|smi|vtt|zip|7z|rar|tar)(?:[?#\s]|$)/i;
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try { return validatePublicUrl(new URL(href.replace(/&amp;/g, "&"), base).href).href; } catch { return undefined; }
}

export function googleDriveDownloadUrl(raw: string): string | undefined {
  const url = new URL(raw);
  if (!["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].includes(url.hostname)) return undefined;
  const id = url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] ?? url.searchParams.get("id");
  if (!id || !/^[\w-]{10,200}$/.test(id)) return undefined;
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

export function googleDriveFolderId(raw: string): string | undefined {
  try { const url = new URL(raw); return url.hostname === 'drive.google.com' ? url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,200})\/?$/)?.[1] : undefined; } catch { return undefined; }
}

/** Decode the public folder's embedded JSON string; never execute page scripts. */
export function publicDriveFiles(html: string, folderId: string): Link[] {
  const raw = html.match(/_DRIVE_ivd['"]\]\s*=\s*'((?:\\.|[^'\\])*)'/)?.[1];
  if (!raw) return [];
  try {
    const decoded = raw.replace(/\\(x[\da-f]{2}|u[\da-f]{4}|['"\\/bfnrtv])/gi, (_all, value: string) => {
      if (/^[xu]/i.test(value)) return String.fromCharCode(parseInt(value.slice(1),16));
      return ({b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v'} as Record<string,string>)[value] ?? value;
    });
    const entries = JSON.parse(decoded)?.[0];
    if (!Array.isArray(entries)) return [];
    return entries.slice(0,1000).flatMap(item => {
      if (!Array.isArray(item) || !/^[\w-]{10,200}$/.test(item[0]) || !Array.isArray(item[1]) || !item[1].includes(folderId) || typeof item[2] !== 'string' || !/\.(ass|ssa|srt|smi|vtt|zip|7z|rar|tar)$/i.test(item[2])) return [];
      return [{url:`https://drive.google.com/file/d/${item[0]}/view`,label:item[2]}];
    });
  } catch { return []; }
}

export function naverPostUrl(raw: string): string {
  const url = new URL(raw);
  if (!["blog.naver.com", "m.blog.naver.com"].includes(url.hostname)) return raw;
  const path = url.pathname.match(/^\/([^/]+)\/(\d+)\/?$/);
  const blogId = path?.[1] ?? url.searchParams.get("blogId");
  const logNo = path?.[2] ?? url.searchParams.get("logNo");
  if (blogId && logNo) {
    const target = new URL("https://blog.naver.com/PostView.naver");
    target.searchParams.set("blogId", blogId); target.searchParams.set("logNo", logNo);
    return target.href;
  }
  return raw;
}

export function extractAttachmentLinks(html: string, base: string): Link[] {
  const $ = load(html);
  // Article body prevents sidebar/recent-post attachments from masquerading as the current post.
  const body = $(".post-body, .tt_article_useless_p_margin, .entry-content, .se-main-container, #postViewArea").first();
  const links: Link[] = [];
  const add = (href: string | undefined, label: string, explicit = false) => {
    const url = absolute(href, base);
    if (!url || /폰트|fonts?|\.ttf|\.otf|\.woff/i.test(label)) return;
    const parsed = new URL(url);
    const recognizedHost = parsed.hostname === "download.blog.naver.com" || parsed.hostname === "blogfiles.naver.net" || parsed.hostname.endsWith(".blogfiles.naver.net");
    if (explicit || filePattern.test(decodeURIComponentSafe(url)) || filePattern.test(label) || googleDriveDownloadUrl(url) || googleDriveFolderId(url) || recognizedHost ||
      ((parsed.hostname === "blog.kakaocdn.net" || parsed.pathname.includes("attachment")) && /자막|다운로드|download/i.test(label))) links.push({ url, label });
  };
  const anchors = body.length ? body.find("a[href]") : $("a[href]");
  anchors.each((_, element) => add($(element).attr("href"), $(element).text().trim()));
  const buttons = body.length ? body.find('[data-file-url], [data-download-url], [data-download]') : $('[data-file-url], [data-download-url], [data-download]');
  const protectedDownload = /data-turnstile-site-key|challenges\.cloudflare\.com\/turnstile|g-recaptcha|h-captcha/i.test(html);
  if (!protectedDownload) buttons.each((_, element) => {
    const node = $(element);
    add(node.attr('data-file-url') || node.attr('data-download-url') || node.attr('data-download'), node.text().trim(), true);
  });
  // Parse URL string literals as data; never evaluate a page's scripts.
  $('script').each((_, script) => {
    for (const match of ($(script).html() || '').matchAll(/["']((?:https?:\/\/|https?%3A%2F%2F)[^"'\s<>]+)["']/gi)) {
      add(decodeURIComponentSafe(match[1]!.replace(/\\\//g, '/')), '');
    }
  });
  // Naver serializes attachments in page scripts rather than visible anchors.
  for (const match of html.matchAll(/(?:"|')?(?:encodedAttachFileUrl|fileUrl|downloadUrl|attachmentUrl)(?:"|')?\s*:\s*["']([^"']+)["']/g)) {
    let value = match[1]!;
    try { value = JSON.parse(`"${value}"`); } catch { value = value.replace(/\\\//g, "/"); }
    if (/%3A%2F%2F/i.test(value)) value = decodeURIComponentSafe(value);
    add(value, "");
  }
  return [...new Map(links.map(link => [link.url, link])).values()];
}

function decodeURIComponentSafe(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
export function responseFilename(response: HttpResponse, fallback: string): string {
  const header = response.headers["content-disposition"];
  const encoded = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const regular = header?.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  const name = decodeURIComponentSafe(encoded ?? regular?.[1] ?? regular?.[2]?.trim() ?? new URL(response.url).pathname.split("/").at(-1) ?? fallback);
  // Node exposes legacy header bytes as Latin-1; some hosts send an unencoded UTF-8 filename.
  if (!encoded && [...name].every(c => c.codePointAt(0)! <= 255)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name, "latin1")); } catch { /* Already a valid legacy name. */ }
  }
  return name;
}

/** Remove posting metadata, preserving words that can identify sequels, arcs or editions. */
function postTitle(raw: string): string {
  return raw.normalize("NFKC")
    .replace(/\b(S\d{1,2})E\d{1,4}(?:\.\d)?\b/gi, "$1 ")
    .replace(/(?:제|第)?\d+(?:\s*[-~～]\s*\d+)?(?:\.\d)?\s*(?:화|話)(?=$|[^\p{L}\p{N}]|자막|字幕)/gu, " ")
    .replace(/(?:\bEP?(?:ISODE)?\s*|第|#)\d{1,4}(?:\.\d)?(?:話)?(?=$|[^\p{L}\p{N}])/giu, " ")
    .replace(/\s*(?:한글\s*)?(?:자막|字幕)\s*$/u, " ")
    .replace(/(?:\s|^)[[(]?(?:완결|통합(?:본)?|END|완|完|終|미완성|수정(?:본)?|v\d+)[\])]?(?:\s|$)/gi, " ")
    .replace(/\s*(?:한글\s*)?(?:자막|字幕)\s*$/u, " ")
    .replace(/\.(?:zip|7z|rar|tar|ass|srt|smi|vtt)$/i, " ")
    .replace(/[【】「」『』\[\]]/g, " ").trim();
}

export class BlogCollector {
  constructor(private readonly http: PublicHttpClient, private readonly options: { maxZipBytes: number; maxZipEntries: number; aliases: AliasEntry[] },
    private readonly report: (diagnostic: Diagnostic) => void = () => {},
    private readonly index = new BloggerIndex(http)) {}

  private titleMatches(title: string, creator: SubtitleCreator): boolean {
    const base = normalizeTitle(creator.title).baseTitle;
    const alias = this.options.aliases.find(a => titleKey(a.korean) === titleKey(base));
    const clean = postTitle(title);
    const names = [base, ...(creator.aliases ?? []), ...(alias?.aliases ?? []), ...(alias?.seasonTitles?.[String(creator.season)] ?? [])];
    // A title number (Mob Psycho 100) is not an episode token.
    if (names.some(name => titleKey(clean) === titleKey(name))) return true;
    const explicitEpisode = /\d+\s*(?:화|話)|\b(?:EP?(?:ISODE)?\s*|S\d+E)\d+/i.test(title);
    if (!clean) return false;
    // Do not use release-filename normalization here: it can erase an entire suffix after "- 2".
    const key = titleKey(clean
      .replace(/(?:\bS\d{1,2}\b|\bSeason\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+Season\b|시즌\s*\d{1,2}|\d{1,2}\s*기|第\s*\d{1,2}\s*期)/gi, " ")
      .replace(/\s(?:II|III|IV|V|VI|VII|VIII|IX|X)\s*$/i, " ")
      .replace(explicitEpisode ? /$^/ : /(?:\s+-\s*|\s+)\d+(?:\.\d)?\s*$/, " "));
    const season = this.postSeason(title, creator);
    return names.some(name => {
      const wanted = titleKey(normalizeTitle(name).baseTitle);
      return wanted.length > 0 && (key === wanted || season === creator.season && key === wanted + String(season));
    });
  }

  /** Number-only/opaque filenames inherit the article identity; named files must agree. */
  private fileIdentity(raw: string, creator: SubtitleCreator): boolean | undefined {
    const name = (raw.split(/[\\/]/).at(-1) ?? raw).split("\n")[0]!.trim()
      .replace(/\.(?:zip|7z|rar|tar|ass|ssa|srt|smi|vtt)$/i, "")
      .replace(/^\[[^\]]+\]\s*(?=\S)/, "")
      .replace(/\[[^\]]*(?:\d{3,4}p|HEVC|AVC|[A-F\d]{8})[^\]]*\]|\([^)]*(?:\d{3,4}p|HEVC|WEB|BD|AAC|FLAC)[^)]*\)/gi, "")
      .replace(/^(?:ns|spon|non[- ]?spon)\s*[-_]\s*/i, "")
      .replace(/[._]/g, " ");
    if (!parseEpisodes(name).length) return undefined;
    const title = postTitle(name).replace(/(?:^|\s)(?:[-–]\s*)?\d+(?:\.\d)?\s*$/, "").trim();
    if (!title || /^(?:자막|subtitle|episode|ep|통합|완결)$/i.test(title)) return undefined;
    if (this.titleMatches(name, creator)) return true;
    // Short Korean file labels are common. They are not sufficient to establish a
    // title, but also not evidence of a different work (the article must match).
    if (/^[가-힣]{1,3}(?:\s*\d+기)?$/.test(title)) {
      const short = titleKey(normalizeTitle(title).baseTitle);
      const known = this.options.aliases.find(a => titleKey(a.korean) === titleKey(normalizeTitle(creator.title).baseTitle));
      if ([creator.title, ...(creator.aliases ?? []), ...(known?.aliases ?? [])]
        .some(name => titleKey(normalizeTitle(name).baseTitle).startsWith(short))) return undefined;
    }
    return false;
  }

  private pageEpisodes(title: string, creator: SubtitleCreator): number[] {
    const base = normalizeTitle(creator.title).baseTitle;
    const alias = this.options.aliases.find(a => titleKey(a.korean) === titleKey(base));
    if (!/\d+\s*(?:화|話)|\b(?:EP?(?:ISODE)?\s*|S\d+E)\d+/i.test(title)
      && [creator.title, base, ...(creator.aliases ?? []), ...(alias?.aliases ?? [])].some(name => titleKey(postTitle(title)) === titleKey(name))) return [];
    return parseEpisodes(title);
  }

  private seriesPage(title: string, creator: SubtitleCreator): boolean {
    return !this.pageEpisodes(title, creator).length && (this.postSeason(title, creator) ?? 1) === creator.season && this.titleMatches(title, creator);
  }

  /** Only inspect other-episode posts with an explicit episode token; a bare sequel number is not an episode. */
  private batchPage(title: string, creator: SubtitleCreator): boolean {
    return /\d+\s*(?:화|話)|\b(?:EP?(?:ISODE)?\s*|S\d+E)\d+/i.test(title)
      && (this.postSeason(title, creator) ?? 1) === creator.season && this.titleMatches(title, creator);
  }

  private postSeason(text: string, creator: SubtitleCreator): number | undefined {
    let season = parseSeason(text) ?? parseSeason(postTitle(text));
    const identity = this.options.aliases.find(a => titleKey(a.korean) === titleKey(normalizeTitle(creator.title).baseTitle));
    const namedSeason = Object.entries(identity?.seasonTitles ?? {}).find(([, names]) => names.some(name => titleKey(text).includes(titleKey(name))));
    if (namedSeason) {
      if (season !== undefined && season !== Number(namedSeason[0])) return -1;
      season = Number(namedSeason[0]);
    }
    if (season === undefined) {
      const base = normalizeTitle(creator.title).baseTitle;
      const alias = this.options.aliases.find(a => titleKey(a.korean) === titleKey(base));
      // Some creators use an attached season digit (e.g. 무직전생3).
      // Restrict this to exact verified aliases, never arbitrary title numbers.
      for (const name of [base,...(creator.aliases ?? []),...(alias?.aliases ?? [])]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`(?:^|\\s)${escaped}(\\d{1,2})(?=\\s|$)`, 'i'));
        if (match) { season = Number(match[1]); break; }
      }
    }
    return season;
  }

  private episodeMatch(text: string, creator: SubtitleCreator, episode: number): boolean {
    const season = this.postSeason(text, creator);
    if (season !== undefined && season !== creator.season) return false;
    const episodes = this.pageEpisodes(text, creator);
    if (season !== undefined) return episodes.includes(episode) || creator.episodeOffset > 0 && episodes.includes(episode + creator.episodeOffset);
    // For a later season, a post with no season token must use the verified absolute number.
    return episodes.includes(episode + creator.episodeOffset) && (creator.season === 1 || creator.episodeOffset > 0);
  }

  private async page(url: string, signal: AbortSignal): Promise<{ html: string; url: string }> {
    const response = await this.http.get(naverPostUrl(url), { signal, maxBytes: 3 * 1024 * 1024 });
    let html = decodeSubtitleBuffer(response.body);
    if (response.headers["content-type"]?.toLowerCase().includes("charset=euc-kr")) html = new TextDecoder("euc-kr").decode(response.body);
    let finalUrl = response.url;
    if (new URL(finalUrl).hostname === "blog.naver.com") {
      const $ = load(html);
      const frame = absolute($("iframe#mainFrame").attr("src"), finalUrl);
      if (frame && new URL(frame).hostname === "blog.naver.com") {
        const next = await this.http.get(frame, { signal, referer: finalUrl, maxBytes: 3 * 1024 * 1024 });
        html = decodeSubtitleBuffer(next.body); finalUrl = next.url;
      }
    }
    return { html, url: finalUrl };
  }

  private async download(link: Link, referer: string, signal: AbortSignal): Promise<HttpResponse> {
    const drive = googleDriveDownloadUrl(link.url);
    let response: HttpResponse;
    try { response = await this.http.get(drive ?? link.url, { signal, referer }); }
    catch (error) {
      if (!drive || signal.aborted) throw error;
      const id = new URL(drive).searchParams.get("id")!;
      response = await this.http.get(`https://docs.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t`, { signal, referer });
    }
    // Google's virus-scan confirmation is a public HTML form. Login/private files have no usable form.
    if (drive && /<html|<!doctype html/i.test(response.body.subarray(0, 500).toString("utf8"))) {
      const $ = load(response.body.toString("utf8"));
      const form = $("form#download-form");
      const action = absolute(form.attr("action"), response.url);
      if (action && new URL(action).hostname === "drive.usercontent.google.com") {
        const target = new URL(action);
        form.find("input[name]").each((_, input) => target.searchParams.set($(input).attr("name")!, $(input).attr("value") ?? ""));
        response = await this.http.get(target.href, { signal, referer: response.url });
      }
    }
    return response;
  }

  private async fromPage(page: { html: string; url: string }, creator: SubtitleCreator, episode: number, signal: AbortSignal): Promise<SubtitleCandidate | null> {
    const $ = load(page.html);
    const title = $("meta[property='og:title']").attr("content") || $(".post-title, h1, .se-title-text").first().text() || $("title").text();
    // Search listings can be stale or redirect: verify the actual article before using its files.
    if (title && !this.titleMatches(title, creator)) return null;
    const seriesPage = this.seriesPage(title, creator);
    const confirmedPost = this.titleMatches(title, creator) && this.episodeMatch(title, creator, episode);
    const pageSeason = this.postSeason(title, creator);
    const pageEpisodes = this.pageEpisodes(title, creator);
    if (pageSeason !== undefined && pageSeason !== creator.season) return null;
    const attachments = extractAttachmentLinks(page.html, page.url);
    const expanded: Link[] = [];
    for (const link of attachments.filter(link => googleDriveFolderId(link.url)).slice(0,2)) {
      if (!this.titleMatches(title, creator) && !this.titleMatches(link.label,creator)) continue;
      try {
        const folderId = googleDriveFolderId(link.url)!;
        const folder = await this.http.get(link.url,{signal,maxBytes:3*1024*1024});
        expanded.push(...publicDriveFiles(folder.body.toString('utf8'),folderId));
      } catch(error) { this.failure('page',error,creator,signal); }
    }
    const links = [...attachments.filter(link=>!googleDriveFolderId(link.url)), ...expanded].sort((a, b) => Number(this.episodeMatch(b.label, creator, episode)) - Number(this.episodeMatch(a.label, creator, episode)));
    for (const link of links.slice(0, 6)) {
      if (signal.aborted) break;
      const label = link.label || decodeURIComponentSafe(new URL(link.url).pathname.split("/").at(-1) ?? "");
      if (this.fileIdentity(label, creator) === false) continue;
      const linkSeason = this.postSeason(label, creator);
      if (linkSeason !== undefined && linkSeason !== creator.season) continue;
      const numbers = parseEpisodes(label);
      const confirmedLink = this.episodeMatch(label, creator, episode) || seriesPage && numbers.includes(episode);
      if (!title && !this.titleMatches(label, creator)) continue;
      // A different episode article may supply a genuine series ZIP, never a conflicting single file.
      if (pageEpisodes.length && !confirmedPost && !(numbers.length > 1 && /\.(?:zip|7z|rar|tar)(?:\b|$)/i.test(label))) continue;
      // Anissia's latest post may contain a batch archive; inspect its explicit episode label.
      if (numbers.length && !confirmedLink) continue;
      if (!confirmedPost && !confirmedLink && !(seriesPage && googleDriveDownloadUrl(link.url)) && !/\.(?:zip|7z|rar|tar)(?:\b|$)|통합|전편|완결/i.test(label)) continue;
      try {
        const response = await this.download(link, page.url, signal);
        const filename = responseFilename(response, label || "subtitle");
        const extracted = await extractSubtitleBuffer(response.body, filename, {
          episode, alternateEpisode: creator.episodeOffset ? episode + creator.episodeOffset : undefined,
          acceptFilename: name => this.fileIdentity(name, creator) !== false,
          season: creator.season, allowUnnumbered: (confirmedPost || confirmedLink) && numbers.length <= 1 && pageEpisodes.length <= 1,
          maxZipBytes: this.options.maxZipBytes, maxEntries: this.options.maxZipEntries, signal,
        });
        if (!extracted || !/[가-힣]/.test(extracted.content)) continue;
        const uncertainNumbering = creator.episodeOffset > 0 && numbers.length === 1
          && numbers[0] === episode + creator.episodeOffset && extracted.matchedEpisode === episode
          && !parseSeason(extracted.filename);
        const weakBatchIdentity = !confirmedPost && !seriesPage && pageSeason === undefined
          && this.fileIdentity(extracted.filename, creator) !== true;
        return {
          id: stableId(creator.name, creator.title, episode, extracted.content), creatorId: creator.id,
          creatorName: creator.name, sourceUrl: page.url, format: extracted.format, content: extracted.content,
          filename: extracted.filename, episode, matchedEpisode: extracted.matchedEpisode,
          title: creator.title, season: creator.season,
          confidence: Math.min(creator.confidence, uncertainNumbering || weakBatchIdentity ? 0.49 : extracted.exactEpisode ? 0.96 : 0.86),
        };
      } catch (error) { this.failure("download", error, creator, signal); }
    }
    return null;
  }

  private postLinks(html: string, base: string, creator: SubtitleCreator, episode: number, allowBatch = false): PostLink[] {
    // RSS/Atom has the same identity checks as HTML search results.
    if (/<(?:rss|feed)[\s>]/i.test(html)) {
      const feed = load(html, { xml: true });
      const origin = new URL(creator.website);
      const result: PostLink[] = [];
      feed('item, entry').each((_, item) => {
        const node = feed(item), title = node.find('title').first().text();
        const href = node.find('link[rel="alternate"]').attr('href') || node.find('link').attr('href') || node.find('link').first().text();
        const url = absolute(href, base);
        const season = this.postSeason(title, creator);
        if (season !== undefined && season !== creator.season) return;
        if (url && new URL(url).hostname === origin.hostname && this.titleMatches(title, creator)
          && (this.episodeMatch(title, creator, episode) || this.seriesPage(title, creator)))
          result.push({ url, priority: this.episodeMatch(title, creator, episode) ? 2 : 1 });
      });
      return result;
    }
    const $ = load(html);
    const links: { url: string; priority: number }[] = [];
    $("a[href]").each((_, element) => {
      const node = $(element);
      const text = node.clone();
      text.find(".cnt, .c_cnt, .count, .comment-count").remove();
      const title = node.attr("data-tiara-copy") || node.attr("data-tiara-name") || text.find(".title, .post_title, .title-text, h2, h3").first().text() || text.text();
      if (!this.titleMatches(title, creator) || !this.episodeMatch(title, creator, episode) && !this.seriesPage(title, creator) && !(allowBatch && this.batchPage(title, creator))) return;
      const season = this.postSeason(title, creator);
      if (season !== undefined && season !== creator.season) return;
      const url = absolute(node.attr("href"), base);
      if (url && new URL(url).hostname === new URL(base).hostname && !/\/search|\/category|\/label\//.test(new URL(url).pathname)) {
        links.push({ url, priority: this.episodeMatch(title, creator, episode) ? 2 : this.seriesPage(title, creator) ? 1 : 0 });
      }
    });
    links.sort((a, b) => b.priority - a.priority);
    return [...new Map(links.map(link => [link.url, link])).values()];
  }

  /** Follow exact season categories or the oldest search page; never crawl a whole archive. */
  private archivePages(html: string, base: string, creator: SubtitleCreator): string[] {
    const $ = load(html), origin = new URL(base), categories: string[] = [], pages: { url: string; page: number }[] = [];
    if (!origin.hostname.endsWith(".tistory.com")) return [];
    $("a[href]").each((_, element) => {
      const node = $(element), url = absolute(node.attr("href"), base);
      if (!url) return;
      const target = new URL(url);
      if (target.origin !== origin.origin) return;
      if (target.pathname.startsWith("/category/")) {
        const title = node.clone(); title.find(".c_cnt, .cnt, .count").remove();
        const clean = title.text().replace(/\s*\(\d+\)\s*$/, "").trim();
        if (this.seriesPage(clean, creator)) categories.push(url);
      }
      if (target.pathname === origin.pathname && creator.season === 1) {
        const page = Number(target.searchParams.get("page"));
        if (Number.isInteger(page) && page > 1 && page <= 1000) pages.push({ url, page });
      }
    });
    pages.sort((a, b) => b.page - a.page);
    return [...new Set([...categories, ...(pages[0] ? [pages[0].url] : [])])].slice(0, 2);
  }

  private searchUrls(creator: SubtitleCreator, episode: number, extra = false): string[] {
    const website = new URL(creator.website);
    const base = normalizeTitle(creator.title).baseTitle;
    const alias = this.options.aliases.find(a => titleKey(a.korean) === titleKey(base));
    const short = alias?.aliases.filter(name => /[가-힣]/.test(name)).sort((a,b)=>a.length-b.length)[0];
    // Discovery may vary whitespace and language, but accepting a result still requires the same title/season/episode.
    const compact = /[가-힣]/.test(base) ? base.replace(/\s+/g, "") : undefined;
    const alternate = [...(creator.aliases ?? []), ...(alias?.aliases ?? [])].find(name => /[a-z]/i.test(name));
    // Keep the established shorthand query in the first batch so a slow exact search cannot delay it.
    const primary = [...new Set([`${base} ${episode + creator.episodeOffset}`, base, ...(short && short !== base ? [short] : [])])];
    const fallback = [...new Set([...(compact && compact !== base ? [compact] : []), ...(alternate ? [normalizeTitle(alternate).baseTitle] : [])])].filter(q => !primary.includes(q));
    const queries = extra ? fallback : primary;
    if (website.hostname.endsWith(".blogspot.com")) return queries.map(q => `${website.origin}/search?q=${encodeURIComponent(q)}&max-results=100`);
    if (website.hostname.endsWith(".tistory.com")) return queries.map(q => `${website.origin}/search/${encodeURIComponent(q)}`);
    if (["blog.naver.com", "m.blog.naver.com"].includes(website.hostname)) {
      const id = website.searchParams.get("blogId") ?? website.pathname.split("/")[1];
      if (!id) return [];
      return queries.map(q => `https://blog.naver.com/PostSearchList.naver?blogId=${encodeURIComponent(id)}&searchText=${encodeURIComponent(q)}`);
    }
    return [];
  }

  async collect(creator: SubtitleCreator, episode: number, signal: AbortSignal, indexed = false, directOnly = false): Promise<SubtitleCandidate | null> {
    // A separate budget per invocation: this collector is shared by concurrent creators.
    // Include folder listings, retry and confirmation calls as well as ordinary downloads.
    let requests = 0;
    const http = Object.create(this.http) as PublicHttpClient;
    http.get = (url, options) => {
      if (requests >= 24) return Promise.reject(new Error("Subtitle source request limit reached"));
      requests++;
      return this.http.get(url, options);
    };
    return new BlogCollector(http, this.options, this.report, this.index).collectBounded(creator, episode, signal, indexed, directOnly);
  }

  private async collectBounded(creator: SubtitleCreator, episode: number, signal: AbortSignal, indexed: boolean, directOnly: boolean): Promise<SubtitleCandidate | null> {
    if (!creator.website || signal.aborted) return null;
    const visited = new Set<string>();
    const tryPage = async (url: string) => {
      if (visited.has(url) || signal.aborted) return null;
      visited.add(url);
      try { return await this.fromPage(await this.page(url, signal), creator, episode, signal); }
      catch (error) { this.failure("page", error, creator, signal); return null; }
    };
    // Direct subtitle/archive URLs in Anissia are supported as well as blog posts.
    if (googleDriveDownloadUrl(creator.website) || filePattern.test(creator.website)) {
      try {
        const response = await this.download({ url: creator.website, label: "" }, creator.website, signal);
        const extracted = await extractSubtitleBuffer(response.body, responseFilename(response, "subtitle"), {
          episode, alternateEpisode: creator.episodeOffset ? episode + creator.episodeOffset : undefined,
          acceptFilename: name => this.fileIdentity(name, creator) !== false,
          season: creator.season, allowUnnumbered: creator.isCurrentEpisode,
          maxZipBytes: this.options.maxZipBytes, maxEntries: this.options.maxZipEntries, signal,
        });
        if (extracted && /[가-힣]/.test(extracted.content)) return {
          ...extracted, id: stableId(creator.name, creator.title, episode, extracted.content), creatorId: creator.id,
          creatorName: creator.name, sourceUrl: creator.website, episode, title: creator.title, season: creator.season,
          confidence: Math.min(creator.confidence, extracted.exactEpisode ? 0.96 : 0.86),
        };
      } catch (error) { this.failure("download", error, creator, signal); }
    }
    // An archive homepage contains many posts; do not treat the whole index as a single post.
    if (!indexed && creator.source !== "archive") { const initial = await tryPage(creator.website); if (initial) return initial; }
    // A parallel archive lookup already searches this creator's indexes. Only
    // inspect the known post here, retaining all identity and attachment checks.
    if (directOnly) return null;
    let inspected = 0;
    const inspect = async (links: PostLink[]) => {
      // Rank across ALL search variants, not separately inside each result page.
      for (const { url } of links.sort((a, b) => b.priority - a.priority)) {
        if (visited.has(url)) continue;
        if (inspected >= 4 || signal.aborted) break;
        inspected++;
        const candidate = await tryPage(url);
        if (candidate) return candidate;
      }
      return null;
    };
    const readIndexes = async (urls: string[]) => Promise.all(urls.filter(url => !visited.has(url)).map(async url => {
      visited.add(url);
      try { return await this.page(url, signal); }
      catch (error) { this.failure("page", error, creator, signal); return null; }
    }));
    const pages: { html: string; url: string }[] = [];
    for (const extra of indexed ? [] : [false, true]) {
      if (signal.aborted || inspected >= 4) break;
      const results = await readIndexes(this.searchUrls(creator, episode, extra));
      pages.push(...results.filter((page): page is NonNullable<typeof page> => page !== null));
      const found = await inspect(pages.flatMap(page => this.postLinks(page.html, page.url, creator, episode)));
      if (found) return found;
    }
    // Blogger search tokenizes whitespace and can omit old series index posts.
    // Match a bounded, cached feed index with exactly the same identity checks.
    if (indexed && !signal.aborted && inspected < 4 && new URL(creator.website).hostname.endsWith('.blogspot.com')) {
      try {
        const entries = await this.index.posts(new URL(creator.website).origin, signal);
        const links = entries.filter(post => this.titleMatches(post.title, creator)
          && (this.postSeason(post.title, creator) ?? 1) === creator.season)
          .flatMap(post => this.episodeMatch(post.title, creator, episode) ? [{url: post.url, priority: 2}]
            : this.seriesPage(post.title, creator) ? [{url: post.url, priority: 1}]
            : this.batchPage(post.title, creator) ? [{url: post.url, priority: 0}] : []);
        const indexed = await inspect(links);
        if (indexed) return indexed;
      } catch (error) { this.failure('page', error, creator, signal); }
    }
    // Legacy categories and final-episode posts are fallbacks, never ahead of a precise episode result.
    if (!signal.aborted && inspected < 4) {
      const archiveUrls = [...new Set(pages.flatMap(page => this.archivePages(page.html, page.url, creator)))].filter(url => !visited.has(url)).slice(0, 2);
      const archives = await readIndexes(archiveUrls);
      pages.push(...archives.filter((page): page is NonNullable<typeof page> => page !== null));
      const legacy = await inspect(pages.flatMap(page => this.postLinks(page.html, page.url, creator, episode, true)));
      if (legacy) return legacy;
    }
    // Recent feeds and bounded pagination cover older posts omitted from page one.
    if (!indexed && !signal.aborted && inspected < 4 && (!pages.length || pages.some(page => page.html.trim()))) {
      const origin = new URL(creator.website);
      const urls: string[] = [];
      const naver = ['blog.naver.com', 'm.blog.naver.com'].includes(origin.hostname);
      const id = origin.searchParams.get('blogId') || origin.pathname.split('/')[1];
      if (naver && id) urls.push(`https://rss.blog.naver.com/${encodeURIComponent(id)}.xml`);
      else if (origin.hostname.endsWith('.tistory.com')) urls.push(`${origin.origin}/rss`);
      if (pages.some(page => /(?:[?&](?:page|currentPage)=|class=["'][^"']*s_link)/.test(page.html)) && (naver || origin.hostname.endsWith('.tistory.com'))) {
        for (const raw of this.searchUrls(creator, episode).slice(0, 2)) {
          for (let page = 2; page <= (naver ? 3 : 4); page++) {
            const url = new URL(raw); url.searchParams.set(naver ? 'currentPage' : 'page', String(page));
            if (naver) url.searchParams.set('orderType', 'sim');
            urls.push(url.href);
          }
        }
      }
      // Fetch at most two pages together, stopping as soon as an exact file is found.
      for (let i = 0; i < urls.length && !signal.aborted && inspected < 4; i += 2) {
        const extra = await readIndexes(urls.slice(i, i + 2));
        const found = await inspect(extra.flatMap(page => page ? this.postLinks(page.html, page.url, creator, episode) : []));
        if (found) return found;
      }
    }
    this.report({ stage: "page", code: "not-found", creatorName: creator.name, message: "No matching public subtitle attachment found" });
    return null;
  }

  private failure(stage: Diagnostic["stage"], error: unknown, creator: SubtitleCreator, signal: AbortSignal) {
    this.report({ stage, code: failureCode(error, signal), creatorName: creator.name, message: error instanceof Error ? error.message : "Subtitle collection failed" });
  }
}
