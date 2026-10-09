import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { SqliteDatabase } from '../sqlite.js';
import { Store } from '../../server/src/db.js';
import { Catalog } from '../../server/src/catalog.js';
import { continueTarget, playTarget } from '../../server/src/progress.js';
import type { Episode } from '@moa/shared';
const ep = (id: string, season: number, number: number, position?: number, completed = false, updatedAt = '2026-10-08'): Episode => ({ id, mediaId: 'show', season, number, title: id, ...(position === undefined ? {} : { progress: { position, completed, updatedAt, duration: 1400 } }) });

test('latest completion beats older partial viewing, crosses seasons, and does not fabricate progress', () => {
  const episodes = [ep('s2e1', 2, 1), ep('e2', 1, 2, 1400, true), ep('e1', 1, 1, 200, false, '2026-10-07')];
  const before = JSON.stringify(episodes);
  assert.deepEqual(continueTarget(episodes), { episodeId: 's2e1', position: 0, kind: 'next', label: '다음 회차 S2:E1' });
  assert.equal(JSON.stringify(episodes), before);
  assert.equal(playTarget(episodes)?.episodeId, 's2e1');
  assert.equal(continueTarget(episodes.slice(1)), null);
  assert.equal(continueTarget([ep('movie', 1, 1, 1400, true)], true), null);
  assert.equal(continueTarget([ep('fresh', 1, 1, 0)]), null);
});

test('next target retains its saved position and skips completed episodes', () => {
  const episodes = [ep('e1', 1, 1, 1400, true), ep('e2', 1, 2, 1400, true, '2026-10-06'), ep('e3', 1, 3, 180, false, '2026-10-07')];
  assert.equal(continueTarget(episodes)?.episodeId, 'e3');
  assert.equal(continueTarget(episodes)?.position, 180);
});

test('WASM catalog groups before pagination, preserves profile boundaries and excludes finished titles', async () => {
  const database = new SqliteDatabase(await initSqlJs()), db = new Store('/tmp/moa-lite-test', database as any);
  try {
    for (const id of ['p', 'other']) db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)', id, id, 'blue', 0, '2026-10-01');
    db.run('INSERT INTO media(id,folder_id,title,type,metadata,added_at) VALUES(?,?,?,?,?,?)', 'show', null, 'Synthetic Series', 'anime', JSON.stringify({ provider: { id: 'fixture', name: 'Fixture', kind: 'extension' } }), '2026-10-01');
    for (let i = 1; i <= 3; i++) db.run('INSERT INTO episodes(id,media_id,season,number,title,duration,thumb) VALUES(?,?,?,?,?,?,?)', 'e'+i, 'show', 1, i, String(i), 1400, null);
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', 'p', 'e1', 200, 1400, 0, '2026-10-01');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', 'p', 'e2', 1400, 1400, 1, '2026-10-02');
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', 'other', 'e1', 50, 1400, 0, '2026-10-03');
    const catalog = new Catalog(db);
    assert.equal(catalog.history('p', 1).total, 1);
    assert.equal(catalog.history('p', 1).items[0].groupedCount, 2);
    assert.equal(catalog.history('p', 1).items[0].episode.id, 'e2');
    assert.equal(catalog.history('p', 2).items.length, 0);
    assert.equal(catalog.history('other', 1).items[0].groupedCount, 1);
    assert.equal(catalog.cards('p')[0].resume?.episodeId, 'e3');
    assert.equal(catalog.cards('other')[0].resume?.episodeId, 'e1');
    db.run('INSERT INTO settings VALUES(?,?)', 'p', JSON.stringify({ groupHistory: false }));
    assert.equal(catalog.history('p', 1).total, 2);
    db.run('INSERT INTO progress VALUES(?,?,?,?,?,?)', 'p', 'e3', 1400, 1400, 1, '2026-10-04');
    assert.equal(catalog.cards('p')[0].resume, undefined);
    assert.equal(db.get('SELECT COUNT(*) n FROM progress WHERE profile_id=?', 'other')!.n, 1);
  } finally { database.close(); }
});
