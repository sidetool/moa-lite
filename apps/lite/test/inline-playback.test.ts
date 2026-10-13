import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeInline, releaseInline, releaseAllInline } from '../client/inline-playback.js';
import { selectPlaybackStream } from '../client/playback-streams.js';
const key = 'data:application/octet-stream;base64,' + Buffer.alloc(16,7).toString('base64');
const body = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="${key}"\n#EXTINF:5,\nhttps://media.example/one.ts\n#EXT-X-ENDLIST\n`;
const data = (value: string) => 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from(value).toString('base64');
test('inline HLS materializes only local playlist/key blobs, preserves direct segments and releases resources', async () => {
  const session = {sessionId:'test',url:selectPlaybackStream([{url:data(body)}]).item.url,mime:'video/mp4'};
  const inline = materializeInline(session)!;
  assert.equal(inline.url,'https://media.example/one.ts'); assert.equal(inline.playlist,body);
  const manifest = await (await fetch(session.url)).text();
  assert(manifest.includes('https://media.example/one.ts')); assert(!manifest.includes('/api/'));
  const keyUrl = /URI="([^"]+)"/.exec(manifest)![1];
  assert.deepEqual(new Uint8Array(await (await fetch(keyUrl)).arrayBuffer()), new Uint8Array(16).fill(7));
  releaseInline(session.sessionId);
  await assert.rejects(fetch(session.url)); await assert.rejects(fetch(keyUrl));
  releaseAllInline();
});
test('inline HLS refuses unbounded or unsupported data before allocating browser URLs', () => {
  assert.throws(() => selectPlaybackStream([{url:data(body.replace('https://media.example/one.ts','../one.ts'))}]));
  assert.throws(() => selectPlaybackStream([{url:'data:text/html;base64,PHNjcmlwdD4='}]));
});
