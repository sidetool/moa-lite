import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { SqliteDatabase } from '../sqlite.js';
import { Store } from '../../server/src/db.js';
import { Sources } from '../../server/src/sources.js';
import { Catalog } from '../../server/src/catalog.js';
import { TitleGroups } from '../../server/src/title-groups.js';

test('WASM home groups the latest progress with the preferred card and scopes history, completion and discovery', async t => {
  const database = new SqliteDatabase(await initSqlJs()), db = new Store('/tmp/moa-lite-discovery',database as any);
  const catalog = new Catalog(db), sources = new Sources(db,catalog), groups = new TitleGroups(catalog);
  try {
    for (const profile of ['p','other']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',profile,profile,'blue',0,'2026');
    for (const [id,lang] of [['a','ko'],['b','en']]) {
      const entry=JSON.stringify({id,name:id,lang,version:'1'});
      db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)',id,'fixture',entry,entry,'fixture');
      db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,id==='a'?'작품':'The Show','anime',JSON.stringify({provider:{id,lang,name:id,kind:'mangayomi-js'},altTitles:['Alternate Name']}),'2026');
      db.run("INSERT INTO tmdb_links VALUES(?,'tv',100,1,'manual',100,?)",id,Date.now());
      for(const number of [1,2])db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,NULL)',id+number,id,1,number,`${number}화`,1200);
    }
    db.run("INSERT INTO tmdb_titles VALUES('tv',100,?,?,?)",JSON.stringify({title:'작품',originalTitle:'The Show'}),'{}',Date.now());
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p','a1',120,1200,0,'2026-10-01');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p','b1',360,1200,0,'2026-10-02');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','other','a1',80,1200,0,'2026-10-03');
    const home = (profile='p',providers?:string[],grouped=true) => catalog.home(profile,undefined,providers,'all','all',grouped?(recent,candidates)=>groups.continueWatching(recent,candidates,profile):undefined);
    const ongoing = (profile='p') => home(profile).rows.find(row=>row.kind==='continue')?.items??[];
    const cards=ongoing();assert.equal(cards.length,1);assert.equal(cards[0].id,'a');assert.equal(cards[0].sourceCount,2);assert.equal(cards[0].resume?.episodeId,'b1');assert.equal(cards[0].resume?.position,360);
    assert.equal(ongoing('other')[0].resume?.position,80);
    assert.equal(home('p',undefined,false).rows.find(row=>row.kind==='continue')?.items.length,2);
    groups.change('b','p','separate');assert.equal(ongoing().length,2);groups.change('b','p','reset');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)','p','b2',1200,1200,1,'2026-10-04');assert.equal(ongoing().length,0);
    db.run("DELETE FROM progress WHERE episode_id='b2'");
    db.run('INSERT INTO watchlist VALUES(?,?,?)','p','b','2026');
    assert.equal(home('p',['a']).rows.find(row=>row.kind==='watchlist')?.items[0].id,'b');
    const found=catalog.search('p','Alternate Name').groups.flatMap(group=>group.items);assert.equal(found.length,2);
    assert.equal(catalog.search('p','The Show').groups.flatMap(group=>group.items).length,2);
    for(let i=0;i<1000;i++)db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','cache'+i,'Cached '+i,'anime',JSON.stringify({provider:{id:'a',name:'a',kind:'mangayomi-js'}}),'2026');
    const calls=t.mock.method(catalog,'card');ongoing();assert(calls.mock.callCount()<20);
    calls.mock.resetCalls();catalog.search('p','Cached 999');assert.equal(calls.mock.callCount(),1);
  } finally { await sources.close(); database.close(); }
});
