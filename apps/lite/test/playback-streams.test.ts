import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directVideoUrl, selectPlaybackStream } from '../client/playback-streams.js';

const url = 'https://example.org/video.m3u8';
const quote = (value: string) => `%${Buffer.byteLength(value)}%${value}`;
const separate = `edl://!delay_open,media_type=video;${quote(url)};!new_stream;!delay_open,media_type=audio;https://example.org/audio.m3u8`;
const code = (expected: string) => (error: any) => error.error === expected;

test('default chooses first playable stream and keeps original IDs and metadata', () => {
  const headers = { Referer: 'https://example.org/' };
  const subtitles = [{ file: 'https://example.org/sub.vtt' }];
  const videos = [{ url: separate }, { url: 'http://example.org/old.mp4' }, { url, headers, subtitles, quality: 'HD' }, { url: 'https://example.org/other.mp4' }];
  const selected = selectPlaybackStream(videos);
  assert.equal(selected.streamId, '2');
  assert.equal(selected.item.url, url);
  assert.equal(selected.item.headers, headers);
  assert.equal(selected.item.subtitles, subtitles);
  assert.deepEqual(selected.streams, [{ id: '2', label: 'HD' }, { id: '3', label: '서버 4' }]);
  assert.equal(selectPlaybackStream(videos, selected.streams[1].id).streamId, '3');
  for (const id of ['0', '1', '9', '-1', '2.0', '']) assert.throws(() => selectPlaybackStream(videos, id), code('playback-stream-unavailable'));
  assert.equal(selectPlaybackStream(videos).streamId, '2');
});

test('unwraps a single whole EDL stream, including UTF-8 length quoting', () => {
  for (const edl of [`edl://${url}`, `edl://${quote(url)},0;`, `edl://file=${quote(url)},start=0\n`]) {
    assert.equal(directVideoUrl(edl), url);
    assert.equal(selectPlaybackStream([{ url: edl }]).item.url, url);
  }
  const unicode = 'https://example.org/영상;a,b.m3u8';
  assert.equal(directVideoUrl(`edl://${quote(unicode)}`), new URL(unicode).href);
  assert.equal(directVideoUrl('edl://https://example.org/a%20b.m3u8'), 'https://example.org/a%20b.m3u8');
});

test('separate video/audio, clipped streams, concatenation and malformed EDL are skipped', () => {
  for (const edl of [separate, `edl://${url},1`, `edl://${url},0,60`, `edl://${url};${url}`, `edl://!unknown;${url}`, `edl://%999%${url}`, 'edl://', `edl://${url},start=0,start=0`, 'edl://http://example.org/video.mp4']) {
    assert.equal(directVideoUrl(edl), undefined, edl);
    assert.equal(selectPlaybackStream([{ url: edl }, { url }]).streamId, '1');
  }
});

test('empty extraction and entirely unplayable results have distinct source errors', () => {
  assert.throws(() => selectPlaybackStream([]), code('source-no-videos'));
  assert.throws(() => selectPlaybackStream([{ url: separate }, { url: 'http://example.org/video.mp4' }]), code('source-no-playable-video'));
  for (const value of ['https://', 'https://user:pass@example.org/video.mp4', 'file:///video.mp4']) assert.equal(directVideoUrl(value), undefined);
});
