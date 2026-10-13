import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { BrowseSchema, BrowseSelection, FilterChange, FilterValue, SourceFilter } from '@moa/shared';
import { api } from '../lib/api';
import { Button, Select } from './ui';

export const useSourceFilters = (id: string) => useQuery({ queryKey:['source-filters',id], queryFn:({signal}) => api<BrowseSchema>(`/sources/${encodeURIComponent(id)}/filters`,{signal}), enabled:!!id, staleTime:60_000,retry:false });
export function SourceFilters({ schema, value, onChange, actions }: {schema:BrowseSchema;value?:BrowseSelection;onChange:(v:BrowseSelection|undefined)=>void;actions?:ReactNode}) {
  const stale = !!value && value.revision !== schema.revision;
  const changes = stale ? [] : value?.filters || [];
  const set = (position:number, groupPosition:number|undefined, value:FilterValue) => {
    const next:FilterChange[] = [...changes.filter(c => c.position !== position || c.groupPosition !== groupPosition),{position,...(groupPosition === undefined ? {} : {groupPosition}),value}];
    onChange({revision:schema.revision,filters:next});
  };
  const inputs = schema.filters.filter(f => !['header','separator'].includes(f.kind));
  const groups: SourceFilter[][] = [];
  for (const filter of schema.filters) {
    if (!['header','separator'].includes(filter.kind) && /탭 저장|Popular\/Latest 규칙/.test(filter.label)) continue;
    const previous = groups.at(-1);
    if (filter.kind === 'checkbox' && previous?.[0].kind === 'checkbox') previous.push(filter);
    else groups.push([filter]);
  }
  const controls = <div className="filter-actions"><Button type="button" variant="ghost" disabled={!value} onClick={() => onChange(undefined)}>초기화</Button>{actions}</div>;
  if (!inputs.length) return <><p className="source-muted">이 소스는 추가 필터를 제공하지 않습니다.</p>{(value || actions) && controls}</>;
  return <div className="source-filter-fields">
    {stale && <p role="alert">소스의 필터가 변경되었습니다. 조건을 다시 선택해 주세요.</p>}
    {groups.map(group => {
      const f = group[0];
      if (f.kind === 'separator') return <hr key={f.id}/>;
      if (f.kind === 'header' && (/^현재 (Popular|Latest):/.test(f.label) || /카드는 Popular|Popular\/Latest 탭 규칙/.test(f.label))) return null;
      if (f.kind === 'header') return <p className="filter-heading" key={f.id}>{f.label}</p>;
      const v = changes.find(c => c.position === f.position && c.groupPosition === f.groupPosition)?.value ?? f.defaultValue;
      const change = (v:FilterValue) => set(f.position,f.groupPosition,v);
      const sort = typeof v === 'object' ? v : {index:0,ascending:false};
      if (f.kind === 'checkbox') return <div className="filter-checklist" key={f.id}>{group.map(filter => <label className="filter-checkbox" key={filter.id}><input className="selection-checkbox" aria-label={filter.label} type="checkbox" checked={Boolean(changes.find(c => c.position === filter.position && c.groupPosition === filter.groupPosition)?.value ?? filter.defaultValue)} onChange={e => set(filter.position, filter.groupPosition, e.target.checked)} /><span>{filter.label}</span></label>)}</div>;
      return <div className="field filter-field" key={f.id}><span>{f.label}</span>
        {f.kind === 'select' || f.kind === 'sort' ? <div className="filter-selects"><Select aria-label={f.label} value={String(f.kind === 'sort' ? sort.index : Number(v ?? 0))} onChange={value => change(f.kind === 'sort' ? {...sort,index:Number(value)} : Number(value))} options={(f.options ?? []).map((label, index) => ({value:String(index),label}))} />{f.kind === 'sort' && <Select aria-label={`${f.label} 방향`} value={String(sort.ascending)} onChange={value => change({...sort,ascending:value === 'true'})} options={[{value:'false',label:'내림차순'},{value:'true',label:'오름차순'}]} />}</div> : f.kind === 'tri_state' ? <Select aria-label={f.label} value={String(v || 'IGNORE')} onChange={change} options={[{value:'IGNORE',label:'상관없음'},{value:'INCLUDE',label:'포함'},{value:'EXCLUDE',label:'제외'}]} /> : <input aria-label={f.label} value={String(v ?? '')} maxLength={2000} onChange={e => change(e.target.value)}/>}
      </div>;
    })}
    {controls}
  </div>;
}
export function TabSourceFilters({id,value,onChange}:{id:string;value?:BrowseSelection;onChange:(v:BrowseSelection|undefined)=>void}) {
  const schema = useSourceFilters(id);
  return schema.isPending ? <p>필터 불러오는 중…</p> : schema.data ? <SourceFilters schema={schema.data} value={value} onChange={onChange}/> : <p role="alert">필터를 불러오지 못했습니다. <button type="button" className="text-btn" onClick={() => void schema.refetch()}>다시 시도</button></p>;
}
