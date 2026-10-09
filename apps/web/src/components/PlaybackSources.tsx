import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {MediaDetail,TitleGroup} from '@moa/shared';
import {api} from '../lib/api';
import {Button,Select} from './ui';
import {clock} from '../lib/format';

export function PlaybackSources({episodeId,position,onClose,onPlay}:{episodeId:string;position:number;onClose:()=>void;onPlay:(id:string,position:number,sameEpisode:boolean)=>void}) {
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus();return()=>previous?.focus();},[]);
 const context=useQuery({queryKey:['episode-context',episodeId],queryFn:()=>api<{mediaId:string;season:number;number:number}>(`/episodes/${episodeId}/context`)});
 const group=useQuery({queryKey:['title-group',context.data?.mediaId],queryFn:()=>api<TitleGroup>(`/media/${context.data!.mediaId}/group`),enabled:!!context.data});
 const [selected,setSelected]=useState(''),[episode,setEpisode]=useState(''),[resume,setResume]=useState(true);
 const detail=useQuery({queryKey:['media',selected],queryFn:()=>api<MediaDetail>(`/media/${selected}`),enabled:!!selected,retry:false});
 const episodes=detail.data?.seasons.flatMap(s=>s.episodes)||[];
 const match=episodes.filter(e=>e.season===context.data?.season&&e.number===context.data?.number);
 const target=episode || (match.length===1?match[0].id:'');
 return <div ref={root} tabIndex={-1} onKeyDown={e=>{if(e.key!=='Tab')return;const items=[...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),input,a[href]')||[])];const first=items[0],last=items[items.length-1];if(e.shiftKey && (document.activeElement===first || document.activeElement===root.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey && (document.activeElement===last || document.activeElement===root.current)){e.preventDefault();first?.focus();}}} className="playback-source-dialog" role="dialog" aria-modal="true" aria-label="다른 소스로 재생"><div><h2>다른 소스로 재생</h2><p>소스마다 회차 구성과 영상 길이가 다를 수 있습니다. 재생할 회차를 확인해 주세요.</p>
 {context.isError || group.isError ? <p role="alert">다른 소스를 불러오지 못했습니다.</p> : <div className="source-directory-links">{group.data?.members.filter(m=>m.id!==context.data?.mediaId).map(m=><Button key={m.id} aria-pressed={selected===m.id} onClick={()=>{setSelected(m.id);setEpisode('');}}>{m.provider.name}</Button>)}</div>}
 {group.data && group.data.members.length<2 && <p>연결된 다른 소스가 없습니다. 작품 상세에서 같은 작품을 묶어 주세요.</p>}
 {selected && (detail.isPending?<p>회차를 불러오는 중…</p>:detail.isError?<p role="alert">이 소스의 회차를 불러오지 못했습니다. <Button onClick={()=>void detail.refetch()}>다시 시도</Button></p>:<label className="field">재생할 회차<Select aria-label="다른 소스의 회차" value={target} onChange={setEpisode} options={[{value:'',label:'회차를 선택하세요'},...episodes.map(e=>({value:e.id,label:`시즌 ${e.season} · ${e.number}화 · ${e.title}`}))]} /></label>)}
 {position>0 && <label className="source-choice"><input type="checkbox" checked={resume} onChange={e=>setResume(e.target.checked)}/> 현재 위치 {clock(position)}부터 이어보기</label>}
 <div className="hero-actions"><Button variant="primary" disabled={!target || !episodes.some(e=>e.id===target)} onClick={()=>onPlay(target,resume?position:0,match.some(e=>e.id===target))}>이 회차로 재생</Button><Button onClick={onClose}>닫기</Button></div></div></div>;
}
