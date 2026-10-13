import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlaybackMarkers } from '../../web/src/player/skip-markers.js';
test('duration refinements retain previously known intervals without mixing endpoints', () => {
  const op={introStart:20,introEnd:110,source:'aniskip' as const};
  const ed={creditsStart:1300,creditsEnd:1390,source:'aniskip' as const};
  const merged=mergePlaybackMarkers(ed,op)!;
  assert.equal(merged.introStart,20);assert.equal(merged.introEnd,110);assert.equal(merged.creditsStart,1300);
  assert.equal(mergePlaybackMarkers(undefined,merged),merged);
  assert.equal(mergePlaybackMarkers({introStart:50},merged)?.introStart,20);
});
