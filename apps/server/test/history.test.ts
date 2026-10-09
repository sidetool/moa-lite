import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('completed progress promotes next episode; history groups before pagination and deletes only current profile', async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'moa-history-'));
  const {app,db}=await buildApp({dataDir:temp,mediaRoot:temp,webDir:path.join(temp,'web')},false,{tmdb:{token:'',key:''}});
  try {
    const create=async()=> (await app.inject({method:'POST',url:'/api/profiles',payload:{name:'Viewer'}})).json().id;
    const profile=await create(),other=await create(),headers={'x-moa-profile':profile};
    const get=async(url:string)=>(await app.inject({url,headers})).json();
    const settings=async(groupHistory:boolean)=>app.inject({method:'PATCH',url:'/api/settings',headers,payload:{groupHistory}});
    assert.equal((await get('/api/settings')).groupHistory,true);
    for (const id of ['show','other']) db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,id,'anime','{}','2026-10-08');
    for(let n=1;n<=43;n++) db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','ep'+n,'show',n<43?1:2,n<43?n:1,'Episode '+n,1400,null);
    db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','other-ep','other',1,1,'Other',1400,null);
    // An older partial record must not override the newer near-ending completion.
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)',profile,'ep1',300,1400,0,'2026-10-01');
    const done=await app.inject({method:'POST',url:'/api/progress',headers,payload:{episodeId:'ep42',position:1350,duration:1400}});
    assert.equal(done.json().completed,true);
    const card=(await get('/api/home?providers=local')).rows.find((r:any)=>r.kind==='continue').items[0];
    assert.deepEqual(card.resume,{episodeId:'ep43',position:0,kind:'next',label:'다음 회차 S2:E1'});
    assert.equal(card.progress,undefined);
    assert.equal(db.get('SELECT * FROM progress WHERE profile_id=? AND episode_id=?',profile,'ep43'),undefined);
    assert.equal((await get('/api/media/show')).playTarget.episodeId,'ep43');
    for(let n=1;n<=41;n++) db.run('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)',profile,'ep'+n,1400,1400,1,'2026-10-02');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)',profile,'other-ep',100,1400,0,'2026-10-01');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)',other,'ep42',500,1400,0,'2026-10-02');
    let history=await get('/api/history');
    assert.equal(history.total,2);
    assert.equal(history.items[0].episode.id,'ep42');
    assert.equal(history.items[0].groupedCount,42);
    assert.equal(history.hasNextPage,false);
    await settings(false);
    history=await get('/api/history');
    assert.equal(history.total,43);
    assert.equal(history.items.length,40);
    assert.equal(history.items[0].groupedCount,undefined);
    assert.equal((await get('/api/history?page=2')).items.length,3);
    await settings(true);
    assert.equal(db.get('SELECT COUNT(*) n FROM progress WHERE profile_id=?',profile)!.n,43);
    await app.inject({method:'POST',url:'/api/progress',headers,payload:{episodeId:'ep43',position:1400,duration:1400}});
    assert.ok(!(await get('/api/home?providers=local')).rows.find((r:any)=>r.kind==='continue')?.items.some((c:any)=>c.id==='show'));
    assert.equal((await app.inject({method:'DELETE',url:'/api/history/media/show',headers})).statusCode,204);
    assert.equal(db.get('SELECT COUNT(*) n FROM progress WHERE profile_id=?',profile)!.n,1);
    assert.equal(db.get('SELECT COUNT(*) n FROM progress WHERE profile_id=?',other)!.n,1);
    assert.equal((await get('/api/history')).items[0].media.id,'other');
    await app.inject({method:'DELETE',url:'/api/history/other-ep',headers});
    assert.equal((await get('/api/history')).total,0);
  } finally {await app.close();await rm(temp,{recursive:true,force:true});}
});
