import { TabSourceFilters } from './SourceFilters';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Check, ChevronDown, FolderOpen, House, UserPlus, Pencil, Plus, Radio, RotateCcw, Trash2, Tv, X } from 'lucide-react';
import type { BrowseSelection, DefaultNavigation, NavigationTab, Settings, VideoSource } from '@moa/shared';
import { useMe } from '../api/queries';
import { api } from '../lib/api';
import { defaultTabs, useNavigation } from '../lib/navigation';
import { cx } from '../lib/format';
import { Button, ButtonLink, IconButton, Skeleton } from './ui';

const typeLabel = (s: VideoSource) => s.live ? '실시간' : s.type === 'anime' ? '애니' : s.type === 'movie' ? '영화' : '영화·시리즈';

/** Home tabs: a compact ordered list; each tab is edited in a sheet and saved at once. */
export function NavigationSettings() {
  const { tabs, sources, pending, error } = useNavigation();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<NavigationTab | null>(null);
  const save = useMutation({
    mutationFn: (navigation: NavigationTab[]) => api<Settings>('/settings', { method: 'PATCH', body: { navigation } }),
    onMutate: navigation => { client.setQueryData<Settings>(['settings'], old => old ? { ...old, navigation } : old); },
    onSuccess: data => client.setQueryData(['settings'], data),
    onError: () => void client.invalidateQueries({ queryKey: ['settings'] })
  });

  // Deep link from an empty tab: /settings/tabs?edit=<id>
  const editId = params.get('edit');
  useEffect(() => {
    if (pending || !editId) return;
    const tab = tabs.find(t => t.id === editId);
    if (tab) setEditing(tab);
    const next = new URLSearchParams(params); next.delete('edit'); setParams(next, { replace: true });
  }, [pending, editId]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (i: number, step: number) => { const next = [...tabs]; [next[i], next[i + step]] = [next[i + step], next[i]]; save.mutate(next); };
  const commit = (tab: NavigationTab) => {
    const clean = { ...tab, name: tab.name.trim() };
    save.mutate(tabs.some(t => t.id === tab.id) ? tabs.map(t => t.id === tab.id ? clean : t) : [...tabs, clean]);
    setEditing(null);
  };
  const remove = (tab: NavigationTab) => {
    if (!confirm(`'${tab.name}' 탭을 삭제할까요?`)) return;
    save.mutate(tabs.filter(t => t.id !== tab.id));
    setEditing(null);
  };
  const summary = (tab: NavigationTab) => {
    const names = tab.sourceIds.map(id => sources.find(s => s.id === id)).filter(Boolean).map(s => s!.name + (s!.enabled ? '' : ' (꺼짐)'));
    if (tab.includeLocal) names.push('로컬 라이브러리');
    return names.length ? names.join(' · ') : '표시할 소스 없음';
  };

  return <section className="settings-group" id="tabs" aria-labelledby="tabs-title">
    <div className="settings-group-head">
      <h2 id="tabs-title">홈 화면 탭</h2>
      <button className="text-btn" disabled={pending || save.isPending} onClick={() => { if (confirm('탭 구성을 기본값으로 되돌릴까요?')) save.mutate(defaultTabs(sources)); }}><RotateCcw size={14} />기본값</button>
    </div>
    {pending ? <Skeleton className="folder-sk" /> : error ? <p className="settings-error" role="alert">구성 정보를 불러오지 못했어요.</p> : <>
      <ol className="tab-list">
        {tabs.map((tab, i) => <li key={tab.id} className="tab-item">
          <span className="tab-item-icon">{i === 0 ? <House size={18} /> : i}</span>
          <button className="tab-item-body" onClick={() => setEditing(tab)}>
            <b>{tab.name}</b>
            <small className={cx(!tab.sourceIds.length && !tab.includeLocal && 'is-warn')}>{summary(tab)}</small>
          </button>
          <div className="tab-item-actions">
            {i > 0 && <>
              <IconButton label={`${tab.name} 위로`} disabled={i === 1 || save.isPending} onClick={() => move(i, -1)}><ArrowUp size={18} /></IconButton>
              <IconButton label={`${tab.name} 아래로`} disabled={i === tabs.length - 1 || save.isPending} onClick={() => move(i, 1)}><ArrowDown size={18} /></IconButton>
            </>}
            <IconButton label={`${tab.name} 편집`} onClick={() => setEditing(tab)}><Pencil size={17} /></IconButton>
          </div>
        </li>)}
      </ol>
      <div className="tab-list-foot">
        <Button icon={<Plus size={18} />} disabled={tabs.length >= 12} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', sourceIds: [], includeLocal: false })}>탭 추가</Button>
        <span>{save.isPending ? '저장 중…' : save.isError ? '저장하지 못했어요. 다시 시도해 주세요.' : '같은 프로필의 모든 기기에 적용돼요.'}</span>
      </div>
      <DefaultTabs tabs={tabs} sources={sources} />
    </>}
    {editing && <TabEditor tab={editing} isNew={!tabs.some(t => t.id === editing.id)} isHome={tabs[0]?.id === editing.id} sources={sources} onSave={commit} onDelete={remove} onClose={() => setEditing(null)} />}
  </section>;
}

function TabEditor({ tab, isNew, isHome, sources, onSave, onDelete, onClose }: { tab: NavigationTab; isNew: boolean; isHome: boolean; sources: VideoSource[]; onSave: (tab: NavigationTab) => void; onDelete: (tab: NavigationTab) => void; onClose: () => void }) {
  const admin = useMe().data?.role === 'admin';
  const [draft, setDraft] = useState(tab);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => { if (isNew) name.current?.focus(); }, [isNew]);
  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const usable = sources.filter(s => s.installed || draft.sourceIds.includes(s.id));
  const toggle = (id: string) => setDraft(d => ({ ...d, sourceIds: d.sourceIds.includes(id) ? d.sourceIds.filter(x => x !== id) : [...d.sourceIds, id] }));
  const setFilter = (id: string, value: BrowseSelection | undefined) => {
    const next = { ...draft.sourceFilters };
    if (value) next[id] = value; else delete next[id];
    setDraft(d => ({ ...d, sourceFilters: next }));
  };
  const valid = draft.name.trim().length > 0;
  return <div className="sheet-backdrop" onClick={onClose}>
    <form className="sheet tab-editor" role="dialog" aria-modal="true" aria-label={isNew ? '새 탭' : `${tab.name} 탭 편집`} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (valid) onSave(draft); }}>
      <header className="sheet-head"><h2>{isNew ? '새 탭' : '탭 편집'}</h2><IconButton type="button" label="닫기" onClick={onClose}><X size={20} /></IconButton></header>
      <div className="tab-editor-body">
        <label className="field"><span>{isHome ? '홈 이름' : '탭 이름'}</span>
          <input ref={name} required maxLength={24} placeholder="예: 애니, 예능, 영화" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        </label>
        <div className="field"><span>이 탭에 보여줄 소스</span>
          <ul className="pick-list">
            {usable.map(source => {
              const on = draft.sourceIds.includes(source.id);
              return <li key={source.id} className={cx(on && 'is-on')}>
                <button type="button" className={cx('pick', on && 'is-on')} aria-pressed={on} onClick={() => toggle(source.id)}>
                  <span className="pick-icon">{source.live ? <Radio size={18} /> : <Tv size={18} />}</span>
                  <span className="pick-body"><b>{source.name}</b><small>{typeLabel(source)}{!source.enabled && ' · 꺼짐'}{draft.sourceFilters?.[source.id]?.filters.length ? ' · 조건 적용' : ''}</small></span>
                  <span className="pick-check">{on && <Check size={16} />}</span>
                </button>
                {on && !source.live && <button type="button" className={cx('pick-more', advanced === source.id && 'is-open')} aria-expanded={advanced === source.id} onClick={() => setAdvanced(advanced === source.id ? null : source.id)}>표시 조건<ChevronDown size={15} /></button>}
                {on && advanced === source.id && <div className="pick-filters"><TabSourceFilters id={source.id} value={draft.sourceFilters?.[source.id]} onChange={v => setFilter(source.id, v)} /></div>}
              </li>;
            })}
            {import.meta.env.VITE_MOA_LITE !== "1" && <li className={cx(draft.includeLocal && 'is-on')}>
              <button type="button" className={cx('pick', draft.includeLocal && 'is-on')} aria-pressed={draft.includeLocal} onClick={() => setDraft(d => ({ ...d, includeLocal: !d.includeLocal }))}>
                <span className="pick-icon"><FolderOpen size={18} /></span>
                <span className="pick-body"><b>로컬 라이브러리</b><small>내 서버의 영상 폴더</small></span>
                <span className="pick-check">{draft.includeLocal && <Check size={16} />}</span>
              </button>
            </li>}
          </ul>
          {!usable.length && <p className="settings-hint">설치한 소스가 없어요. {admin ? <ButtonLink to="/sources" size="m">소스 설치</ButtonLink> : '관리자에게 소스 설치를 부탁해 주세요.'}</p>}
        </div>
      </div>
      <footer className="sheet-foot">
        {!isNew && !isHome ? <Button type="button" variant="ghost" icon={<Trash2 size={17} />} className="btn-danger" onClick={() => onDelete(tab)}>삭제</Button> : <span />}
        <div className="sheet-foot-actions">
          <Button type="button" onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" disabled={!valid}>{isNew ? '추가' : '저장'}</Button>
        </div>
      </footer>
    </form>
  </div>;
}

/** Admin only: what a brand-new profile (any account) starts with. */
function DefaultTabs({ tabs, sources }: { tabs: NavigationTab[]; sources: VideoSource[] }) {
  const admin = useMe().data?.role === 'admin';
  const client = useQueryClient();
  const current = useQuery({ queryKey: ['default-navigation'], queryFn: () => api<DefaultNavigation>('/admin/default-navigation'), enabled: admin });
  const save = useMutation({
    mutationFn: (navigation: NavigationTab[] | null) => api<DefaultNavigation>('/admin/default-navigation', { method: 'PUT', body: { navigation } }),
    onSuccess: data => client.setQueryData(['default-navigation'], data)
  });
  if (!admin) return null;
  const nav = current.data?.navigation;
  const same = !!nav && JSON.stringify(nav.map(t => [t.name, t.sourceIds, t.includeLocal])) === JSON.stringify(tabs.map(t => [t.name, t.sourceIds, t.includeLocal]));
  const names = nav?.map(t => t.name).join(' · ');
  const known = new Set(sources.map(s => s.id));
  const missing = nav?.some(t => t.sourceIds.some(id => !known.has(id)));
  return <div className="default-tabs">
    <span className="setting-icon"><UserPlus size={20} /></span>
    <div className="default-tabs-copy">
      <b>새 프로필 기본 탭</b>
      <small>{current.isPending ? '불러오는 중…' : nav ? <>{same ? '지금 이 탭 구성과 같아요' : names}{missing ? ' · 삭제된 소스는 빼고 적용돼요' : ''}</> : '지정 안 함 · 설치된 소스로 자동 구성돼요'}</small>
      <small className="default-tabs-note">새로 가입한 사람이나 새로 만든 프로필이 처음 보는 홈 탭이에요. 이미 있는 프로필은 바뀌지 않아요.</small>
    </div>
    <div className="default-tabs-actions">
      <Button disabled={save.isPending || same} onClick={() => save.mutate(tabs)}>{same ? <><Check size={16} />기본으로 지정됨</> : '이 구성을 기본으로'}</Button>
      {nav && <button className="text-btn" disabled={save.isPending} onClick={() => save.mutate(null)}>자동으로 되돌리기</button>}
    </div>
    {save.isError && <p className="settings-error" role="alert">저장하지 못했어요. 다시 시도해 주세요.</p>}
  </div>;
}
