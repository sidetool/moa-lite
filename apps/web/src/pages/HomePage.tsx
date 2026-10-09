import { TabFeed, useTabFeed } from '../components/GroupedFeed';
import { Settings2 } from "lucide-react";
import { Link, NavLink, useParams, useSearchParams } from "react-router-dom";
import type { MediaType } from "@moa/shared";
import { useHome, useMe, useMediaList } from "../api/queries";
import { Hero, HeroSkeleton } from "../components/Hero";
import { Row, RowSkeleton } from "../components/Row";
import { PosterCard } from "../components/Cards";
import { Button, ButtonLink, EmptyState } from "../components/ui";
import { TYPE_LABEL, cx } from "../lib/format";
import { useNavigation, tabPath } from "../lib/navigation";

export function HomePage({ localOnly = false }: { localOnly?: boolean }) {
  const admin = useMe().data?.role === "admin";
  const { tabId = 'home' } = useParams();
  const [params] = useSearchParams();
  const { tabs, sources, pending, error } = useNavigation();
  const tab = localOnly ? { id: 'local', name: '로컬 라이브러리', sourceIds: [], includeLocal: true } : tabs.find(t => t.id === tabId);
  const installed = sources.filter(s => s.enabled && tab?.sourceIds.includes(s.id)).sort((a, b) => tab!.sourceIds.indexOf(a.id) - tab!.sourceIds.indexOf(b.id));
  const providers = [...installed.map(s => s.id), ...(tab?.includeLocal ? ['local'] : [])];
  const type = localOnly && ['movie', 'series', 'anime'].includes(params.get('type') || '') ? params.get('type') as MediaType : undefined;
  const home = useHome(type, providers, !localOnly && tabId === "home" ? "all" : "tab");
  const feed = useTabFeed(installed, tab);
  // Prefer wide artwork for the banner; posters only fill in when needed.
  const heroPool = installed.length ? [...feed.cards.filter(c => c.backdrop), ...feed.cards.filter(c => !c.backdrop && c.poster)] : home.data?.hero ?? [];
  const hero = [...(home.data?.hero ?? []).filter(c => c.progress || c.resume), ...heroPool].filter((c, i, all) => all.findIndex(o => o.id === c.id) === i).slice(0, 6);
  const rows = home.data?.rows.filter(row => row.items.length > 0) ?? [];
  const heroPending = pending || (installed.length ? feed.pending : home.isPending);
  return <div className="home">
    <div className="section-chips no-scrollbar" aria-label="콘텐츠 탭">
      {tabs.map(t => <NavLink key={t.id} to={tabPath(t.id)} end className={({ isActive }) => cx('chip', isActive && 'is-active')}>{t.name}</NavLink>)}
    </div>
    {heroPending ? <HeroSkeleton /> : <Hero key={tab?.id} items={hero} />}
    <div className={cx('rows', !heroPending && !hero.length && 'rows-no-hero')}>
      {pending ? <><RowSkeleton /><RowSkeleton /></> : !tab ? <EmptyState title="삭제되었거나 없는 탭입니다" action={<ButtonLink to="/">홈으로</ButtonLink>} /> : <>
        {error && <EmptyState title="구성을 불러오지 못했습니다" action={<Button onClick={() => location.reload()}>다시 시도</Button>} />}
        {!providers.length && !rows.length && !home.isPending && !error && <EmptyState icon={<Settings2 size={40} />} title="이 탭에 표시할 소스가 없어요" body="영상 소스나 로컬 라이브러리를 이 탭에 연결해 주세요." action={<ButtonLink variant="primary" to={`/settings/tabs?edit=${encodeURIComponent(tab.id)}`}>탭 편집</ButtonLink>} />}
        {rows.map((row, i) => <Row key={row.id} row={row} index={i} />)}
        {!!installed.length && <TabFeed feed={feed} startIndex={rows.length} />}
        {tab.includeLocal && !installed.length && !home.isPending && !home.isError && !rows.length && <EmptyState title="로컬 라이브러리가 비어 있어요" body={admin ? "영상 폴더를 추가하면 자동으로 정리해 줍니다." : "관리자가 영상 폴더를 추가하면 여기에 보여요."} action={admin ? <ButtonLink variant="primary" to="/library">영상 폴더 추가</ButtonLink> : undefined} />}
        {admin && tab.includeLocal && rows.length > 0 && <p className="feed-note"><Link to="/library">로컬 영상 폴더 관리</Link></p>}
        {home.isError && tab.includeLocal && <p className="feed-note">로컬 라이브러리를 불러오지 못했어요. <button className="text-btn" onClick={() => void home.refetch()}>다시 시도</button></p>}
      </>}
    </div>
  </div>;
}

export function GenrePage({ type, genre }: { type?: MediaType; genre: string }) {
  const list = useMediaList({ type, genre, provider: "local" });
  return (
    <div className="page-pad">
      <header className="page-head"><p className="page-kicker">{type ? TYPE_LABEL[type] : "로컬 라이브러리"}</p><h1>{genre}</h1></header>
      <div className="grid">
        {list.data?.items.map(card => <PosterCard key={card.id} card={card} />)}
      </div>
    </div>
  );
}
