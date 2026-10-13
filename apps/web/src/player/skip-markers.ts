import type { PlaybackSession } from '@moa/shared';
type Markers = PlaybackSession['markers'];
/** Keep each interval's boundaries together, with this file's own markers preferred. */
export function mergePlaybackMarkers(preferred: Markers, fallback: Markers): Markers {
  if(!preferred)return fallback;if(!fallback)return preferred;
  const intro=preferred.introStart!==undefined&&preferred.introEnd!==undefined?preferred:fallback;
  const credits=preferred.creditsStart!==undefined?preferred:fallback;
  return {source:preferred.source??fallback.source,
    ...(intro.introStart!==undefined&&intro.introEnd!==undefined?{introStart:intro.introStart,introEnd:intro.introEnd}:{}),
    ...(credits.creditsStart!==undefined?{creditsStart:credits.creditsStart,...(credits.creditsEnd!==undefined?{creditsEnd:credits.creditsEnd}:{})}:{}),
    provenance:{intro:intro.provenance?.intro??intro.source,credits:credits.provenance?.credits??credits.source},
  };
}
