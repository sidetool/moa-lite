import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Episode } from '@moa/shared';
import { parseName, matchSubtitles } from '../src/filename.js';
import { completion, continueTarget, playTarget, summary } from '../src/progress.js';
import { safePath, normalize } from '../src/util.js';
import { playbackMode } from '../src/playback.js';
import { smiToVtt } from '../src/subtitles.js';
import type { Probe } from '../src/probe.js';

test('parse synthetic release filenames and Korean/movie patterns', () => {
  const cases: [string, ReturnType<typeof parseName>][] = [
    ['[FixtureGroup] Example TV S2 - 01 (BS11 1920x1080 x265 AAC).mkv', { title: 'Example TV', season: 2, episode: 1 }],
    ['[FixtureGroup] Example TV S2 - 13 END (AT-X 1920x1080 x265 AAC).mkv', { title: 'Example TV', season: 2, episode: 13 }],
    ['Example.Film.2016.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265.mkv', { title: 'Example Film', season: 1, year: 2016 }],
    ['Show.S01E03.mkv', { title: 'Show', season: 1, episode: 3 }],
    ['Show - 03.mkv', { title: 'Show', season: 1, episode: 3 }],
    ['제목 3화.mkv', { title: '제목', season: 1, episode: 3 }],
    ['제목3화.mkv', { title: '제목', season: 1, episode: 3 }],
    ['제목 (2024).mkv', { title: '제목', season: 1, year: 2024 }],
  ];
  for (const [name, expected] of cases) assert.deepEqual(parseName(name), expected, name);
  assert.deepEqual(parseName('Example TV - 03.mkv', '[FixtureGroup] Example TV S2 (1080p)'), { title: 'Example TV', season: 2, episode: 3 });
  assert.deepEqual(parseName('03.mkv', '[FixtureGroup] Example TV S2 (1080p)'), { title: 'Example TV', season: 2, episode: 3 });
});
test('subtitle matching ignores broadcaster but keeps episode, season, and title boundaries', () => {
  const video = '/anime/[FixtureGroup] Example TV S2 - 03 (AT-X 1920x1080 x265 AAC).mkv';
  const right = '/anime/[FixtureGroup] Example TV S2 - 03 (BS11 1920x1080 x265 AAC).ass';
  assert.deepEqual(matchSubtitles(video, [right, right.replace(' - 03', ' - 04'), right.replace('S2', 'S1'), right.replace('Example TV', 'Other')]), [right]);
  assert.deepEqual(matchSubtitles('/movies/Film.mkv', ['/movies/Film.ko.srt', '/movies/Film.en.vtt', '/movies/Other.srt']), ['/movies/Film.ko.srt', '/movies/Film.en.vtt']);
});
test('completion threshold is 90 percent or strictly less than 120 seconds', () => {
  assert.equal(completion(1800, 2000), true);
  assert.equal(completion(1799, 2000), false);
  assert.equal(completion(881, 1000), true);
  assert.equal(completion(880, 1000), false);
  assert.equal(completion(0, 0), false);
});
const ep = (number: number, position?: number, completed = false, updatedAt = '2026-10-02T00:00:00Z'): Episode => ({ id: `ep${number}`, mediaId: 'show', season: 2, number, title: `${number}화`, ...(position === undefined ? {} : { progress: { position, duration: 1400, completed, updatedAt } }) });
test('play target resumes latest unfinished episode, advances, and replays completed series', () => {
  assert.deepEqual(playTarget([]), null);
  assert.deepEqual(playTarget([ep(2), ep(1)]), { episodeId: 'ep1', position: 0, label: '재생' });
  assert.deepEqual(playTarget([ep(1, 500), ep(3, 680, false, '2026-10-03T00:00:00Z')]), { episodeId: 'ep3', position: 680, label: '이어보기 S2:E3' });
  assert.deepEqual(playTarget([ep(1, 1400, true), ep(2)]), { episodeId: 'ep2', position: 0, label: '다음 회차 S2:E2' });
  assert.deepEqual(playTarget([ep(1), ep(2, 1400, true), ep(3)]), { episodeId: 'ep3', position: 0, label: '다음 회차 S2:E3' });
  assert.deepEqual(playTarget([ep(1, 1400, true), ep(2, 1400, true)]), { episodeId: 'ep1', position: 0, label: '다시 보기' });
  assert.equal(playTarget([ep(1, 200)], true)?.label, '이어보기');
  assert.equal(summary(ep(3), { position: 680, duration: 1400, completed: false, updatedAt: '' }, false).label, 'S2:E3 · 12분 남음');
  assert.equal(summary(ep(1), { position: 0, duration: 2280, completed: false, updatedAt: '' }, true).label, '38분 남음');
});
test('path protection blocks traversal, prefix siblings, and symlink escape', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'moa-path-'));
  try {
    const root = path.join(temp, 'media'), outside = path.join(temp, 'media-other');
    await mkdir(root); await mkdir(outside); await mkdir(path.join(root, 'show'));
    await symlink(outside, path.join(root, 'escape')); await symlink(path.join(root, 'show'), path.join(root, 'inside'));
    await writeFile(path.join(root, 'show', 'test.mkv'), 'video');
    assert.equal(await safePath(root, 'show', true), path.join(root, 'show'));
    assert.equal(await safePath(root, 'inside', true), path.join(root, 'show'));
    for (const bad of ['../media-other', outside, 'escape']) await assert.rejects(() => safePath(root, bad, true), { error: 'path-outside-media-root' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('playback decisions honor codecs, audio compatibility, height and selected track', () => {
  const p: Probe = { duration: 1200, container: 'matroska', streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'aac' }, { index: 2, codec_type: 'audio', codec_name: 'ac3' }] };
  const caps = { h264: true, hevc: false, av1: false };
  assert.equal(playbackMode('test.mkv', p, caps, p.streams[1]), 'transcode');
  assert.equal(playbackMode('test.mkv', p, { ...caps, hevc: true }, p.streams[1]), 'remux');
  assert.equal(playbackMode('test.mp4', p, { ...caps, hevc: true }, p.streams[1]), 'direct');
  assert.equal(playbackMode('test.mp4', p, { ...caps, hevc: true, maxHeight: 720 }, p.streams[1]), 'transcode');
  assert.equal(playbackMode('test.mp4', p, { ...caps, hevc: true }, p.streams[2]), 'remux');
  const selected = { ...p.streams[2], index: 1 };
  assert.equal(playbackMode('test.mp4', p, { ...caps, hevc: true, audioCodecs: ['ac3'] }, selected), 'direct');
  assert.equal(playbackMode('test.mp4', p, { ...caps, hevc: true, audioCodecs: ['aac'] }, selected), 'remux');
  const vp9: Probe = { ...p, streams: [{ ...p.streams[0], codec_name: 'vp9' }, { ...p.streams[1], codec_name: 'opus' }] };
  assert.equal(playbackMode('test.webm', vp9, { ...caps, vp9: true, audioCodecs: ['opus'] }, vp9.streams[1]), 'direct');
  assert.equal(playbackMode('test.webm', vp9, { ...caps, vp9: false }, vp9.streams[1]), 'transcode');
  assert.equal(playbackMode('test.mkv', vp9, { ...caps, vp9: true, audioCodecs: ['opus'] }, vp9.streams[1]), 'remux');
});
test('search normalization preserves Hangul and removes separators/width differences', () => {
  assert.equal(normalize('ＥＸＡＭＰＬＥ.TV'), normalize('example tv'));
  assert.equal(normalize('구름 정원'), normalize('구름정원'));
});
test('SMI conversion retains line breaks and timed empty clearing cues', () => {
  assert.equal(smiToVtt('<SYNC Start=1000><P>안녕<br>세계<SYNC Start=2300><P>&nbsp;'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.300\n안녕\n세계\n');
});

test('continue target follows latest activity, crosses seasons, never invents history', () => {
  const older = ep(1, 200, false, '2026-10-01');
  const last = ep(2, 1350, true, '2026-10-02');
  const next = { ...ep(1), id: 's3e1', season: 3 };
  const episodes = [next, last, older];
  const before = JSON.stringify(episodes);
  assert.deepEqual(continueTarget(episodes), {episodeId:'s3e1',position:0,kind:'next',label:'다음 회차 S3:E1'});
  assert.equal(JSON.stringify(episodes), before);
  assert.equal(continueTarget([last, older]), null, 'old unfinished episodes do not override latest completion');
  assert.equal(continueTarget([last],true), null);
  assert.equal(continueTarget([ep(1)]), null);
  const rewatch = ep(1,100,false,'2026-10-03');
  assert.equal(continueTarget([rewatch,last,next])?.episodeId,rewatch.id);
});
