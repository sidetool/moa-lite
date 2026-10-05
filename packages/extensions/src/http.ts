import { pinnedProxyAgent } from './proxy.js';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPublicSourceAddress } from './vendor/source-http.mjs';
import { compatibilityHttpPolicy, type CompatibilityHttpOptions } from './http-options.js';

const transientConnectionCodes = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
]);
const tlsFailureCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
type SourceAddress = { address: string; family: number };
type SourceLookup = (host: string, options: { all: true; verbatim: true }) => Promise<SourceAddress[]>;
async function resolveAddresses(host: string, lookupHost: SourceLookup, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  try {
    return await Promise.race([
      lookupHost(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
const transientTransportFailure = (error: unknown) =>
  transientConnectionCodes.has((error as NodeJS.ErrnoException).code ?? '') ||
  (error as Error).message === 'source_connection_failed';

export interface CompatibilityHttpInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  options?: CompatibilityHttpOptions;
}
/** Public web requests pin DNS. Private origins are granted by the owner in the options UI, never by extension code. */
export async function compatibilityHttp(
  input: CompatibilityHttpInput,
  signal: AbortSignal,
  privateOrigins: readonly string[] = [],
  maximum = 768 * 1024,
  outboundProxy?: string,
  followRedirects = true,
  lookupHost: SourceLookup = lookup,
) {
  const policy = compatibilityHttpPolicy(input?.options);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]);
  followRedirects = followRedirects && policy.followRedirects;
  try {
    try {
      return await compatibilityRequest(
        input,
        deadline,
        privateOrigins,
        maximum,
        outboundProxy,
        followRedirects,
        lookupHost,
      );
    } catch (error) {
      // Replay only reads after transport failure, with one shared deadline. Never replay provider job creation.
      if (!['GET', 'HEAD'].includes(input?.method ?? 'GET') || deadline.aborted || !transientTransportFailure(error))
        throw error;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(deadline.reason);
        };
        const timer = setTimeout(() => {
          deadline.removeEventListener('abort', cancel);
          resolve();
        }, 250);
        deadline.addEventListener('abort', cancel, { once: true });
        if (deadline.aborted) cancel();
      });
      return await compatibilityRequest(
        input,
        deadline,
        privateOrigins,
        maximum,
        outboundProxy,
        followRedirects,
        lookupHost,
      );
    }
  } catch (error) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { cause: error });
    if (deadline.aborted) throw Object.assign(new Error('source_request_timeout'), { cause: error });
    if (transientTransportFailure(error) || (error as NodeJS.ErrnoException).code === 'ENOTFOUND')
      throw Object.assign(new Error('source_connection_failed'), { cause: error });
    if (tlsFailureCodes.has((error as NodeJS.ErrnoException).code ?? ''))
      throw Object.assign(new Error('source_tls_failed'), { cause: error });
    throw error;
  }
}
async function compatibilityRequest(
  input: CompatibilityHttpInput,
  deadline: AbortSignal,
  privateOrigins: readonly string[],
  maximum: number,
  outboundProxy?: string,
  followRedirects = true,
  lookupHost: SourceLookup = lookup,
) {
  if (
    !input ||
    !['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'].includes(input.method ?? 'GET') ||
    (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256 * 1024))
  )
    throw new Error('source_http_failed');
  let url = new URL(input.url);
  let method = input.method ?? 'GET';
  let body = input.body;
  let headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'gzip, deflate, br' };
  if (input.headers && (typeof input.headers !== 'object' || Object.keys(input.headers).length > 32))
    throw new Error('source_http_failed');
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(key) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      /[\r\n]/.test(value) ||
      /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(key)
    )
      throw new Error('source_http_failed');
    // Browsers/Dart encode Korean paths in URL-valued headers. Node's HTTP
    // client rejects the raw Unicode characters used by some video sources.
    const name = key.toLowerCase();
    headers[name] = name === 'referer' ? new URL(value).href : name === 'origin' && value !== 'null' ? new URL(value).origin : value;
  }
  const { maxRedirects } = compatibilityHttpPolicy(input.options);
  for (let n = 0; n <= maxRedirects; n++) {
    deadline.throwIfAborted();
    if (
      url.href.length > 8192 ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('source_url_denied');
    // Fragments identify source-side detail revisions; HTTP never sends them.
    url.hash = '';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = privateOrigins.includes(url.origin);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolveAddresses(host, lookupHost, deadline);
    if (!addresses.length || (addresses.some((row) => !isPublicSourceAddress(row.address)) && !local))
      throw new Error('source_address_denied');
    if (url.protocol === 'http:' && !local) throw new Error('source_url_denied');
    let response: import('node:http').IncomingMessage | undefined;
    for (let index = 0; index < addresses.length; index++) {
      deadline.throwIfAborted();
      const address = addresses[index];
      // Explicitly granted local authentication/content services remain reachable on the host's own network.
      try {
        response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
            url,
            {
              method,
              headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) },
              signal: deadline,
              agent: pinnedProxyAgent(outboundProxy, url, address.address, deadline) ?? false,
              // A synchronous lookup can fail inside TLS construction before listeners exist.
              lookup: (_host, options, callback) =>
                queueMicrotask(() =>
                  options.all ? callback(null, [address]) : callback(null, address.address, address.family),
                ),
            },
            resolve,
          );
          req.once('error', reject);
          req.end(body);
        });
        break;
      } catch (error) {
        if (
          deadline.aborted ||
          !['GET', 'HEAD'].includes(method) ||
          index === addresses.length - 1 ||
          !transientTransportFailure(error)
        )
          throw error;
      }
    }
    if (!response) throw new Error('source_connection_failed');
    try {
      if (followRedirects && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (n === maxRedirects || !response.headers.location) throw new Error('source_redirect_limit');
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin) {
          if (method !== 'GET' && method !== 'HEAD') throw new Error('source_redirect_denied');
          headers = { ...headers };
          delete headers.authorization;
          delete headers.cookie;
        }
        if (response.statusCode === 303 || ([301, 302].includes(response.statusCode!) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      const encoding = response.headers['content-encoding'];
      if (encoding && !['gzip', 'br', 'deflate', 'identity'].includes(encoding)) throw new Error('source_http_failed');
      const decoded =
        encoding === 'gzip'
          ? response.pipe(createGunzip())
          : encoding === 'br'
            ? response.pipe(createBrotliDecompress())
            : encoding === 'deflate'
              ? response.pipe(createInflate())
              : response;
      const upstreamError = (error: Error) => decoded.destroy(error);
      if (decoded !== response) response.once('error', upstreamError);
      const abort = () => decoded.destroy(new Error('cancelled'));
      deadline.addEventListener('abort', abort, { once: true });
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const part of decoded) {
          deadline.throwIfAborted();
          size += part.length;
          if (size > maximum) throw new Error('source_body_limit');
          chunks.push(Buffer.from(part));
        }
      } finally {
        deadline.removeEventListener('abort', abort);
        response.removeListener('error', upstreamError);
        if (decoded !== response) decoded.destroy();
      }
      const bytes = Buffer.concat(chunks, size);
      const type = response.headers['content-type'] ?? 'application/octet-stream';
      return {
        bytes,
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        url: url.href,
        contentType: type,
      };
    } finally {
      response.destroy();
    }
  }
  throw new Error('source_redirect_limit');
}
