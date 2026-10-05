import type { NavigationTab, VideoSource } from '@moa/shared';
import { useSettings } from '../api/queries';
import { useSources } from '../pages/SourcesPage';

export const tabPath = (id: string) => id === 'home' ? '/' : `/tabs/${encodeURIComponent(id)}`;
export function defaultTabs(sources: VideoSource[]): NavigationTab[] {
  const active = sources.filter(s => s.enabled);
  const ids = (test: (s: VideoSource) => boolean) => active.filter(test).map(s => s.id);
  return [
    { id: 'home', name: '홈', sourceIds: ids(() => true), includeLocal: false },
    { id: 'movies', name: '영화', sourceIds: ids(s => !s.live && s.type !== 'anime'), includeLocal: false },
    { id: 'anime', name: '애니', sourceIds: ids(s => s.type === 'anime'), includeLocal: false },
    { id: 'series', name: '시리즈', sourceIds: ids(s => !s.live && s.type !== 'anime'), includeLocal: false },
    ...(import.meta.env.VITE_MOA_LITE === '1' ? [] : [{ id: 'local', name: '로컬 라이브러리', sourceIds: [], includeLocal: true }])
  ];
}
export function useNavigation() {
  const settings = useSettings(), sources = useSources();
  return { tabs: settings.data?.navigation ?? defaultTabs(sources.data ?? []), sources: sources.data ?? [], pending: settings.isPending || sources.isPending, error: settings.isError || sources.isError };
}
