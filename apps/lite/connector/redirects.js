import { sourceUrl } from './policy.js';
/** Validate and authorize each redirect before issuing the next request. */
export async function followSourceRedirects(spec, hop) {
  const deadline = Date.now() + spec.timeoutMs;
  let current = { ...spec, headers: {...spec.headers}, special: {...spec.special} };
  for (let count = 0; ; count++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('source_request_timeout');
    const response = await hop({...current, timeoutMs:remaining});
    const redirect = [301,302,303,307,308].includes(response.statusCode);
    if (!redirect || !spec.followRedirects) return {...response, finalUrl:current.url, isRedirect:redirect,
      request:{url:spec.url,method:spec.method,headers:{...spec.headers,...spec.special},contentLength:new TextEncoder().encode(spec.body ?? '').length,followRedirects:spec.followRedirects,maxRedirects:spec.maxRedirects}};
    if (count >= spec.maxRedirects || !response.headers.location) throw new Error('source_redirect_limit');
    const next = sourceUrl(new URL(response.headers.location, current.url).href);
    if (next.origin !== current.origin) {
      if (!['GET','HEAD'].includes(current.method)) throw new Error('source_redirect_denied');
      delete current.headers.authorization; delete current.headers.cookie; delete current.special.cookie;
    }
    if (response.statusCode === 303 || [301,302].includes(response.statusCode) && current.method === 'POST') { current.method = 'GET'; current.body = undefined; }
    current = {...current,url:next.href,origin:next.origin};
  }
}
