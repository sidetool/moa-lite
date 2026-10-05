import { compatibilityHttpPolicy } from '../../../packages/extensions/src/http-options.ts';
// SPDX-License-Identifier: GPL-3.0-or-later
export const limits = { http: 2 * 1024 * 1024, image: 20 * 1024 * 1024, job: 32 * 1024 * 1024, body: 512 * 1024 };
export function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('source_url_denied');
  let url; try { url = new URL(value); } catch { throw new Error('source_url_denied'); }
  const host = url.hostname.toLowerCase();
  // DNS resolution is owned by the browser; host permission is an additional, required boundary.
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      host.endsWith('.') || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)) throw new Error('source_url_denied');
  url.hash = '';
  return url;
}
export function requestSpec(input, image = false) {
  if (!input || typeof input !== 'object') throw new Error('invalid_source_invocation');
  const url = sourceUrl(input.url);
  const method = (input.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) || (image && method !== 'GET')) throw new Error('permission_denied');
  if (input.body !== undefined && (typeof input.body !== 'string' || new TextEncoder().encode(input.body).length > limits.body || ['GET','HEAD'].includes(method)))
    throw new Error('source_body_limit');
  const headers = {}, special = {};
  if (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers))) throw new Error('invalid_source_invocation');
  if (Object.keys(input.headers ?? {}).length > 32) throw new Error('invalid_source_invocation');
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const name = key.toLowerCase();
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(key) || /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('invalid_source_invocation');
    if (name === 'referer' || name === 'origin') {
      const headerUrl = sourceUrl(value);
      special[name] = name === 'origin' ? headerUrl.origin : headerUrl.href;
    } else if (['user-agent','cookie'].includes(name)) special[name] = value;
    else if (name === 'range') { if (!/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(value)) throw new Error('invalid_source_invocation'); headers[name] = value; }
    else if (name !== 'accept-encoding') headers[name] = value;
  }
  const policy = compatibilityHttpPolicy(input.options);
  return { url: url.href, origin: url.origin, method, headers, special, body: input.body,
    ...policy, maximum: image ? limits.image : limits.http, image };
}
export function isReader(sender, origins) {
  try { return sender.frameId === 0 && Number.isInteger(sender.tab?.id) && origins.includes(new URL(sender.url).origin); } catch { return false; }
}
