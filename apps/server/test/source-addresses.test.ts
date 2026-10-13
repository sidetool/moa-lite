import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog.js';
import { Sources } from '../src/sources.js';
import { SourceIdentities } from '../src/source-identity.js';
import { RemotePlayback } from '../src/remote-playback.js';
import { invokeMangayomi } from '@moa/extensions';

async function fixture(runtime?: any) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'source-address-')), db=new Store(dir),catalog=new Catalog(db);
  const sources=new Sources(db,catalog,runtime,async entry=>({source:'fixture-'+entry.version,sha256:'hash-'+entry.version}));
  const initial={id:'fixture',name:'Test',version:'1',baseUrl:'https://example12.test',format:'mangayomi-js'};
  const entry=JSON.stringify(initial);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,sha256,enabled) VALUES(?,?,?,?,?,?,1)','s','https://repo.test/index.json',entry,entry,'fixture-1','hash-1');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  return {db,catalog,sources,initial,close:async()=>{await sources.close();db.close();await rm(dir,{recursive:true,force:true});}};
}

for(const destination of ['https://example2.test','https://example12.example','https://renamed.test']) {
  test(`installed origin transition to ${destination} preserves direct resume and supports rollback`,async()=>{
    const calls:{action:string;url?:string}[]=[];
    const f=await fixture(async(input:any)=>{
      const origin=input.entry.baseUrl;
      calls.push({action:input.action,url:input.params?.workUrl||input.params?.episodeUrl});
      return {changes:{},result:input.action==='filters'?{browse:{filters:[],availableModes:['popular']}}:
        input.action==='list'?{list:[{name:'Title',link:origin+'/work/1'}],hasNextPage:false}:
        input.action==='detail'?{name:'Title',link:origin+'/work/1',chapters:[{name:'1화',url:origin+'/watch?ep=1#part'}]}:
        [{url:'https://media.test/video.mp4'}]};
    });
    const {db,sources,catalog,initial}=f, playback=new RemotePlayback(db,catalog,sources);
    try {
      const id=(await sources.browse('s','p')).items[0].id;await sources.detail(id);
      const ep=db.get('SELECT id FROM episodes WHERE media_id=?',id)!.id;
      db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p',ep,450,1200,0,'2026');
      db.run('INSERT INTO watchlist VALUES(?,?,?)','p',id,'2026');
      db.run('UPDATE source_entries SET entry=? WHERE id=?',JSON.stringify({...initial,version:'2',baseUrl:destination}),'s');
      // Refreshing an index alone must not redirect a working installed extension.
      calls.length=0;await sources.videos(ep);assert.equal(calls[0].url,initial.baseUrl+'/watch?ep=1#part');
      await sources.install('s');calls.length=0;
      const session=await playback.create('p',ep);
      assert.deepEqual(calls,[{action:'videos',url:destination+'/watch?ep=1#part'}]);
      assert.equal(session.startPosition,450);assert.equal(session.episodeId,ep);
      assert.equal((await sources.browse('s','p')).items[0].id,id);
      await sources.detail(id);
      assert.equal(db.get('SELECT COUNT(*) n FROM episodes')!.n,1);
      assert.equal(db.get('SELECT COUNT(*) n FROM source_episode_alias')!.n,2);
      await sources.rollback('s');calls.length=0;
      const restored=await playback.create('p',ep);
      assert.deepEqual(calls,[{action:'videos',url:initial.baseUrl+'/watch?ep=1#part'}]);
      assert.equal(restored.startPosition,450);assert.equal((await sources.browse('s','p')).items[0].id,id);
      assert.equal(db.get('SELECT COUNT(*) n FROM media')!.n,1);
      assert.equal(db.get('SELECT COUNT(*) n FROM source_work_alias')!.n,2);
      assert.equal(db.get('SELECT media_id FROM watchlist')!.media_id,id);
      // Retired numeric responses cannot activate the rolled-back destination again.
      const identities=new SourceIdentities(db);
      identities.work('s',id,destination+'/work/1',initial.baseUrl);
      assert.equal(identities.navigationUrl('s',destination+'/work/1',initial.baseUrl),initial.baseUrl+'/work/1');
      playback.close();await sources.remove(['s']);
      for(const table of ['source_address_sites','source_address_origins','source_address_state','source_work_alias','source_episode_alias'])assert.equal(db.get(`SELECT COUNT(*) n FROM ${table}`)!.n,0);
    } finally {playback.close();await f.close();}
  });
}

test('multi-host sources, opaque IDs and query/fragment values remain distinct without per-source settings',async()=>{
  let links=['https://a.test/work/1','https://b.test/work/1','{"url":"https://a.test/work/1"}','episode-1','/work/2?q=1#p','/work/2?q=2#p','/work/2?q=1#other'];
  const f=await fixture(async()=>({changes:{},result:{list:links.map(link=>({name:'Same title',link})),hasNextPage:false}}));
  try {
    const first=(await f.sources.browse('s','p')).items.map(x=>x.id);assert.equal(new Set(first).size,links.length);
    links=links.map(link=>link.startsWith('/')?f.initial.baseUrl+link:link);f.sources.invalidate('s');
    assert.deepEqual((await f.sources.browse('s','p')).items.map(x=>x.id),first);
    const identities=new SourceIdentities(f.db);
    identities.sync('s','https://renamed.test');
    assert.equal(identities.navigationUrl('s','https://a.test/watch/1','https://renamed.test'),'https://a.test/watch/1');
    assert.equal(identities.findWork('s','https://renamed.test/work/1','https://renamed.test'),undefined);
    for(const raw of ['episode-1','{"url":"https://a.test/work/1"}','/work/2?q=1#p','episode/3','edl://video'])assert.equal(identities.navigationUrl('s',raw,'https://renamed.test'),raw);
  }finally{await f.close();}
});

test('base-path changes do not merge separate catalogues and unknown hosts are not rewritten',async()=>{
  const f=await fixture();const identities=new SourceIdentities(f.db);
  try {
    identities.sync('s','https://example12.test/one/');
    f.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','work','Title','series','{}','2026');
    identities.work('s','work','https://example12.test/one/item','https://example12.test/one/');
    identities.sync('s','https://changed.test/two/');
    assert.equal(identities.findWork('s','https://changed.test/one/item','https://changed.test/two/'),undefined);
    assert.equal(identities.navigationUrl('s','https://example12.test/one/item','https://changed.test/two/'),'https://example12.test/one/item');
    assert.equal(identities.navigationUrl('s','https://example999.test/one/item','https://changed.test/two/'),'https://example999.test/one/item');
    assert.equal(identities.navigationUrl('s','https://example12.test:8443/one/item','https://changed.test/two/'),'https://example12.test:8443/one/item');
  }finally{await f.close();}
});

test('a redirected detail adds a work-local alias without migrating unrelated works or hosts',async()=>{
  let list='https://example12.test/work/1';
  const f=await fixture(async(input:any)=>({changes:{},result:input.action==='list'?{list:[{name:'Title',link:list}],hasNextPage:false}:{name:'Title',link:'https://mirror.test/work/1',chapters:[]}}));
  try{
    const id=(await f.sources.browse('s','p')).items[0].id;await f.sources.detail(id);
    list='https://mirror.test/work/1';f.sources.invalidate('s');assert.equal((await f.sources.browse('s','p')).items[0].id,id);
    const identities=new SourceIdentities(f.db);
    assert.equal(identities.navigationUrl('s','https://example12.test/work/2',f.initial.baseUrl),'https://example12.test/work/2');
  }finally{await f.close();}
});

test('a changed generation discards completed extraction, releases its lease and does not retry',async()=>{
  let resolve!:(value:any)=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);let calls=0;
  const f=await fixture(async(input:any)=>{
    if(input.action==='list')return {changes:{},result:{list:[{name:'Title',link:'https://example12.test/work'}],hasNextPage:false}};
    if(input.action==='detail')return {changes:{},result:{chapters:[{name:'1화',url:'https://example12.test/watch'}]}};
    calls++;entered();return await new Promise(r=>resolve=r);
  });
  const releases:string[]=[];f.sources.apk.release=(lease?:string)=>{if(lease)releases.push(lease);};
  try{
    const id=(await f.sources.browse('s','p')).items[0].id;await f.sources.detail(id);
    const ep=f.db.get('SELECT id FROM episodes')!.id;
    f.db.run('UPDATE source_entries SET installed_entry=? WHERE id=?',JSON.stringify({...f.initial,baseUrl:'https://renamed.test'}),'s');
    const pending=assert.rejects(f.sources.videos(ep),/source-changed/);await started;
    f.sources.invalidate('s');resolve({changes:{},result:Object.assign([{url:'https://media.test/video.mp4'}],{apkLease:'fixture-lease'})});
    await pending;assert.equal(calls,1);assert.deepEqual(releases,['fixture-lease']);
    assert.equal(f.sources.remoteEpisode(ep)!.url,'https://example12.test/watch');
  }finally{await f.close();}
});

test('unchanged standard Mangayomi JS runs through QuickJS for absolute, relative and JSON identifiers',async()=>{
  const code=`class DefaultExtension extends MProvider {
    getPopular(){ return { list: [
      {name:'Absolute',link:this.source.baseUrl+'/work/1'},
      {name:'Relative',link:'/work/2'},
      {name:'Opaque',link:'{"id":"work-3"}'}],hasNextPage:false}; }
    getDetail(url){ const id=url.startsWith('{')?JSON.parse(url).id:url.split('/').pop();
      return {name:id,link:url,chapters:[{name:'1화',url:url.startsWith('{')?'episode:'+id:url+'/episode?part=1#video'}]}; }
    getVideoList(url){ if(!url.startsWith('episode:') && !url.includes('/episode?part=1#video'))throw Error('bad identifier');
      return [{url:'https://media.test/video.mp4',quality:url}]; }
  }`;
  const f=await fixture((input:any)=>invokeMangayomi({...input,source:code}));
  try {
    const first=(await f.sources.browse('s','p')).items;
    for(const item of first)await f.sources.detail(item.id);
    f.db.run('UPDATE source_entries SET entry=? WHERE id=?',JSON.stringify({...f.initial,version:'2',baseUrl:'https://renamed.test'}),'s');
    await f.sources.install('s');
    const second=(await f.sources.browse('s','p')).items;
    assert.deepEqual(second.map(x=>x.id),first.map(x=>x.id));
    for(const item of second)await f.sources.detail(item.id);
    const urls=[];
    for(const row of f.db.all('SELECT id FROM episodes ORDER BY title,id'))urls.push((await f.sources.videos(row.id))[0].quality);
    assert.equal(urls.length,3);assert.ok(urls.includes('episode:work-3'));
    assert.ok(urls.includes('/work/2/episode?part=1#video'));
    assert.ok(urls.includes('https://renamed.test/work/1/episode?part=1#video'));
  } finally{await f.close();}
});

test('APK descriptor transitions preserve IDs and direct playback without requiring JS-only APIs',async()=>{
  const f=await fixture();const {db,sources}=f;
  let base='https://old.test';const calls:any[]=[];
  const entry={id:'factory-1',name:'APK',lang:'en',version:'1',baseUrl:base,format:'aniyomi-apk',package:{pkg:'test.fixture',code:1,version:'1',apkUrl:'https://repo.test/a.apk'}};
  db.run('UPDATE source_entries SET entry=?,installed_entry=?,code=? WHERE id=?',JSON.stringify(entry),JSON.stringify(entry),'@aniyomi-apk','s');
  db.run('INSERT INTO source_apk VALUES(?,?)','s','fixture-package');
  sources.apk.install=async()=>({id:'fixture-package',digest:'new-digest',metadata:{version:'2'},sources:[{id:entry.id,name:entry.name,lang:entry.lang,baseUrl:base}]});
  sources.apk.call=async(_pkg,e,action,params)=>{
    calls.push({action,params});
    if(action==='list')return {list:[{name:'Title',link:e.baseUrl+'/work'}],hasNextPage:false};
    if(action==='detail')return {name:'Title',chapters:[{name:'1',url:e.baseUrl+'/watch',number:1}]};
    return Object.assign([{url:'https://media.test/video.mp4'}],{apkLease:'fake-lease'});
  };
  sources.apk.release=()=>{};
  try {
    const id=(await sources.browse('s','p')).items[0].id;await sources.detail(id);const ep=db.get('SELECT id FROM episodes')!.id;
    base='https://new.test';db.run('UPDATE source_entries SET entry=? WHERE id=?',JSON.stringify({...entry,version:'2'}),'s');
    await sources.install('s');calls.length=0;
    const videos=await sources.videos(ep);
    assert.equal(calls.length,1);assert.equal(calls[0].params.episodeUrl,base+'/watch');assert.equal(videos.apkLease,'fake-lease');
    assert.equal((await sources.browse('s','p')).items[0].id,id);
    await sources.detail(id);assert.equal(db.get('SELECT COUNT(*) n FROM episodes')!.n,1);
    assert.equal(sources.remoteEpisode(ep)!.url,base+'/watch');
  }finally{await f.close();}
});

test('legacy URLs newer than static metadata are not downgraded during backfill',async()=>{
  const f=await fixture();const identities=new SourceIdentities(f.db);
  try{
    f.db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','legacy','Title','series','{}','2026');
    identities.work('s','legacy','https://example13.test/work',f.initial.baseUrl,false);
    assert.equal(identities.navigationUrl('s','https://example13.test/work',f.initial.baseUrl),'https://example13.test/work');
    assert.equal(identities.findWork('s','https://example14.test/work',f.initial.baseUrl),'legacy');
    // Only a real installed-base transition retires previously backfilled origins.
    identities.sync('s','https://renamed.test');
    assert.equal(identities.navigationUrl('s','https://example13.test/work','https://renamed.test'),'https://renamed.test/work');
  }finally{await f.close();}
});
