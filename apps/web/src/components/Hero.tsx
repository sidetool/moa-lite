import { Info, Play, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MediaCard } from "@moa/shared";
import { Artwork, TitleLogo } from "./Artwork";
import { Button, ProgressBar, Skeleton } from "./ui";
import { TYPE_LABEL, certLabel, cx } from "../lib/format";
import { resumeTarget } from "../lib/card-meta";

const INTERVAL = 9000;

export function playPath(card: MediaCard) {
  return resumeTarget(card)?.path ?? `/play/${encodeURIComponent(card.id)}`;
}

/** Rotating featured banner. Pauses while hovered, focused or hidden. */
export function Hero({ items }: { items: MediaCard[] }) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const touch = useRef<number | null>(null);
  const count = items.length;
  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count]);

  useEffect(() => {
    if (count < 2 || paused) return;
    const timer = setTimeout(() => go(index + 1), INTERVAL);
    return () => clearTimeout(timer);
  }, [index, paused, count, go]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!count) return null;
  const card = items[index % count];
  const resume = resumeTarget(card);
  const meta = [card.year, TYPE_LABEL[card.type], ...(card.genres ?? []).slice(0, 2)].filter(Boolean);

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="추천 작품"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onTouchStart={event => { touch.current = event.touches[0].clientX; }}
      onTouchEnd={event => {
        if (touch.current === null) return;
        const dx = event.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1));
        touch.current = null;
      }}
    >
      <div className="hero-stage">
        {items.map((item, i) => (
          <div key={item.id} className={cx("hero-slide", i === index % count && "is-active")} aria-hidden={i !== index}>
            <Artwork src={item.backdrop} fallbackSrc={item.poster} title={item.title} ratio="wide" width={1600} eager={i === 0} labelFallback={false} />
          </div>
        ))}
        <div className="hero-scrim" />
      </div>

      <div className="hero-content" key={card.id}>
        <p className="hero-kicker">{card.provider.kind === "local" ? "내 라이브러리" : card.provider.name}</p>
        <TitleLogo className="hero-title" logo={card.logo} title={card.title} />
        <MetaLine card={card} meta={meta} />
        {card.overview && !resume && <p className="hero-overview">{card.overview}</p>}
        {resume && (
          <div className="hero-progress">{card.progress && <ProgressBar ratio={card.progress.ratio} />}<span>{resume.label}</span></div>
        )}
        <div className="hero-actions" data-remote-group>
          <Button variant="primary" size="l" data-remote-entry icon={<Play size={22} fill="currentColor" />} onClick={() => navigate(playPath(card))}>
            {resume?.kind === "next" ? "다음 회차 보기" : resume ? "이어보기" : "재생"}
          </Button>
          <Button variant="secondary" size="l" icon={<Info size={22} />} onClick={() => navigate(`/title/${encodeURIComponent(card.id)}`)}>
            상세 정보
          </Button>
        </div>
      </div>

      {count > 1 && (
        <div className="hero-dots" role="tablist" aria-label="추천 작품 선택" data-remote-skip>
          {items.map((item, i) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={i === index % count}
              aria-label={item.title}
              className={cx("hero-dot", i === index % count && "is-active", paused && "is-paused")}
              style={{ "--hero-interval": `${INTERVAL}ms` } as React.CSSProperties}
              onClick={() => go(i)}
            ><i /></button>
          ))}
        </div>
      )}
    </section>
  );
}

/** "★ 8.7 · 15 · 2024 · 애니 · 판타지" */
export function MetaLine({ card, meta }: { card: MediaCard; meta: Array<string | number | undefined | null | false> }) {
  const items = meta.filter(Boolean);
  const cert = certLabel(card.certification);
  if (!items.length && !card.rating && !cert) return null;
  return <p className="hero-meta">
    {card.rating ? <span className="rating"><Star size={14} fill="currentColor" aria-hidden="true" /><span className="sr-only">평점 </span>{card.rating.toFixed(1)}</span> : null}
    {cert && <span className="cert-wrap"><span className="cert" title="관람 등급">{cert}</span></span>}
    {items.map(item => <span key={String(item)}>{item}</span>)}
  </p>;
}

export function HeroSkeleton() {
  return (
    <section className="hero hero-skeleton" aria-hidden="true">
      <div className="hero-content">
        <Skeleton className="sk-text" style={{ width: 120 }} />
        <Skeleton className="sk-title" />
        <Skeleton className="sk-text" style={{ width: 220 }} />
        <div className="hero-actions"><Skeleton className="sk-btn" /><Skeleton className="sk-btn" /></div>
      </div>
    </section>
  );
}
