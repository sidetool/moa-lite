import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { SqliteDatabase } from '../sqlite.js';
import { Store } from '../../server/src/db.js';
import { Sources } from '../../server/src/sources.js';
import { Catalog } from '../../server/src/catalog.js';
import { SourceIdentities } from '../../server/src/source-identity.js';
import { identitySchema, workIdentity, episodeIdentity, restoreIdentities } from '../client/source-identity-sync.js';
import { validateChanges } from '../server/sync.js';

const setup = async (base: string) => {
  const database = new SqliteDatabase(await initSqlJs()), db = new Store('/tmp/moa-lite-identity-test', database as any);
  new Sources(db, new Catalog(db));
  const identities = new SourceIdentities(db); identitySchema(db);
  const entry = JSON.stringify({baseUrl: base});
  db.run('INSERT INTO source_entries(id,repository,entry,installed_entry) VALUES(?,?,?,?)','s','https://repo.test/',entry,entry);
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','m','Fixture','anime','{}','2026');
  db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)','e','m',1,1,'Episode',1200,null);
  db.run('INSERT INTO source_media VALUES(?,?,?,?)','m','s','https://old.test/work/1',0);
  db.run('INSERT INTO source_episodes VALUES(?,?)','e','https://old.test/watch/1');
  return {database, db, identities};
};
test('WASM sync restores installed-domain transitions and stable work/episode IDs on a fresh device', async () => {
  const a = await setup('https://old.test/'), b = await setup('https://new.test/');
  try {
    a.identities.work('s','m','https://old.test/work/1','https://old.test/');
    a.identities.episode('m','e','https://old.test/watch/1','https://old.test/');
    a.identities.sync('s','https://new.test/');
    const work = workIdentity(a.db,'m')!, episode = episodeIdentity(a.db,'e');
    validateChanges({since:0,changes:[{key:'["lite_work_identity","m"]',base:0,value:work},{key:'["lite_episode_identity","e"]',base:0,value:episode}]});
    b.db.run('INSERT INTO lite_work_identity VALUES(?,?)',work.media_id,work.value);
    b.db.run('INSERT INTO lite_episode_identity VALUES(?,?)',episode.episode_id,episode.value);
    restoreIdentities(b.db);
    assert.equal(b.identities.navigationUrl('s','https://old.test/watch/1','https://new.test/'),'https://new.test/watch/1');
    assert.equal(b.identities.findWork('s','https://new.test/work/1','https://new.test/'),'m');
    assert.equal(b.identities.findEpisode('m','https://new.test/watch/1','https://new.test/'),'e');
    // A stale cloud row must not undo an explicit rollback on this device.
    b.identities.sync('s','https://old.test/',true);
    b.db.run('UPDATE source_entries SET installed_entry=? WHERE id=?',JSON.stringify({baseUrl:'https://old.test/'}),'s');
    restoreIdentities(b.db);
    assert.equal(b.identities.navigationUrl('s','https://new.test/watch/1','https://old.test/'),'https://old.test/watch/1');
    assert.equal(b.db.get('SELECT count(*) n FROM source_address_sites')!.n,1);
  } finally { a.database.close(); b.database.close(); }
});
test('an old snapshot migrates to the newly installed address without merging different base paths', async () => {
  for (const installed of ['https://new.test/', 'https://new.test/other/']) {
    const a = await setup('https://old.test/'), b = await setup(installed);
    try {
      a.identities.work('s','m','https://old.test/work/1','https://old.test/');
      const work = workIdentity(a.db,'m')!;
      b.db.run('INSERT INTO lite_work_identity VALUES(?,?)',work.media_id,work.value); restoreIdentities(b.db);
      assert.equal(b.identities.navigationUrl('s','https://old.test/watch/1',installed),installed.endsWith('/other/') ? 'https://old.test/watch/1' : 'https://new.test/watch/1');
    } finally { a.database.close(); b.database.close(); }
  }
});

test('fresh devices keep an observed newer numeric origin despite static installed metadata', async () => {
 const a=await setup('https://example12.test/'),b=await setup('https://example12.test/');
 try {
  a.db.run('UPDATE source_media SET url=? WHERE media_id=?','https://example12.test/work/1','m');
  b.db.run('UPDATE source_media SET url=? WHERE media_id=?','https://example12.test/work/1','m');
  a.identities.work('s','m','https://example12.test/work/1','https://example12.test/');
  a.identities.work('s','m','https://example13.test/work/1','https://example12.test/');
  const work=workIdentity(a.db,'m')!;b.db.run('INSERT INTO lite_work_identity VALUES(?,?)',work.media_id,work.value);restoreIdentities(b.db);
  assert.equal(b.identities.navigationUrl('s','https://example12.test/watch/1','https://example12.test/'),'https://example13.test/watch/1');
  assert.deepEqual(JSON.parse(workIdentity(b.db,'m')!.value),JSON.parse(work.value),'transport identity has no device-specific random IDs or ordering');
 }finally{a.database.close();b.database.close();}
});

test('escaped opaque aliases still fit the outer sync JSON byte limit', async()=>{
 const a=await setup('https://old.test/');
 try{
  for(let i=0;i<4;i++)a.identities.episode('m','e',JSON.stringify({id:i,value:'"'.repeat(9000)}),'https://old.test/',false);
  const row=episodeIdentity(a.db,'e');
  validateChanges({since:0,changes:[{key:'["lite_episode_identity","e"]',base:0,value:row}]});
 }finally{a.database.close();}
});

test('existing devices accept a newly observed origin but remote snapshots cannot undo rollback',async()=>{
 const a=await setup('https://example12.test/'),b=await setup('https://example12.test/');
 try{
  for(const device of [a,b]){
   device.db.run('UPDATE source_media SET url=? WHERE media_id=?','https://example12.test/work/1','m');
   device.identities.work('s','m','https://example12.test/work/1','https://example12.test/');
  }
  a.identities.work('s','m','https://example13.test/work/1','https://example12.test/');
  const row=workIdentity(a.db,'m')!;b.db.run('INSERT INTO lite_work_identity VALUES(?,?)',row.media_id,row.value);restoreIdentities(b.db);
  assert.equal(b.identities.navigationUrl('s','https://example12.test/watch/1','https://example12.test/'),'https://example13.test/watch/1');
  b.identities.sync('s','https://example12.test/',true);restoreIdentities(b.db);
  assert.equal(b.identities.navigationUrl('s','https://example13.test/watch/1','https://example12.test/'),'https://example12.test/watch/1');
 }finally{a.database.close();b.database.close();}
});
