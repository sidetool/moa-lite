import { useMemo } from 'react';
import { deviceSettingsPatch, loadDevicePrefs, saveDevicePrefs, useDevicePrefs, useTitleGrouping } from "../lib/device-prefs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, HomeResponse, LibraryFolder, MediaCard, MediaDetail, MediaType, Page, Profile, ScanStatus, SearchGroup, Settings, HistoryEntry } from "@moa/shared";
import { api, currentProfileId } from "../lib/api";

export const keys = {
  me: ["me"] as const,
  profiles: ["profiles"] as const,
  home: (type?: MediaType) => ["home", type ?? "all"] as const,
  media: (id: string) => ["media", id] as const,
  list: (params: Record<string, string | number | undefined>) => ["media-list", params] as const,
  genres: (type?: MediaType) => ["genres", type ?? "all"] as const,
  search: (q: string) => ["search", q] as const,
  watchlist: ["watchlist"] as const,
  history: ["history"] as const,
  folders: ["library-folders"] as const,
  scan: ["library-scan"] as const,
  settings: ["settings"] as const
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Account>('/me'), retry: false });

export const useProfiles = () => useQuery({ queryKey: keys.profiles, queryFn: () => api<Profile[]>("/profiles") });

export const useHome = (type?: MediaType, providers?: string[], continueScope: "tab" | "all" = "tab") => {
  const titleGrouping = useTitleGrouping();
  return useQuery({ queryKey: [...keys.home(type), providers, continueScope, titleGrouping], queryFn: ({ signal }) => api<HomeResponse>(`/home?${new URLSearchParams({ continueScope, watchlistScope: continueScope, titleGrouping: String(titleGrouping), ...(type ? { type } : {}), ...(providers ? { providers: providers.join(",") } : {}) })}`, { signal }) });
};

export const useMedia = (id: string) =>
  useQuery({ queryKey: keys.media(id), queryFn: ({ signal }) => api<MediaDetail>(`/media/${encodeURIComponent(id)}`, { signal }), enabled: id !== "" });

export const useMediaList = (params: { type?: MediaType; provider?: string; genre?: string; sort?: string; page?: number }) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return useQuery({ queryKey: keys.list(params), queryFn: ({ signal }) => api<Page<MediaCard>>(`/media?${query}`, { signal }) });
};

export const useGenres = (type?: MediaType) =>
  useQuery({ queryKey: keys.genres(type), queryFn: () => api<string[]>(`/genres${type ? `?type=${type}` : ""}`), staleTime: 5 * 60_000 });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) => api<{ query: string; groups: SearchGroup[] }>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.trim().length > 0,
  });

export const useWatchlist = () => useQuery({ queryKey: keys.watchlist, queryFn: () => api<MediaCard[]>("/watchlist") });
export const useHistory = () => useQuery({ queryKey: keys.history, queryFn: () => api<Page<HistoryEntry>>("/history") });
export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: () => api<LibraryFolder[]>("/library/folders") });
export const useScanStatus = (poll: boolean) =>
  useQuery({ queryKey: keys.scan, queryFn: () => api<ScanStatus>("/library/status"), refetchInterval: poll ? 1500 : false });
export const useSettings = () => {
  const device = useDevicePrefs();
  const result = useQuery({ queryKey: keys.settings, queryFn: async ({ signal }) => {
    const profile = currentProfileId();
    const settings = await api<Settings>('/settings', { signal });
    if (settings && currentProfileId() === profile) await loadDevicePrefs(settings, signal);
    return settings;
  } });
  const deviceKey = JSON.stringify(deviceSettingsPatch(device));
  const data = useMemo(() => result.data ? { ...result.data, ...JSON.parse(deviceKey) } as Settings : result.data, [result.data, deviceKey]);
  return { ...result, data };
};

const settingsSaves = new Map<string | null, Promise<void>>();
export function useSaveSettings() {
  const client = useQueryClient(), profile = currentProfileId();
  const accountId = () => { try { return localStorage.getItem('moa-lite.account'); } catch { return null; } };
  const account = accountId();
  const current = () => currentProfileId() === profile && accountId() === account;
  return (patch: Partial<Settings>) => {
    // An input may commit during unmount after the viewer has changed profile.
    if (!current()) return Promise.resolve();
    const device = deviceSettingsPatch(patch);
    const deviceSave = Object.keys(device).length ? saveDevicePrefs(device) : Promise.resolve();
    patch = Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in device)));
    if (!Object.keys(patch).length) return deviceSave;
    client.setQueryData<Settings>(keys.settings, old => old ? { ...old, ...patch } : old);
    const save = (settingsSaves.get(profile) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!current()) return;
      const saved = await api<Settings>('/settings', { method: 'PATCH', body: patch, keepalive: true });
      if (settingsSaves.get(profile) === save && current()) client.setQueryData(keys.settings, saved);
    });
    settingsSaves.set(profile, save);
    void save.finally(() => {
      if (settingsSaves.get(profile) !== save) return;
      settingsSaves.delete(profile);
      if (currentProfileId() === profile) void client.invalidateQueries({ queryKey: keys.settings });
    }).catch(() => {});
    return Promise.all([save, deviceSave]).then(() => {});
  };
}

/** Optimistic watchlist toggle; card and detail caches update immediately. */
export function useWatchlistToggle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, add }: { id: string; add: boolean }) => api<void>(`/watchlist/${encodeURIComponent(id)}`, { method: add ? "PUT" : "DELETE" }),
    onMutate: async ({ id, add }) => {
      client.setQueryData<MediaDetail>(keys.media(id), old => (old ? { ...old, inWatchlist: add } : old));
    },
    onSettled: (_data, _error, { id }) => {
      void client.invalidateQueries({ queryKey: keys.media(id) });
      void client.invalidateQueries({ queryKey: keys.watchlist });
      void client.invalidateQueries({ queryKey: ["home"] });
    }
  });
}
