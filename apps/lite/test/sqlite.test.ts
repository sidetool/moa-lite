import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlite } from '../server/auth.js';
import { SqliteDatabase } from '../sqlite.js';
import { Store } from '../../server/src/db.js';
test('original Store works with SQL.js bindings, migrations, transactions and exports', async () => {
  const database = new SqliteDatabase(await sqlite()), db = new Store('/tmp/moa-lite-test', database as any);
  db.run('INSERT INTO profiles VALUES(?,?,?,?,?,?,?)', 'id', '첫 기기', 'blue', 0, 'today', 'acct', null);
  assert.equal(db.get('SELECT name FROM profiles WHERE id=?', 'id')!.name, '첫 기기');
  db.transaction(() => { db.run('INSERT INTO settings VALUES(?,?)', 'id', '{}'); });
  const restored = new SqliteDatabase(await sqlite(), database.export());
  assert.equal(restored.prepare('SELECT name FROM profiles').get().name, '첫 기기');
  restored.close(); database.close();
});
