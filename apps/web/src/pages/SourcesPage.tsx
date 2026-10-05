import { SourceFilters, useSourceFilters } from '../components/SourceFilters';
import { sourcePage, parseSelection } from '../lib/source-browse';
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Plus, Radio, RefreshCw, Search, Settings2, Trash2, Tv, X } from 'lucide-react';
import type { BrowseSelection, MediaCard, MediaType, Page, SourcePreference, SourceRemovalImpact, SourceRemovalResult, VideoSource } from '@moa/shared';
import { api, ApiError, sized } from '../lib/api';
import { useMe } from '../api/queries';
import { Button, ButtonLink, EmptyState, IconButton, Skeleton, Spinner } from '../components/ui';
import { LandscapeCard, PosterCard } from '../components/Cards';
import { Row, RowSkeleton } from '../components/Row';
import { cx } from '../lib/format';

export const useSources = () => useQuery({ queryKey: ['sources'], queryFn: () => api<VideoSource[]>('/sources') });
const path = (id: string) => `/sources/${encodeURIComponent(id)}`;
const message = '소스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
function useSourcePage(source: VideoSource, mode: string, q = '') {
  return useQuery({ queryKey: ['source-page',source.id,mode,q], queryFn: ({ signal }) => api<Page<MediaCard>>(`${path(source.id)}/browse?mode=${mode}&q=${encodeURIComponent(q)}`, { signal }), staleTime: 5 * 60_000, retry: false });
}
export function SourceRow({ source, type }: { source: VideoSource; type?: MediaType }) {
  const page = useSourcePage(source,'popular');
  if (page.isPending) return <RowSkeleton />;
  if (page.isError) return <section className="source-row-error"><h2>{source.name}</h2><span>{message}</span><button className="text-btn" onClick={() => void page.refetch()}>다시 시도</button></section>;
  const items = page.data.items.filter(c => !type || c.type === type);
  if (!items.length) return null;
  return <Row row={{ id: source.id, title: source.name, kind: 'media', layout: source.live ? 'landscape' : 'poster', items: items.slice(0,20), more: { path: path(source.id) } }} />;
}
export function SourceSearch({ source, query }: { source: VideoSource; query: string }) {
  const page = useSourcePage(source,'search',query);
  return <section className="search-group"><h2>{source.name}{page.data && <small>{page.data.items.length}</small>}</h2>
    {page.isPending ? <RowSkeleton /> : page.isError ? <p className="search-error">{message} <button className="text-btn" onClick={() => void page.refetch()}>다시 시도</button></p> : page.data.items.length ? <div className="grid">{page.data.items.map(card => <PosterCard key={card.id} card={card} />)}</div> : <p className="source-muted">검색 결과가 없습니다.</p>}
  </section>;
}
export function SourceBrowsePage() {
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const sources = useSources(), source = sources.data?.find(s => s.id === id);
  const admin = useMe().data?.role === 'admin';
  const [params,setParams] = useSearchParams();
  const term = params.get('q')?.trim() || '';
  const [input,setInput] = useState(term);
  useEffect(() => setInput(term), [term,id]);
  const schema = useSourceFilters(source?.enabled ? id : '');
  const rawFilters = params.get('filters');
  const selection = parseSelection(rawFilters);
  const [draft,setDraft] = useState<BrowseSelection | undefined>(selection);
  useEffect(() => setDraft(selection), [rawFilters,id]);
  const mode = term || selection?.filters?.length ? 'search' : params.get('mode') === 'latest' ? 'latest' : 'popular';
  const setMode = (mode: string) => setParams({ mode }, { replace: true });
  const query = useInfiniteQuery({ queryKey: ['source-browse',id,mode,term,selection], initialPageParam: 1, queryFn: ({ pageParam, signal }) => sourcePage(id,mode,term,pageParam,selection,signal), getNextPageParam: last => last.hasNextPage ? last.page + 1 : undefined, enabled: Boolean(source?.enabled), staleTime: 5 * 60_000, retry: false });
  const items = [...new Map(query.data?.pages.flatMap(p => p.items).map(item => [item.id,item]) || []).values()];
  return <div className="page-pad"><header className="page-head"><button type="button" className="text-btn" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate("/", { replace: true })}><ArrowLeft size={16}/>뒤로</button><h1>{source?.name || '소스'}</h1></header>
    <form className="source-search-form" role="search" onSubmit={e => { e.preventDefault(); const next = new URLSearchParams(params); next.set('q',input.trim()); setParams(next, { replace: true }); }}><label className="field"><span>{source?.name || '이 소스'}에서 검색</span><input type="search" aria-label="이 소스에서 검색" placeholder="작품 제목" maxLength={200} value={input} onChange={e => setInput(e.target.value)}/></label><Button type="submit" variant="primary">검색</Button>{term && <Button type="button" onClick={() => {const next = new URLSearchParams(params); next.delete('q'); setParams(next, { replace: true });}}>검색 지우기</Button>}</form>
    <div className="source-toolbar"><div className="segmented">{[['popular','인기'],['latest','최신']].filter(([value]) => schema.data?.availableModes.includes(value)).map(([value,label]) => <button key={value} className={cx(mode === value && 'is-active')} onClick={() => setMode(value)}>{label}</button>)}</div><Button icon={<RefreshCw size={16}/>} onClick={() => void query.refetch()} disabled={query.isFetching}>새로고침</Button></div>
    {rawFilters && !selection && <p role="alert">저장된 필터 주소를 읽을 수 없습니다. <button className="text-btn" onClick={() => { const next=new URLSearchParams(params); next.delete('filters'); setParams(next, { replace: true }); }}>조건 초기화</button></p>}
    <details className="browse-filters"><summary>필터와 정렬{selection?.filters?.length ? ' · 적용 중' : ''}</summary>{schema.data ? <><SourceFilters schema={schema.data} value={draft} onChange={setDraft}/><Button variant="primary" onClick={() => { const next=new URLSearchParams(params); if(draft) next.set('filters',JSON.stringify(draft)); else next.delete('filters'); setParams(next, { replace: true }); }}>조건 적용</Button></> : <p>{schema.isPending ? '불러오는 중…' : '필터를 불러오지 못했습니다.'}</p>}</details>
    {term && <p className="source-muted">“{term}” 검색 결과 · {items.length}개{query.hasNextPage ? " 이상" : ""}</p>}
    {sources.isSuccess && !source?.enabled ? <EmptyState title={admin ? "소스를 켜 주세요" : "지금은 쓸 수 없는 소스예요"} body={admin ? undefined : "관리자가 이 소스를 끄거나 지웠어요."} action={admin ? <ButtonLink to="/sources">소스 관리</ButtonLink> : undefined} /> : query.isPending ? <RowSkeleton /> : <><div className={cx("grid", source?.live && "live-grid")}>{items.map(card => source?.live ? <LandscapeCard card={card} key={card.id}/> : <PosterCard card={card} key={card.id}/>)}</div>{query.isError && <EmptyState title="목록을 불러오지 못했습니다" body={rawFilters ? "확장 업데이트로 조건이 달라졌을 수 있습니다. 필터를 초기화하거나 다시 선택해 주세요." : message} action={<Button onClick={() => void query.refetch()}>다시 시도</Button>} />}{!items.length && !query.isError && <EmptyState title="표시할 작품이 없습니다"/>}{query.hasNextPage && <div className="source-more"><Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '불러오는 중…' : '더 보기'}</Button></div>}</>}
  </div>;
}
function Preferences({ source }: { source: VideoSource }) {
  const query = useQuery({ queryKey: ['source-preferences',source.id], queryFn: () => api<SourcePreference[]>(`${path(source.id)}/preferences`), retry: false });
  const [changes,setChanges] = useState<Record<string,unknown>>({});
  const client = useQueryClient();
  const save = useMutation({ mutationFn: () => api<SourcePreference[]>(`${path(source.id)}/preferences`, { method: 'PATCH', body: changes }), onSuccess: data => { client.setQueryData(['source-preferences',source.id],data); setChanges({}); void client.invalidateQueries({ queryKey: ['source-page',source.id] }); void client.invalidateQueries({ queryKey: ['source-browse',source.id] }); } });
  return <div className="source-preferences">
    {query.isPending && <Skeleton className="folder-sk"/>}
    {query.isError && <p role="alert">설정을 불러오지 못했습니다. <button className="text-btn" onClick={() => void query.refetch()}>다시 시도</button></p>}
    {query.data?.map(p => { const value = changes[p.key] ?? p.value; const set = (v: unknown) => { save.reset(); setChanges(old => ({ ...old,[p.key]:v })); }; return <div className="field" key={p.key}><label htmlFor={`pref-${p.key}`}>{p.title}</label>
      {p.kind === 'boolean' ? <input id={`pref-${p.key}`} type="checkbox" checked={Boolean(value)} onChange={e => set(e.target.checked)}/> : p.kind === 'select' ? <select id={`pref-${p.key}`} value={String(value ?? '')} onChange={e => set(p.choices?.find(c => String(c.value) === e.target.value)?.value)}>{p.choices?.map(c => <option key={String(c.value)} value={String(c.value)}>{c.label}</option>)}</select> : p.kind === 'multi-select' ? <div>{p.choices?.map(c => <label className="source-choice" key={String(c.value)}><input type="checkbox" checked={Array.isArray(value) && value.includes(String(c.value))} onChange={e => set(e.target.checked ? [...(Array.isArray(value) ? value : []),String(c.value)] : (Array.isArray(value) ? value : []).filter(v => v !== String(c.value)))}/>{c.label}</label>)}</div> : <input id={`pref-${p.key}`} type={p.secret ? 'password' : 'text'} value={String(value ?? '')} placeholder={p.configured ? '저장된 값 유지' : ''} autoComplete="off" onChange={e => set(e.target.value)}/>}
      {p.summary && <small>{p.summary}</small>}
    </div>; })}
    {query.data?.length === 0 && <p className="source-muted">추가 설정이 없는 소스입니다.</p>}
    {!!query.data?.length && <Button variant="primary" disabled={!Object.keys(changes).length || save.isPending} onClick={() => save.mutate()}>{save.isPending ? '저장 중…' : '설정 저장'}</Button>}
    {save.isError && <p role="alert">설정을 저장하지 못했습니다.</p>}{save.isSuccess && <p role="status">저장했습니다.</p>}
  </div>;
}
const LANG_LABEL: Record<string, string> = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', 'zh-hans': '중국어 간체', 'zh-hant': '중국어 번체', es: '스페인어', fr: '프랑스어', de: '독일어', pt: '포르투갈어', ru: '러시아어', id: '인도네시아어', th: '태국어', vi: '베트남어', ar: '아랍어', it: '이탈리아어', tr: '튀르키예어', all: '다국어', multi: '다국어' };
const langLabel = (lang: string) => LANG_LABEL[lang.toLowerCase()] ?? lang.toUpperCase();
const sameName = (name: string) => name.trim().toLowerCase();

/** The extension's own icon; the generic symbol stays until it loads and comes back if it is missing or broken. */
function SourceIcon({ source }: { source: VideoSource }) {
  // Keyed by URL so a new icon starts over without an effect racing a cached image's load event.
  const [result, setResult] = useState<{ url: string; state: 'loaded' | 'failed' } | null>(null);
  const state = source.iconUrl && result?.url === source.iconUrl ? result.state : 'loading';
  const setState = (next: 'loaded' | 'failed') => { if (source.iconUrl) setResult({ url: source.iconUrl, state: next }); };
  const icon = source.iconUrl && state !== 'failed' ? sized(source.iconUrl, 104) : undefined;
  return <span className={cx('source-symbol', state === 'loaded' && icon && 'has-icon')}>
    {(!icon || state !== 'loaded') && (source.live ? <Radio size={24}/> : <Tv size={24}/>)}
    {icon && <img src={icon} alt="" width={52} height={52} loading="lazy" decoding="async" draggable={false}
      onLoad={event => setState(event.currentTarget.naturalWidth ? 'loaded' : 'failed')} onError={() => setState('failed')}/>}
  </span>;
}

function SourceEntry({ source, duplicateName = false }: { source: VideoSource; duplicateName?: boolean }) {
  const client = useQueryClient();
  const [settings,setSettings] = useState(false);
  const [removing,setRemoving] = useState(false);
  const operation = useMutation({ mutationFn: ({ install, body }: { install?: boolean; body?: Record<string, string | boolean> }) => api<VideoSource>(`${path(source.id)}${install ? '/install' : ''}`, { method: install ? 'POST' : 'PATCH', ...(body ? { body } : {}) }), onSuccess: () => { void client.invalidateQueries({ queryKey: ['source-filters',source.id] }); void client.invalidateQueries({ queryKey: ['tab-source',source.id] }); void client.invalidateQueries({ queryKey: ['source-browse',source.id] }); void client.invalidateQueries({ queryKey: ['sources'] }); void client.invalidateQueries({ queryKey: ['home'] }); } });
  const maintenance=useMutation({mutationFn:(action:'check'|'rollback')=>api<VideoSource>(`${path(source.id)}/${action}`,{method:'POST'}),onSuccess:async()=>{await client.invalidateQueries({queryKey:['sources']});await client.invalidateQueries({queryKey:['source-filters',source.id]});await client.invalidateQueries({queryKey:['source-browse',source.id]});await client.invalidateQueries({queryKey:['tab-source',source.id]});}});
  const healthText:Record<string,string>={'timeout':'응답 시간 초과','access-denied':'접근 제한 또는 인증 확인 필요','connection-failed':'네트워크·프록시 연결 실패','unsupported':'지원되지 않는 확장 기능','source-error':'소스 응답 오류','preparation-required':'APK를 다시 준비해야 합니다'};
  const update = source.installed && source.installedVersion !== source.version;
  return <article className="source-entry"><div className="source-entry-main"><SourceIcon source={source}/><div className="source-description"><h2>{source.name}{source.lang && (duplicateName || !['ko', 'kor'].includes(source.lang.toLowerCase())) && <span className="source-lang" title={`언어: ${source.lang}`}>{langLabel(source.lang)}</span>}</h2><p>{source.live ? '실시간 방송' : source.type === 'anime' ? '애니메이션' : '영화 · 시리즈'}<span> · {source.installedVersion || source.version}{source.kind==='aniyomi-apk'?' · APK':''}</span></p><small className="source-origin" title={source.repository}>{source.repository}</small></div><div className="source-actions">
    {source.enabled && <ButtonLink to={path(source.id)} icon={<ChevronRight size={16}/>}>둘러보기</ButtonLink>}
    {(!source.installed || update) && <Button disabled={operation.isPending} variant={source.installed ? 'secondary' : 'primary'} onClick={() => operation.mutate({ install: true })}>{operation.isPending ? '설치 중…' : update ? '업데이트' : '설치'}</Button>}
    {source.installed && <><Button disabled={operation.isPending} aria-pressed={source.enabled} onClick={() => operation.mutate({ body: { enabled: !source.enabled } })}>{source.enabled ? '끄기' : '켜기'}</Button>{source.enabled && <button className="icon-btn" aria-label={`${source.name} 설정`} aria-expanded={settings} onClick={() => setSettings(v => !v)}><Settings2 size={20}/></button>}<button className="icon-btn source-remove" aria-label={`${source.name} 삭제`} title="삭제" onClick={() => setRemoving(true)}><Trash2 size={19}/></button></>}
  </div></div>
  {source.installed && (source.enabled || source.rollbackVersion || source.health) && <div className="source-maintenance"><div className="source-actions">{source.enabled && <Button disabled={maintenance.isPending} onClick={()=>maintenance.mutate('check')}>{maintenance.isPending && maintenance.variables==='check'?'연결 확인 중…':'연결 확인'}</Button>}{source.kind==='aniyomi-apk' && source.health?.code==='preparation-required' && <Button disabled={operation.isPending} onClick={()=>operation.mutate({install:true})}>{operation.isPending?'준비 중…':'다시 준비'}</Button>}{source.rollbackVersion && <Button disabled={maintenance.isPending} onClick={()=>maintenance.mutate('rollback')}>이전 버전 {source.rollbackVersion} 복원</Button>}</div>{source.health && <p role="status">{source.health.ok?'최근 소스 요청 정상':healthText[source.health.code || ''] || '소스 응답 오류'} · {new Date(source.health.checkedAt).toLocaleString('ko-KR')}</p>}<p className="source-muted">연결 확인은 목록을 조회합니다. 영상 서버의 재생 상태는 별도로 확인해야 합니다.</p>{maintenance.isError && <p role="alert">작업하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}</div>}
  {operation.isError && <p className="search-error" role="alert">{operation.error instanceof ApiError && operation.error.code==='apk_playback_active'?'APK 소스로 재생 중인 영상을 종료한 뒤 설치·업데이트해 주세요.':'변경하지 못했습니다. 업데이트 실패 시 기존 설치는 유지됩니다.'}</p>}
  {removing && <RemoveSourcesSheet sources={[source]} onClose={()=>setRemoving(false)}/>}
  {settings && source.enabled && <div className="source-settings"><div className="source-toolbar"><label>기본 분류 <select value={source.type} disabled={operation.isPending} onChange={e => operation.mutate({ body: { type: e.target.value } })}><option value="series">시리즈</option><option value="movie">영화</option><option value="anime">애니</option></select></label><label><input type="checkbox" checked={source.live} disabled={operation.isPending} onChange={e => operation.mutate({ body: { live: e.target.checked } })}/> 실시간 방송</label></div><Preferences source={source}/></div>}
  </article>;
}
export function SourcesPage() {
  const sources = useSources(), client = useQueryClient();
  const repos=useQuery({queryKey:['source-repositories'],queryFn:()=>api<Array<{url:string;kind?:"mangayomi-js"|"aniyomi-apk";checkedAt?:string;error?:string}>>('/source-repositories')});
  const removeRepo=useMutation({mutationFn:(url:string)=>api('/source-repositories',{method:'DELETE',body:{url}}),onSuccess:async()=>{await client.invalidateQueries({queryKey:['source-repositories']});await client.invalidateQueries({queryKey:['sources']});}});
  const [kind,setKind] = useState<'mangayomi-js'|'aniyomi-apk'>('mangayomi-js');
  const [url,setUrl] = useState('');
  const refresh = useMutation({ mutationFn: (repository:{url:string;kind?:'mangayomi-js'|'aniyomi-apk'}) => api<VideoSource[]>('/sources/refresh', { method: 'POST', body: repository }), onSuccess: data => {client.setQueryData(['sources'],data);setUrl('');}, onSettled:()=>{void client.invalidateQueries({queryKey:['source-repositories']});} });
  const list = sources.data || [];
  // Language editions of one extension often share a name; their language then tells them apart.
  const duplicates = new Set(list.map(s => sameName(s.name)).filter((name, i, all) => all.indexOf(name) !== i));
  const [filter,setFilter] = useState<SourceFilter>('all');
  const [q,setQ] = useState('');
  const [bulk,setBulk] = useState(false);
  const counts = { all: list.length, on: list.filter(s => s.enabled).length, off: list.filter(s => s.installed && !s.enabled).length, available: list.filter(s => !s.installed).length };
  const term = q.trim().toLowerCase();
  const shown = list.filter(s => FILTERS[filter].test(s) && (!term || s.name.toLowerCase().includes(term) || s.repository.toLowerCase().includes(term)));
  const off = list.filter(s => s.installed && !s.enabled);

  return <div className="page-pad narrow"><header className="page-head"><p className="page-kicker">MOA에 연결하기</p><h1>영상 소스</h1><p className="source-muted">원하는 소스를 설치하면 홈과 검색에서 함께 볼 수 있습니다.</p></header>
    <form className="source-repository" onSubmit={e => { e.preventDefault(); refresh.mutate({url,kind}); }}><label className="field"><span>형식</span><select aria-label="확장 저장소 형식" value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="mangayomi-js">Mangayomi</option>{import.meta.env.VITE_MOA_LITE !== "1" && <option value="aniyomi-apk">Aniyomi APK</option>}</select></label><label className="field"><span>확장 저장소</span><input type="url" required value={url} onChange={e => setUrl(e.target.value)} aria-label="확장 저장소 주소" placeholder="https://example.com/index.min.json"/></label><Button type="submit" icon={list.length ? <RefreshCw size={18}/> : <Plus size={18}/>} disabled={refresh.isPending}>{refresh.isPending ? '확인 중…' : '저장소 추가'}</Button></form>
    {refresh.isError && <p className="search-error" role="alert">{refresh.error instanceof ApiError && refresh.error.code==='apk-bridge-unavailable'?'APK 실행 서비스에 연결하지 못했습니다.':'저장소 목록을 가져오지 못했습니다. 주소와 연결을 확인해 주세요.'}</p>}
    <div className="repository-list">{repos.data?.map(repo=><article className="repository-entry" key={repo.url}><a href={repo.url} target="_blank" rel="noreferrer">{repo.url}</a><small>{repo.checkedAt?`최근 확인 ${new Date(repo.checkedAt).toLocaleString('ko-KR')}`:'아직 갱신하지 않음'}</small><div className="source-actions"><Button disabled={refresh.isPending} onClick={()=>refresh.mutate({url:repo.url,kind:repo.kind})}>목록·업데이트 확인</Button><Button disabled={removeRepo.isPending} onClick={()=>removeRepo.mutate(repo.url)}>등록 해제</Button></div>{repo.error && <p role="alert">{repo.error}</p>}</article>)}</div><p className="source-muted">저장소 등록을 해제해도 이미 설치한 소스와 시청 기록은 유지됩니다.</p>{removeRepo.isError && <p role="alert">저장소 등록을 해제하지 못했습니다.</p>}
    {sources.isPending && <Skeleton className="folder-sk"/>}{sources.isError && <EmptyState title="소스 목록을 불러오지 못했습니다" action={<Button onClick={() => void sources.refetch()}>다시 시도</Button>}/>}
    {list.length > 0 && <div className="source-filterbar">
      <div className="choice-row" role="tablist" aria-label="소스 상태">{(Object.keys(FILTERS) as SourceFilter[]).map(key => <button key={key} role="tab" aria-selected={filter === key} className={cx('chip', filter === key && 'is-active')} onClick={() => setFilter(key)}>{FILTERS[key].label}<small>{counts[key]}</small></button>)}</div>
      <label className="source-find"><Search size={16} aria-hidden="true"/><input value={q} placeholder="소스 이름 검색" aria-label="소스 이름 검색" onChange={e => setQ(e.target.value)}/>{q && <button type="button" aria-label="지우기" onClick={() => setQ('')}><X size={14}/></button>}</label>
    </div>}
    {filter === 'off' && off.length > 0 && <div className="source-bulk"><span>꺼진 소스 <b>{off.length}개</b>를 한 번에 정리할 수 있어요.</span><Button variant="ghost" className="btn-danger" icon={<Trash2 size={16}/>} onClick={() => setBulk(true)}>모두 삭제</Button></div>}
    {shown.map(source => <SourceEntry key={source.id} source={source} duplicateName={duplicates.has(sameName(source.name))}/>)}
    {sources.isSuccess && list.length > 0 && !shown.length && <EmptyState title={term ? `'${q.trim()}'에 맞는 소스가 없어요` : `${FILTERS[filter].label} 소스가 없어요`}/>}
    {bulk && <RemoveSourcesSheet sources={off} onClose={() => setBulk(false)}/>}
  </div>;
}

type SourceFilter = 'all' | 'on' | 'off' | 'available';
const FILTERS: Record<SourceFilter, { label: string; test: (s: VideoSource) => boolean }> = {
  all: { label: '전체', test: () => true },
  on: { label: '켜짐', test: s => s.enabled },
  off: { label: '꺼짐', test: s => s.installed && !s.enabled },
  available: { label: '설치 안 됨', test: s => !s.installed }
};

const sumImpact = (list: SourceRemovalImpact[]): SourceRemovalImpact => list.reduce((a, b) => ({ mediaCount: a.mediaCount + b.mediaCount, episodeCount: a.episodeCount + b.episodeCount, progressCount: a.progressCount + b.progressCount, watchlistCount: a.watchlistCount + b.watchlistCount, profilesAffected: Math.max(a.profilesAffected, b.profilesAffected) }), { mediaCount: 0, episodeCount: 0, progressCount: 0, watchlistCount: 0, profilesAffected: 0 });

function RemoveSourcesSheet({ sources, onClose }: { sources: VideoSource[]; onClose: () => void }) {
  const client = useQueryClient();
  const ids = sources.map(s => s.id);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [onClose]);
  const impact = useQuery({ queryKey: ['source-removal-impact', ...ids], queryFn: async () => sumImpact(await Promise.all(ids.map(id => api<SourceRemovalImpact>(`${path(id)}/removal-impact`)))), staleTime: 0 });
  const remove = useMutation({
    mutationFn: () => ids.length === 1 ? api<SourceRemovalResult>(path(ids[0]), { method: 'DELETE' }) : api<SourceRemovalResult>('/sources/remove', { method: 'POST', body: { ids } }),
    onSuccess: async () => { onClose(); for (const key of [['sources'], ['settings'], ['home'], ['watchlist'], ['history'], ['grouped-cards']]) await client.invalidateQueries({ queryKey: key }); }
  });
  const i = impact.data;
  const single = sources.length === 1;
  const lines = i ? [
    i.mediaCount ? `작품 ${i.mediaCount.toLocaleString()}개와 회차 ${i.episodeCount.toLocaleString()}개 정보` : null,
    i.progressCount ? `이어보기·시청 기록 ${i.progressCount.toLocaleString()}개` : null,
    i.watchlistCount ? `내 목록 ${i.watchlistCount.toLocaleString()}개` : null
  ].filter(Boolean) as string[] : [];
  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet remove-sheet" role="alertdialog" aria-modal="true" aria-labelledby="remove-title" onClick={e => e.stopPropagation()}>
      <header className="sheet-head"><h2 id="remove-title">{single ? `'${sources[0].name}' 삭제` : `꺼진 소스 ${sources.length}개 삭제`}</h2><IconButton label="닫기" onClick={onClose}><X size={20}/></IconButton></header>
      <div className="remove-body">
        {!single && <ul className="remove-names">{sources.slice(0, 8).map(s => <li key={s.id}>{s.name}</li>)}{sources.length > 8 && <li className="more">외 {sources.length - 8}개</li>}</ul>}
        {impact.isPending ? <p className="remove-loading"><Spinner size={16}/>함께 지워질 기록을 확인하는 중…</p>
          : impact.isError ? <p className="settings-error">영향 범위를 확인하지 못했어요. 그래도 삭제할 수 있어요.</p>
          : lines.length ? <><p>함께 지워지는 항목</p><ul className="remove-impact">{lines.map(l => <li key={l}>{l}</li>)}</ul>{i!.profilesAffected > 0 && <p className="settings-hint">프로필 {i!.profilesAffected}개의 기록이 영향을 받아요. 다른 계정의 프로필도 포함돼요.</p>}</>
          : <p className="settings-hint">이 소스로 저장된 작품이나 시청 기록이 없어요.</p>}
        <p className="settings-hint">소스 연결과 시청 기록이 지워지고, 홈 탭에서도 빠져요.  저장소에는 남아 있어 ‘설치 안 됨’에서 언제든 다시 설치할 수 있어요.</p>
        {remove.isError && <p className="settings-error" role="alert">삭제하지 못했어요. 다시 시도해 주세요.</p>}
      </div>
      <footer className="sheet-foot"><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" className="btn-destructive" disabled={remove.isPending || impact.isPending} onClick={() => remove.mutate()}>{remove.isPending ? '삭제 중…' : single ? '삭제' : `${sources.length}개 삭제`}</Button></footer>
    </div>
  </div>;
}
