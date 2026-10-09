import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { abortable, deadline } from "./async.js";

export class UnsafeUrlError extends Error { override name = "UnsafeUrlError"; }
export class ResponseLimitError extends Error { override name = "ResponseLimitError"; }

/** Conservative public-unicast policy, including mapped/transition IPv6. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const first = Number.parseInt(address.split(":")[0] ?? "", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  const parts = address.toLowerCase().split(":");
  if (first === 0x2002 || first === 0x3fff) return false; // 6to4 / documentation
  if (first === 0x2001) {
    const second = Number.parseInt(parts[1] || "0", 16);
    if (second < 0x200 || second === 0xdb8) return false; // special-purpose block incl. Teredo/ORCHID
  }
  return true;
}

export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError("Invalid URL"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== "80" && url.port !== "443") ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
      !host || (!isIP(host) && !host.includes(".")) || (isIP(host) && !isPublicAddress(host))) {
    throw new UnsafeUrlError("Only public HTTP(S) hosts on ports 80/443 are allowed");
  }
  return url;
}

export type HostResolver = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: HostResolver = host => lookup(host, { all: true, verbatim: true });

export async function resolvePublicHost(url: URL, signal: AbortSignal, resolver: HostResolver = defaultResolver) {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(resolver(host), signal);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new UnsafeUrlError("DNS resolved to a non-public address");
  return addresses[0]!;
}

export interface HttpResponse { url: string; status: number; headers: IncomingHttpHeaders; body: Buffer }
export interface HttpOptions { signal: AbortSignal; referer?: string; method?: "GET" | "POST"; body?: string; maxBytes?: number }

export class PublicHttpClient {
  private requests = 0;
  private deniedHosts = new Map<string, number>();
  constructor(readonly timeoutMs = 4000, readonly maxBytes = 20 * 1024 * 1024, private readonly resolver: HostResolver = defaultResolver, private readonly maxRequests = Infinity) {}

  async get(raw: string, options: HttpOptions): Promise<HttpResponse> {
    const scope = deadline({ signal: options.signal, timeoutMs: this.timeoutMs });
    let target = raw;
    let method = options.method ?? "GET";
    let body = options.body;
    try {
      for (let hop = 0; hop <= 4; hop++) {
        scope.signal.throwIfAborted();
        const url = validatePublicUrl(target);
        const denied = this.deniedHosts.get(url.hostname);
        if (denied) throw new Error(`HTTP ${denied} from ${url.hostname}`);
        if (++this.requests > this.maxRequests) throw new ResponseLimitError('Subtitle request budget exhausted');
        const address = await resolvePublicHost(url, scope.signal, this.resolver);
        const response = await this.request(url, address, { ...options, method, body, signal: scope.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers.location || hop === 4) throw new Error("Invalid/too many redirects");
          target = new URL(response.headers.location, url).href;
          validatePublicUrl(target); // DNS rechecked and pinned on every next hop.
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
          continue;
        }
        if ([401, 403, 429].includes(response.status)) this.deniedHosts.set(url.hostname, response.status);
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status} from ${url.hostname}`);
        return response;
      }
      throw new Error("Too many redirects");
    } catch (error) {
      if (scope.signal.aborted) throw scope.signal.reason;
      throw error;
    } finally { scope.dispose(); }
  }

  private request(url: URL, address: { address: string; family: number }, options: HttpOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const cap = Math.min(options.maxBytes ?? this.maxBytes, this.maxBytes);
      const headers: Record<string, string> = {
        "User-Agent": "MOA-Subtitles/0.1 (+personal subtitle client)",
        Accept: "*/*", "Accept-Language": "ko,en;q=0.7", "Accept-Encoding": "identity",
      };
      if (options.referer) headers.Referer = validatePublicUrl(options.referer).href;
      if (options.body) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(options.body)); }
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: options.method, headers, signal: options.signal, agent: false,
        // Pin the checked address. The URL hostname still controls Host and TLS SNI.
        lookup: (_hostname, _lookupOptions, cb) => cb(null, address.address, address.family),
        family: address.family,
      }, response => {
        response.on("error", reject);
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.destroy();
          resolve({ url: url.href, status: response.statusCode!, headers: response.headers, body: Buffer.alloc(0) });
          return;
        }
        if (Number(response.headers["content-length"]) > cap) { request.destroy(new ResponseLimitError("Response exceeds byte limit")); return; }
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > cap) request.destroy(new ResponseLimitError("Response exceeds byte limit"));
        });
        let stream: Readable = response;
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
          if (!decoder) { request.destroy(new Error("Unsupported content encoding")); return; }
          response.pipe(decoder);
          response.on("error", error => decoder.destroy(error));
          stream = decoder;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > cap) { stream.destroy(new ResponseLimitError("Decoded response exceeds byte limit")); request.destroy(); }
          else chunks.push(chunk);
        });
        stream.on("error", error => { request.destroy(); reject(error); });
        stream.on("end", () => resolve({ url: url.href, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks, size) }));
      });
      request.on("error", reject);
      request.end(options.body);
    });
  }
}
