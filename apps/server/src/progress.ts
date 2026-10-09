import type { Episode, EpisodeProgress, MediaDetail, ProgressSummary, ResumeTarget } from '@moa/shared';

export function completion(position: number, duration: number) {
  return duration > 0 && (position >= duration * .9 || duration - position < 120);
}
const episodeOrder = (a: Episode, b: Episode) => a.season - b.season || a.number - b.number || a.id.localeCompare(b.id);

/** Latest real viewing activity is authoritative, including completed episodes. */
export function continueTarget(episodes: Episode[], movie = false): ResumeTarget | null {
  const sorted = [...episodes].sort(episodeOrder);
  const latest = sorted.filter(e => e.progress && (e.progress.position > 0 || e.progress.completed))
    .sort((a,b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt) || episodeOrder(b,a))[0];
  if (!latest) return null;
  if (!latest.progress!.completed) return {
    episodeId: latest.id, position: latest.progress!.position, kind: 'resume',
    label: movie ? '이어보기' : `이어보기 S${latest.season}:E${latest.number}`,
  };
  if (movie) return null;
  const next = sorted.slice(sorted.indexOf(latest) + 1).find(e => !e.progress?.completed);
  return next ? { episodeId: next.id, position: next.progress?.position || 0, kind: 'next',
    label: `다음 회차 S${next.season}:E${next.number}` } : null;
}
export function playTarget(episodes: Episode[], movie = false): MediaDetail['playTarget'] {
  const sorted = [...episodes].sort(episodeOrder);
  if (!sorted.length) return null;
  const target = continueTarget(sorted, movie);
  if (target) return { episodeId: target.episodeId, position: target.position, label: target.label };
  const unseen = sorted.find(e => !e.progress?.completed);
  return { episodeId: (unseen || sorted[0]).id, position: 0, label: unseen ? '재생' : '다시 보기' };
}
export function summary(ep: Episode, progress: EpisodeProgress, movie: boolean): ProgressSummary {
  const remaining = Math.max(0, Math.ceil((progress.duration - progress.position) / 60));
  return { episodeId: ep.id, ratio: progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0,
    label: `${movie ? '' : `S${ep.season}:E${ep.number} · `}${remaining}분 남음` };
}
