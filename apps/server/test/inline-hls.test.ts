import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineHls, INLINE_HLS_LIMIT } from '../src/inline-hls.js';
const data = (body: string) => 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from(body).toString('base64');
const key = 'data:application/octet-stream;base64,' + Buffer.alloc(16, 7).toString('base64');
const body = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="${key}",IV=0x00000000000000000000000000000001\n#EXTINF:5,\nhttps://media.example.com/one.ts\n#EXT-X-ENDLIST\n`;
test('accepts existing URL field encoding and preserves key bytes and IV', () => {
  for (const prefix of ['data:', 'data://']) {
    const result = parseInlineHls(data(body).replace('data:',prefix));
    assert.equal(result.body,body); assert.deepEqual(result.keys.get(key),new Uint8Array(16).fill(7));
  }
});
test('rejects nested data, relative/file resources, unsupported encryption and unbounded input', () => {
  for (const invalid of [body.replace('https://media.example.com/one.ts','file:///etc/passwd'),body.replace('https://media.example.com/one.ts','one.ts'),body.replace('https://media.example.com/one.ts',key),body.replace('AES-128','SAMPLE-AES'),body.replace(key,key.slice(0,-4)),body.replace('#EXT-X-ENDLIST',''),body+'#EXT-X-DEFINE:NAME="x",VALUE="y"\n',body+'#EXT-X-MAP:URI="file:///tmp/a"\n',body.replace(key,'https://example.com/key')]) assert.throws(()=>parseInlineHls(data(invalid)));
  assert.throws(()=>parseInlineHls(data('a'.repeat(INLINE_HLS_LIMIT+1))));
});
test('keeps distinct rotated keys, rejects excessive key counts', () => {
  const lines=Array.from({length:33},(_,i)=>`#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,${Buffer.alloc(16,i).toString('base64')}"`);
  assert.equal(parseInlineHls(data(body.replace('#EXTINF:',lines.slice(0,2).join('\n')+'\n#EXTINF:'))).keys.size,3);
  assert.throws(()=>parseInlineHls(data(body+lines.join('\n'))));
});

test('handles a near-limit valid playlist and rejects malformed UTF-8/base64', () => {
  const large=body+'#'+ 'x'.repeat(INLINE_HLS_LIMIT-Buffer.byteLength(body)-2)+'\n';
  assert.equal(Buffer.byteLength(large),INLINE_HLS_LIMIT);
  assert.equal(parseInlineHls(data(large)).body,large);
  assert.throws(()=>parseInlineHls(data(body)+'='));
  assert.throws(()=>parseInlineHls('data:application/vnd.apple.mpegurl;base64,'+Buffer.from([255,255]).toString('base64')));
});

test('rejected APK formats release their lease; accepted mixed results keep the lease', async () => {
  const { Sources } = await import('../src/sources.js');
  const released:string[]=[];
  const videos:any=Object.assign([{url:'data:text/html;base64,Zml4dHVyZQ=='}],{apkLease:'fixture-lease'});
  const source:any={
    remoteEpisode:()=>({source_id:'s',url:'episode'}),
    serial:(_id:string,task:()=>Promise<unknown>)=>task(),
    navigationCall:async()=>({result:videos,url:'episode',current:()=>{}}),
    apk:{release:(lease:string)=>{released.push(lease);}},
  };
  await assert.rejects(Sources.prototype.videos.call(source,'e'),/unsupported-stream-format/);
  assert.deepEqual(released,['fixture-lease']);
  released.length=0;
  videos.push({url:'https://media.example.com/video.mp4'});
  const result=await Sources.prototype.videos.call(source,'e');
  assert.equal(result.length,1);assert.equal(result.apkLease,'fixture-lease');
  assert.deepEqual(released,[]);
});
