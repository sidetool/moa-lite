import { useSyncExternalStore } from 'react';
import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings, type Settings } from '@moa/shared';
import { currentProfileId } from './api';

export type DevicePrefs = DeviceSettings;
const fallback = new Map<string, string>();
const storageKey = () => `moa.deviceSettings:${JSON.stringify([read('moa-lite.account'), currentProfileId()])}`;
const read = (key: string) => { try { return fallback.get(key) ?? localStorage.getItem(key); } catch { return fallback.get(key) ?? null; } };
function normalize(value: unknown): Partial<DeviceSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const limits: Record<string, [number, number]> = { subtitleScale: [50,250], subtitleShadow: [0,10], subtitleOutline: [0,6], subtitleHeight: [0,40], subtitlePadding: [0,20] };
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => {
    if (!Object.hasOwn(DEFAULT_DEVICE_SETTINGS, key)) return false;
    if (key in limits) return v === null && ['subtitleScale','subtitleShadow','subtitleOutline'].includes(key) || typeof v === 'number' && Number.isFinite(v) && v >= limits[key][0] && v <= limits[key][1];
    if (key === 'subtitleSize') return ['small','medium','large','xlarge'].includes(String(v));
    if (key === 'subtitleBackground') return ['original','none','soft','solid'].includes(String(v));
    return key === 'seekStep' ? [5,10,15,30].includes(v as number) : typeof v === 'boolean';
  }));
}
export function devicePrefs(): DevicePrefs {
  try { return { ...DEFAULT_DEVICE_SETTINGS, ...normalize(JSON.parse(read(storageKey()) || '{}')) }; } catch { return { ...DEFAULT_DEVICE_SETTINGS }; }
}
export function deviceSettingsPatch(settings: Partial<Settings> | Partial<DeviceSettings>): Partial<DeviceSettings> { return normalize(settings); }
export async function saveDevicePrefs(patch: Partial<DeviceSettings>) {
  const key = storageKey(), raw = JSON.stringify({ ...devicePrefs(), ...normalize(patch) });
  fallback.set(key, raw);
  try { localStorage.setItem(key, raw); fallback.delete(key); } catch {}
  window.dispatchEvent(new Event('moa:device-prefs'));
}
export async function loadDevicePrefs(settings: Settings, signal: AbortSignal) {
  if (signal.aborted || read(storageKey())) return;
  const legacy: Record<string, unknown> = {};
  // Legacy global choices are assigned once; later profiles start independently.
  if (!read('moa.liteDeviceSettingsMigrated')) {
    for (const name of ['fullscreenOnPlay','autoSkip','videoFill','seasonSwitcher','titleGrouping']) { const v = read(`moa.${name}`); if (v !== null) legacy[name] = v === '1'; }
    if (read('moa.seekStep')) legacy.seekStep = Number(read('moa.seekStep'));
    try { const old = JSON.parse(read('moa.subtitleAppearance') || '{}'); legacy.subtitleSize = old.size; legacy.subtitleBackground = old.background; } catch {}
    if (read('moa.subtitleHeight') !== null) legacy.subtitleHeight = Number(read('moa.subtitleHeight'));
  }
  await saveDevicePrefs({ ...normalize(settings), ...normalize(legacy) });
  fallback.set('moa.liteDeviceSettingsMigrated','1');
  try { localStorage.setItem('moa.liteDeviceSettingsMigrated','1'); } catch {}
}
export function setDevicePref<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) { void saveDevicePrefs({ [key]: value }); }
const subscribe = (notify: () => void) => {
  window.addEventListener('moa:device-prefs', notify); window.addEventListener('storage', notify);
  return () => { window.removeEventListener('moa:device-prefs', notify); window.removeEventListener('storage', notify); };
};
export function useDevicePrefs() { useSyncExternalStore(subscribe, () => read(storageKey()), () => null); return devicePrefs(); }
export function useTitleGrouping() { return useSyncExternalStore(subscribe, () => devicePrefs().titleGrouping, () => true); }
