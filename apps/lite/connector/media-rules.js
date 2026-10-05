import { requestSpec, sourceUrl } from './policy.js';

export function mediaRules(request, reader, tabId, firstId, urls = []) {
  const spec = requestSpec(request);
  const origins = [...new Set([spec.origin, ...urls.map(value => sourceUrl(value).origin)])];
  if (!Number.isInteger(tabId) || origins.length > 16) throw new Error('invalid_source_invocation');
  return origins.map((origin, index) => ({
    id: firstId + index, priority: 2,
    action: { type: 'modifyHeaders',
      requestHeaders: Object.entries({ ...spec.headers, ...spec.special }).filter(([header]) => !['range', 'content-type'].includes(header) && (origin === spec.origin || !['cookie','authorization'].includes(header))).map(([header, value]) => ({ header, operation: 'set', value })),
      responseHeaders: [
        { header: 'access-control-allow-origin', operation: 'set', value: reader },
        { header: 'access-control-allow-methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
        { header: 'access-control-allow-headers', operation: 'set', value: 'Range, Content-Type' },
        { header: 'access-control-expose-headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' }
      ] },
    condition: { regexFilter: '^' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', tabIds: [tabId], initiatorDomains: [new URL(reader).hostname], resourceTypes: ['media', 'xmlhttprequest'] }
  }));
}

export function playlistUrls(text, base) {
  if (!text.startsWith('#EXTM3U')) return [];
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const values = line.startsWith('#') ? [...line.matchAll(/URI="([^"]+)"/g)].map(match => match[1]) : line.trim() ? [line.trim()] : [];
    for (const value of values) { try { const url = new URL(value, base); if (url.protocol === 'https:') result.push(url.href); } catch {} }
    if (result.length > 2000) break;
  }
  return result;
}
