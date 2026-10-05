import { compatibilityHttpPolicy } from '../../../packages/extensions/src/http-options.js';
import { compatibilityHttp } from '../../../packages/extensions/src/http.js';
import { withByeDpi } from './byedpi.js';
export async function sourceHttp(input: any, signal: AbortSignal, transport = compatibilityHttp) {
  if (!input || typeof input.url !== 'string' || /\.(?:mp4|m4v|mov|flv|webm|m4s|mkv|ts|mp3|aac)(?:[?#]|$)/i.test(input.url)) throw new Error('video-relay-unavailable');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method ?? 'GET') || typeof input.body === 'string' && Buffer.byteLength(input.body) > 512 * 1024) throw new Error('invalid-source-invocation');
  const policy = compatibilityHttpPolicy(input.options);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]);
  const result = transport === compatibilityHttp
    ? await withByeDpi(deadline, proxy => transport(input, deadline, [], 2 * 1024 * 1024, proxy))
    : await transport(input, deadline, [], 2 * 1024 * 1024);
  if ((/^(?:video|audio)\//i.test(result.contentType) && !/mpegurl/i.test(result.contentType)) || result.bytes[0] === 0x47 && result.bytes[188] === 0x47) throw new Error('video-relay-unavailable');
  return { statusCode: result.statusCode, contentType: result.contentType, headers: result.headers, bytes: result.bytes.toString('base64'), size: result.bytes.length,
    isRedirect: [301, 302, 303, 307, 308].includes(result.statusCode), request: { url: input.url, method: input.method ?? 'GET', headers: input.headers ?? {}, contentLength: Buffer.byteLength(input.body ?? ''), followRedirects: policy.followRedirects, maxRedirects: policy.maxRedirects } };
}
