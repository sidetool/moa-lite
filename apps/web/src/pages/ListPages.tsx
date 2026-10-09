import type { HistoryEntry, Settings } from '@moa/shared';
import { GroupedSearch } from '../components/GroupedFeed';
import { hasLoginGate } from "../lib/api";
import { Bookmark, ChevronRight, FolderOpen, History, LogOut, Search as SearchIcon, Settings as SettingsIcon, Trash2, Users, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSources } from "./SourcesPage";
import { keys, useHistory, useMe, useProfiles, useSearch, useSettings, useWatchlist } from "../api/queries";
import { PosterCard } from "../components/Cards";
import { Avatar } from "../components/AppShell";
import { logout } from "./AccountsPage";
import { Artwork } from "../components/Artwork";
import { Button, ConfirmDialog, EmptyState, ProgressBar, Skeleton, Toggle } from "../components/ui";
import { api, currentProfileId, setCurrentProfileId } from "../lib/api";
import { clock } from "../lib/format";
import { settledQuery, useSettledQuery } from "../lib/search-input";

function GridSkeleton({ count = 12 }: { count?: number }) {
  return <div className="grid" aria-hidden="true">{Array.from({ length: count }, (_, i) => <div key={i} className="card poster-card"><Skeleton className="art art-poster" /><Skeleton className="sk-text" style={{ width: "70%", marginTop: 10 }} /></div>)}</div>;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [value, setValue] = useState(q);
  const result = useSearch(q);
  const sources = useSources();
  const installed = sources.data?.filter(s => s.enabled) || [];
  const input = useRef<HTMLInputElement>(null);

  // Mobile has no search box in the header; this one mirrors the URL (without eating a space being typed).
  useEffect(() => { setValue(value => settledQuery(value) === q ? value : q); }, [q]);
  const commit = (query: string) => setParams(query ? { q: query } : {}, { replace: true });
  useSettledQuery(value, q, commit);

  const groups = result.data?.groups.filter(group => group.items.length || group.error) ?? [];
  return (
    <div className="page-pad search-page">
      <div className="searchbox searchbox-page">
        <SearchIcon size={20} aria-hidden="true" />
        <input ref={input} type="search" value={value} placeholder="제목, 장르 검색" aria-label="검색" onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { const query = settledQuery(event.currentTarget.value); if (query !== q) commit(query); } }} />
        {value && <button className="searchbox-clear" aria-label="지우기" onClick={() => { setValue(""); commit(""); input.current?.focus(); }}><X size={18} /></button>}
      </div>
      {!q && <EmptyState icon={<SearchIcon size={40} />} title="무엇을 볼까요?" body="내 라이브러리와 설치된 소스에서 한 번에 찾습니다." />}
      {q && result.isSuccess && !groups.length && !installed.length && <EmptyState title={`'${q}'에 대한 결과가 없습니다`} body="다른 제목이나 원제로 검색해 보세요." />}
      {q && <GroupedSearch key={q} sources={installed} query={q} local={groups.flatMap(g=>g.items)} pending={result.isPending || sources.isPending}/>}

    </div>
  );
}

export function MyListPage() {
  const list = useWatchlist();
  const navigate = useNavigate();
  return (
    <div className="page-pad">
      <header className="page-head"><h1>내 목록</h1></header>
      {list.isPending && <GridSkeleton />}
      {list.data?.length === 0 && <EmptyState icon={<Bookmark size={40} />} title="아직 담은 작품이 없습니다" body="작품 상세 화면에서 '내 목록'을 누르면 여기에 모입니다." action={<Button variant="primary" onClick={() => navigate("/")}>둘러보기</Button>} />}
      {!!list.data?.length && <div className="grid">{list.data.map(card => <PosterCard key={card.id} card={card} />)}</div>}
    </div>
  );
}

export function HistoryPage() {
  const history = useHistory();
  const settings = useSettings();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // A grouped entry stands for the whole title, so deleting it clears every episode's record.
  const remove = async (entry: HistoryEntry) => {
    setBusy(true); setError("");
    try {
      const grouped = entry.groupedCount !== undefined;
      await api(grouped ? `/history/media/${encodeURIComponent(entry.media.id)}` : `/history/${encodeURIComponent(entry.episode.id)}`, { method: "DELETE" });
      setConfirm(null);
      void client.invalidateQueries({ queryKey: keys.history });
      void client.invalidateQueries({ queryKey: ["home"] });
    } catch {
      setError("기록을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally { setBusy(false); }
  };
  const grouping = settings.data?.groupHistory ?? true;
  // One save at a time: the switch stays disabled until the server answers, so toggles cannot race.
  const setGrouping = async (groupHistory: boolean) => {
    setSaving(true); setError("");
    client.setQueryData<Settings>(keys.settings, old => (old ? { ...old, groupHistory } : old));
    try { client.setQueryData(keys.settings, await api<Settings>("/settings", { method: "PATCH", body: { groupHistory } })); }
    catch { setError("설정을 저장하지 못했어요."); await client.invalidateQueries({ queryKey: keys.settings }); }
    finally { setSaving(false); }
    void client.invalidateQueries({ queryKey: keys.history });
  };
  const items = history.data?.items ?? [];
  return (
    <div className="page-pad">
      <header className="page-head page-head-row">
        <h1>시청 기록</h1>
        {settings.data && <label className="history-grouping"><span>작품별로 보기</span><Toggle label="작품별로 보기" checked={grouping} disabled={saving} onChange={value => void setGrouping(value)} /></label>}
      </header>
      {error && !confirm && <p className="history-error" role="alert">{error}</p>}
      {history.isPending && <div className="history-list">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="history-sk" />)}</div>}
      {history.isSuccess && !items.length && <EmptyState icon={<History size={40} />} title="시청 기록이 없습니다" />}
      <ul className="history-list">
        {items.map(entry => {
          const p = entry.episode.progress;
          const count = entry.groupedCount;
          const episodes = count !== undefined && count > 1 ? `${count}개 회차` : null;
          return (
            <li key={count !== undefined ? `media:${entry.media.id}` : entry.episode.id} className="history-item">
              <Link to={`/watch/${encodeURIComponent(entry.episode.id)}`} className="history-thumb" aria-label={`${entry.media.title} ${entry.media.type === "movie" ? "" : entry.episode.title} 재생`}>
                <Artwork src={entry.episode.thumb ?? entry.media.backdrop} title={entry.media.title} ratio="landscape" width={320} labelFallback={false} />
                {p && <ProgressBar ratio={p.completed ? 1 : p.position / Math.max(1, p.duration)} className="card-progress" />}
              </Link>
              <Link to={`/title/${encodeURIComponent(entry.media.id)}`} className="history-body">
                <b>{entry.media.title}</b>
                <span>{entry.media.type === "movie" ? "" : `${count !== undefined ? "최근 " : ""}${entry.episode.title} · `}{p?.completed ? "시청 완료" : p ? `${clock(p.position)} / ${clock(p.duration)}` : ""}</span>
                <small>{[new Date(entry.watchedAt).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }), episodes].filter(Boolean).join(" · ")}</small>
              </Link>
              {count !== undefined
                ? <button className="icon-btn" aria-label={`${entry.media.title} 작품 기록 모두 삭제`} title="작품 기록 모두 삭제" disabled={busy} onClick={() => { setError(""); if (count > 1) setConfirm(entry); else void remove(entry); }}><Trash2 size={18} /></button>
                : <button className="icon-btn" aria-label="기록에서 삭제" title="기록에서 삭제" disabled={busy} onClick={() => void remove(entry)}><X size={18} /></button>}
            </li>
          );
        })}
      </ul>
      {confirm && <ConfirmDialog title="작품 기록을 모두 삭제할까요?" confirmLabel="모두 삭제" busy={busy} onConfirm={() => void remove(confirm)} onClose={() => { setConfirm(null); setError(""); }}>
        <p>‘{confirm.media.title}’의 {confirm.groupedCount}개 회차 기록과 이어볼 위치가 모두 지워져요.</p>
        {error && <p className="history-error" role="alert">{error}</p>}
      </ConfirmDialog>}
    </div>
  );
}

/** Mobile "마이" tab: profile, shortcuts to history / library / settings. */
export function MePage() {
  const profiles = useProfiles();
  const navigate = useNavigate();
  const profile = profiles.data?.find(item => item.id === currentProfileId());
  const me = useMe();
  const admin = me.data?.role === "admin";
  const link = (to: string, icon: React.ReactNode, label: string) => (
    <Link to={to} className="me-link">{icon}<span>{label}</span><ChevronRight size={18} /></Link>
  );
  return (
    <div className="page-pad me-page">
      <div className="me-head"><Avatar profile={profile} size={64} /><div><b>{profile?.name}</b><button className="text-btn" onClick={() => { setCurrentProfileId(null); navigate("/profiles"); }}><UsersRound size={14} />프로필 전환</button></div></div>
      <nav className="me-links">
        {link("/history", <History size={20} />, "시청 기록")}
        {link("/my-list", <Bookmark size={20} />, "내 목록")}
        {admin && link("/sources", <FolderOpen size={20} />, "영상 소스")}
        {admin && link("/library", <FolderOpen size={20} />, "라이브러리 관리")}
        {admin && hasLoginGate && link("/accounts", <Users size={20} />, "계정과 초대")}
        {link("/settings", <SettingsIcon size={20} />, "설정")}
        {hasLoginGate && <button className="me-link" onClick={() => void logout()}><LogOut size={20} /><span>로그아웃{me.data && <small> · {me.data.username}</small>}</span><ChevronRight size={18} /></button>}
      </nav>
    </div>
  );
}
