import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/db.js';
import {Catalog} from '../src/catalog.js';
import {Sources} from '../src/sources.js';
import {RemotePlayback} from '../src/remote-playback.js';
import {SourceIdentities} from '../src/source-identity.js';

test('existing work/episode IDs and two profiles survive mirror change and database reopen',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'source-identity-'));let db=new Store(dir);let sources:Sources|undefined;
 let origin='https://example12.test';
 const runtime=async(input:any)=>({result:input.action==='list'?{list:[{name:'Same title',link:origin+'/work/7'}],hasNextPage:false}:{name:'Same title',chapters:[{name:'1화',url:origin+'/watch/7?episode=1#v'}]},changes:{}});
 try{
  let catalog=new Catalog(db);sources=new Sources(db,catalog,runtime);
  const entry=JSON.stringify({id:'fixture',name:'Test',version:'1',baseUrl:origin,format:'mangayomi-js'});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','https://repo.test/index.json',entry,entry,'fixture');
  for(const p of ['p1','p2'])db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',p,p,'blue',0,'2026');
  const first=(await sources.browse('s','p1')).items[0].id;await sources.detail(first);
  const ep=db.get('SELECT id FROM episodes WHERE media_id=?',first)!.id;
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p1',ep,300,1200,0,'2026');
  db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p2',ep,900,1200,0,'2026');
  db.run('INSERT INTO watchlist VALUES(?,?,?)','p1',first,'2026');
  // Simulate upgrading an old database with no identity indexes.
  await sources.close();db.db.exec('DROP TABLE source_work_alias;DROP TABLE source_episode_alias;DELETE FROM source_identity_migrations');db.close();
  db=new Store(dir);catalog=new Catalog(db);sources=new Sources(db,catalog,runtime);
  origin='https://example13.test';sources.invalidate('s');
  assert.equal((await sources.browse('s','p1')).items[0].id,first);
  await sources.detail(first);
  assert.equal(db.get('SELECT COUNT(*) n FROM media')!.n,1);
  assert.equal(db.get('SELECT COUNT(*) n FROM episodes')!.n,1);
  assert.equal(db.get('SELECT url FROM source_episodes WHERE episode_id=?',ep)!.url,origin+'/watch/7?episode=1#v');
  assert.deepEqual(db.all('SELECT position FROM progress ORDER BY profile_id').map(r=>r.position),[300,900]);
  assert.equal(db.get('SELECT media_id FROM watchlist')!.media_id,first);
  const identities=new SourceIdentities(db);
  assert.equal(identities.findWork('other',origin+'/work/7','https://example12.test'),undefined);
  assert.equal(identities.findEpisode(first,origin+'/watch/7?episode=2#v','https://example12.test'),undefined);
  // Pre-existing ambiguity must not merge or delete either history.
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','duplicate','Same title','series','{}','2026');
  identities.work('s','duplicate','https://example14.test/work/7','https://example12.test');
  assert.equal(identities.findWork('s','https://example15.test/work/7','https://example12.test'),undefined);
 }finally{await sources?.close();db.close();await rm(dir,{recursive:true,force:true});}
});

for (const evidence of ['installed metadata','another work response'] as const) {
 test(`home resumes directly after domain change from ${evidence}, without detail refresh`,async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'source-resume-')), db=new Store(dir), catalog=new Catalog(db);
  const old='https://example12.test', moved='https://example13.test';
  let listed=old, listPath='/work/7'; const calls:{action:string;url?:string}[]=[];
  const sources=new Sources(db,catalog,async(input:any)=>{
   calls.push({action:input.action,url:input.params?.episodeUrl || input.params?.workUrl});
   const result=input.action==='list'?{list:[{name:'Title',link:listed+listPath}],hasNextPage:false}
    :input.action==='detail'?{name:'Title',chapters:[{name:'1화',url:old+'/watch/7?ep=1#part'}]}
    :[{url:'https://cdn.test/main.m3u8'}];
   return {result,changes:{}};
  });
  const playback=new RemotePlayback(db,catalog,sources);
  const entry={id:'fixture',name:'Test',version:'1',baseUrl:old,format:'mangayomi-js'};
  const serialized=JSON.stringify(entry);
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','https://repo.test/index.json',serialized,serialized,'fixture');
  db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)','p','p','blue',0,'2026');
  try{
   const work=(await sources.browse('s','p')).items[0].id;await sources.detail(work);
   const episode=db.get('SELECT id FROM episodes WHERE media_id=?',work)!.id;
   db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p',episode,321,1200,0,'2026');
   db.run('INSERT INTO watchlist VALUES(?,?,?)','p',work,'2026');
   if(evidence==='installed metadata')db.run('UPDATE source_entries SET installed_entry=? WHERE id=?',JSON.stringify({...entry,baseUrl:moved}),'s');
   else {listed=moved;listPath='/work/99';sources.invalidate('s');await sources.browse('s','p');}
   calls.length=0;
   const session=await playback.create('p',episode);
   assert.deepEqual(calls,[{action:'videos',url:moved+'/watch/7?ep=1#part'}]);
   assert.equal(session.startPosition,321);assert.equal(session.episodeId,episode);assert.equal(session.mediaId,work);
   assert.equal(db.get('SELECT media_id FROM watchlist')!.media_id,work);
   assert.equal(sources.remoteEpisode(episode)!.url,moved+'/watch/7?ep=1#part');
   sources.invalidate('s');calls.length=0;await sources.detail(work);
   assert.deepEqual(calls,[{action:'detail',url:moved+'/work/7'}]);
   assert.equal(db.get('SELECT url FROM source_media WHERE media_id=?',work)!.url,moved+'/work/7');
  }finally{playback.close();await sources.close();db.close();await rm(dir,{recursive:true,force:true});}
 });
}

test('domain fallback preserves old-only extensions and never rewrites opaque, relative or unrelated identifiers',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'source-fallback-')),db=new Store(dir),catalog=new Catalog(db);
 const old='https://example12.test',moved='https://example13.test';let fail:'throw'|'empty'|'both'='throw';const urls:string[]=[];
 const sources=new Sources(db,catalog,async(input:any)=>{
  if(input.action==='list')return {result:{list:[{name:'Title',link:old+'/work'}],hasNextPage:false},changes:{}};
  if(input.action==='detail')return {result:{chapters:[{name:'1화',url:old+'/watch?x=%2f#p'}]},changes:{}};
  const url=input.params.episodeUrl;urls.push(url);
  if(fail==='both'||url.startsWith(moved)){
   if(fail==='empty')return {result:[],changes:{}};
   throw new Error('fixture-unsupported-origin');
  }
  return {result:[{url:'https://cdn.test/video.mp4'}],changes:{}};
 });
 const entry={id:'fixture',name:'Test',version:'1',baseUrl:old};const serialized=JSON.stringify(entry);
 db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)','s','https://repo.test/index.json',serialized,serialized,'fixture');
 try{
  const work=(await sources.browse('s','p')).items[0].id;await sources.detail(work);
  const ep=db.get('SELECT id FROM episodes WHERE media_id=?',work)!.id;
  db.run('UPDATE source_entries SET installed_entry=? WHERE id=?',JSON.stringify({...entry,baseUrl:moved}),'s');
  for(fail of ['throw','empty','both'] as const){
   sources.invalidate('s');urls.length=0;
   if(fail==='both')await assert.rejects(sources.videos(ep),/fixture-unsupported-origin/);else assert.equal((await sources.videos(ep)).length,1);
   assert.deepEqual(urls,[moved+'/watch?x=%2f#p',old+'/watch?x=%2f#p']);
   assert.equal(sources.remoteEpisode(ep)!.url,old+'/watch?x=%2f#p');
  }
  fail='throw';sources.invalidate('s');urls.length=0;
  await sources.videos(ep);await sources.videos(ep);
  assert.deepEqual(urls,[moved+'/watch?x=%2f#p',old+'/watch?x=%2f#p',old+'/watch?x=%2f#p']);
  const identities=new SourceIdentities(db);
  for(const value of ['/watch','episode-12','{"url":"/watch"}','https://foreign12.test/watch','https://example12.test:8443/watch'])assert.equal(identities.navigationUrl('s',value,moved),value);
  assert.equal(identities.navigationUrl('s',old+'/watch?x=%2f#p',moved),moved+'/watch?x=%2f#p');
  assert.equal(identities.navigationUrl('s','https://example14.test/watch',moved),'https://example14.test/watch');
  // A detail refresh already knows its work ID, even if old duplicate records exist.
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','duplicate','Title','series','{}','2026');
  identities.work('s','duplicate',old+'/work',old);
  sources.invalidate('s');await sources.detail(work);
  assert.equal(db.get('SELECT COUNT(*) n FROM media')!.n,2);
  assert.equal(db.get('SELECT url FROM source_media WHERE media_id=?',work)!.url,moved+'/work');
 }finally{await sources.close();db.close();await rm(dir,{recursive:true,force:true});}
});
