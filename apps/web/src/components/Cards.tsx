import { Info, Play } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { MediaCard } from "@moa/shared";
import { Artwork } from "./Artwork";
import { ProgressBar, Skeleton } from "./ui";
import { TYPE_LABEL, cx } from "../lib/format";
import { foreignLang, resumeTarget, seasonInfo } from "../lib/card-meta";

function metaLine(card: MediaCard) {
  return [card.rating ? `★ ${card.rating.toFixed(1)}` : null, card.year, TYPE_LABEL[card.type], card.episodeCount && card.type !== "movie" ? `${card.episodeCount}화` : null].filter(Boolean).join(" · ");
}

export function PosterCard({ card, eager }: { card: MediaCard; eager?: boolean }) {
  const lang = foreignLang(card), season = seasonInfo(card);
  return (
    <Link to={`/title/${encodeURIComponent(card.id)}`} className="card poster-card" aria-label={card.title}>
      <div className="card-frame">
        <Artwork src={card.poster} fallbackSrc={card.backdrop} title={card.title} ratio="poster" width={342} eager={eager} />
        {(card.badge || (card.sourceCount || 0) > 1) && <span className="card-badge">{card.badge || `소스 ${card.sourceCount}개`}</span>}
        {lang && <span className="card-lang" title="해외 소스">{lang.toUpperCase()}</span>}
        {card.progress && <ProgressBar ratio={card.progress.ratio} className="card-progress" />}
        <div className="card-hover" aria-hidden="true">
          <span className="card-hover-meta">{metaLine(card)}</span>
        </div>
      </div>
      <span className="card-title">{card.title}</span>
      {/* Subtitled is the default; only dubs are called out. */}
      {(season || card.audio === "dub") && <span className="card-season">{[season?.label, card.audio === "dub" && "더빙"].filter(Boolean).join(" · ")}</span>}
    </Link>
  );
}

/** TOP 10 card: an outlined rank numeral tucked behind the poster. */
export function RankCard({ card, rank, eager }: { card: MediaCard; rank: number; eager?: boolean }) {
  return (
    <Link to={`/title/${encodeURIComponent(card.id)}`} className="card rank-card" aria-label={`${rank}위 ${card.title}`}>
      <span className="rank-num" aria-hidden="true">{rank}</span>
      <div className="card-frame">
        <Artwork src={card.poster} fallbackSrc={card.backdrop} title={card.title} ratio="poster" width={342} eager={eager} />
        {(card.sourceCount || 0) > 1 && <span className="card-badge">소스 {card.sourceCount}개</span>}
      </div>
      <span className="card-title" title={card.title}>{card.title}</span>
    </Link>
  );
}

/** 16:9 card for "continue watching": one tap resumes, or starts the next episode after a finished one. */
export function LandscapeCard({ card, eager }: { card: MediaCard; eager?: boolean }) {
  const navigate = useNavigate();
  const resume = resumeTarget(card);
  const action = resume?.kind === "next" ? "다음 회차 보기" : resume ? "이어보기" : "";
  return (
    <div className={cx("card landscape-card", card.badge === "LIVE" && "live-card")}>
      <Link to={resume?.path ?? `/title/${encodeURIComponent(card.id)}`} className="card-frame" aria-label={[card.title, resume?.label, action].filter(Boolean).join(" · ")}>
        <Artwork src={card.backdrop} fallbackSrc={card.poster} title={card.title} ratio="landscape" width={640} eager={eager} labelFallback={!card.backdrop} />
        {card.badge === "LIVE" && <span className="card-badge">LIVE</span>}
        <span className="card-play" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
        {/* The server sends progress only for real unfinished viewing, never for an unseen next episode. */}
        {card.progress && <ProgressBar ratio={card.progress.ratio} className="card-progress" />}
      </Link>
      <div className="landscape-meta">
        <div>
          <span className="card-title">{card.title}</span>
          {resume && <span className="card-sub">{resume.label}</span>}
        </div>
        <button className="icon-btn icon-btn-s" data-remote-secondary aria-label={`${card.title} 상세 정보`} title="상세 정보" onClick={() => navigate(`/title/${encodeURIComponent(card.id)}`)}>
          <Info size={18} />
        </button>
      </div>
    </div>
  );
}

export function CardSkeleton({ layout }: { layout: "poster" | "landscape" }) {
  return (
    <div className={cx("card", layout === "poster" ? "poster-card" : "landscape-card")} aria-hidden="true">
      <Skeleton className={cx("art", layout === "poster" ? "art-poster" : "art-landscape")} />
      <Skeleton className="sk-text" style={{ width: "70%", marginTop: 10 }} />
    </div>
  );
}
