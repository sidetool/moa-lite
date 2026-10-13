import test from 'node:test';
import assert from 'node:assert/strict';
const data = (body: string) => 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from(body).toString('base64');
const key = 'data:application/octet-stream;base64,' + Buffer.alloc(16, 7).toString('base64');
const body = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="${key}",IV=0x00000000000000000000000000000001\n#EXTINF:5,\nhttps://media.example.com/one.ts\n#EXT-X-ENDLIST\n`;
import { selectPlaybackStream } from '../client/playback-streams.js';
import { materializeInline, releaseInline } from '../client/inline-playback.js';
import { mediaRules } from '../connector/media-rules.js';
test('real JS runtime and Sources.videos reach playback; inline credentials stay on the declared origin', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parseRepository } = await import('@moa/extensions');
  const { Store } = await import('../../server/src/db.js');
  const { Catalog } = await import('../../server/src/catalog.js');
  const { Sources } = await import('../../server/src/sources.js');
  const dir = await mkdtemp(join(tmpdir(),'moa-inline-integration-'));
  const db = new Store(dir), catalog = new Catalog(db), sources = new Sources(db,catalog);
  const entry = JSON.stringify(parseRepository([{id:'inline-fixture',name:'Fixture',lang:'en',version:'1',itemType:1,sourceCodeLanguage:1,baseUrl:'https://source.example',sourceCodeUrl:'https://source.example/code.js'}])[0]);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','fixture',entry,entry,'fixture');
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','m','Fixture','series','{}','2026');
  db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','e','m',1,1,'Episode',10,null);
  db.run('INSERT INTO source_media VALUES(?,?,?,0)','m','s','show');
  db.run('INSERT INTO source_episodes VALUES(?,?)','e','episode');
  const twoOrigins=body.replace('#EXT-X-ENDLIST','#EXTINF:5,\nhttps://cdn.example.net/two.ts\n#EXT-X-ENDLIST');
  const headers={aUtHoRiZaTiOn:'Bearer fixture',cOoKiE:'fixture=yes',Referer:'https://source.example/','User-Agent':'fixture'};
  try {
    for (const [prefix,originalUrl] of [
      ['data:','https://media.example.com/list.m3u8'],
      ['data://','https://media.example.com/list.m3u8'],
      ['data:',undefined],['data:','invalid'],['data:','https://user:pass@media.example.com/list.m3u8'],
    ] as const) {
      const inline={url:data(twoOrigins).replace('data:',prefix),originalUrl,headers};
      const ordinary=[{url:'https://media.example.com/plain.mp4'},{url:'edl://fixture'}];
      const videos=[{url:'data:text/html;base64,PGh0bWw+'},{url:data('not a playlist')},inline,...ordinary];
      // No mocked Sources.videos or private playback helper: execute the guest, filter and create.
      db.run('UPDATE source_entries SET code=? WHERE id=?',`class DefaultExtension extends MProvider { async getVideoList(){return ${JSON.stringify(videos)};} }`,'s');
      const extracted=await sources.videos('e');
      assert.deepEqual(extracted.map(v=>v.url),[inline.url,...ordinary.map(v=>v.url)]);
      const selected=selectPlaybackStream(extracted).item;
      const session={...selected,sessionId:'fixture',mime:'video/mp4'};
      const materialized=materializeInline(session)!;
      const manifest=await (await fetch(session.url)).text();
      assert.match(manifest,/https:\/\/media.example.com/);
      const rules=mediaRules({url:materialized.url,headers:materialized.headers},'https://reader.example.org',1,100,['https://media.example.com/one.ts','https://cdn.example.net/two.ts']);
      for (const rule of rules) {
        const credential=rule.action.requestHeaders.find((item: any)=>item.header==='authorization');
        const keep=originalUrl==='https://media.example.com/list.m3u8' && rule.condition.regexFilter.includes('media');
        assert.equal(credential?.value,keep?headers.aUtHoRiZaTiOn:undefined);
      }
      releaseInline(session.sessionId);
      await assert.rejects(fetch(session.url));
    }
    // Distinguish an empty result from rejected formats at the actual playback entry point.
    for (const [videos,code] of [
      [[], 'no-streams'],
      [[{url:'data:text/html;base64,c2VjcmV0',headers:{Cookie:'private=fixture'}}], 'unsupported-stream-format'],
      [[{url:data('not a playlist')}], 'unsupported-stream-format'],
    ] as const) {
      db.run('UPDATE source_entries SET code=? WHERE id=?',`class DefaultExtension extends MProvider { async getVideoList(){return ${JSON.stringify(videos)};} }`,'s');
      if (!videos.length) assert.equal((await sources.videos('e')).length,0);
      else await assert.rejects(sources.videos('e'), /unsupported-stream-format/);
    }
  } finally {await sources.close();db.close();await rm(dir,{recursive:true,force:true});}
});
