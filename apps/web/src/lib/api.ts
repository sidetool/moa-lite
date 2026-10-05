import { PROFILE_HEADER } from "@moa/shared";

export const hasLoginGate = document.querySelector('meta[name="moa-auth"]')?.getAttribute("content") === "enabled";

const PROFILE_KEY = "moa.profile";

export function currentProfileId(): string | null {
  try { return localStorage.getItem(PROFILE_KEY); } catch { return null; }
}

export function setCurrentProfileId(id: string | null) {
  try {
    if (id) localStorage.setItem(PROFILE_KEY, id);
    else localStorage.removeItem(PROFILE_KEY);
    const account = localStorage.getItem('moa-lite.account');
    if (account) {
      if (id) localStorage.setItem(`moa-lite.profile.${account}`, id);
      else localStorage.removeItem(`moa-lite.profile.${account}`);
    }
  } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message || code);
  }
}

type Json = Record<string, unknown> | unknown[];

type ApiInit = { method?: string; body?: Json; signal?: AbortSignal; keepalive?: boolean };
export const api = <T>(path: string, init: ApiInit = {}) => request<T>(`/api${path}`, init, false);
export const authApi = <T>(path: string, init: ApiInit = {}) => request<T>(`/__moa/api${path}`, init, true);

async function request<T>(path: string, init: ApiInit, auth: boolean): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const profile = currentProfileId();
  if (profile && !auth) headers[PROFILE_HEADER] = profile;
  const mutation = !['GET', 'HEAD'].includes(init.method ?? 'GET');
  if (auth) headers['X-Moa-Request'] = '1';
  const body = init.body ?? (auth && mutation ? {} : undefined);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (import.meta.env.VITE_MOA_LITE === '1' && auth && path.endsWith('/logout')) {
    await (await import('../../../lite/client/index')).beforeLogout();
  }
  const transport = import.meta.env.VITE_MOA_LITE === '1' && !auth
    ? (await import('../../../lite/client/index')).liteFetch : fetch;
  const response = await transport(path, {
    method: init.method ?? "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init.signal,
    keepalive: init.keepalive,
    credentials: "same-origin"
  });
  if (import.meta.env.VITE_MOA_LITE === '1' && auth && path.endsWith('/logout') && response.ok) (await import('../../../lite/client/index')).afterLogout();
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && data?.error === "login-required") {
      window.location.replace(`/__moa/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
    }
    if (response.status === 401 && data?.error === "profile-required") {
      setCurrentProfileId(null);
      window.dispatchEvent(new Event("moa:profile-required"));
    }
    if (response.status === 403 && data?.error === 'admin-required') {
      window.dispatchEvent(new Event('moa:admin-required'));
    }
    throw new ApiError(response.status, data?.error ?? "http-error", data?.message);
  }
  return data as T;
}

// TMDB serves fixed widths; posters and backdrops have different ladders.
const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)(\/.+)$/;
const TMDB_LADDERS: Record<string, number[]> = { w500: [342, 500, 780], w1280: [300, 780, 1280] };

/** Image URLs from the API may take a width hint for server-side resizing. */
export function sized(url: string | undefined, width: number): string | undefined {
  if (!url) return undefined;
  const tmdb = TMDB.exec(url);
  if (tmdb) {
    const ladder = TMDB_LADDERS[tmdb[2]];
    if (!ladder) return url;
    return `${tmdb[1]}w${ladder.find(w => w >= width) ?? ladder[ladder.length - 1]}${tmdb[3]}`;
  }
  if (!url.startsWith("/api/images/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}
