import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SqliteDatabase } from '../sqlite.js';
import { mergeBackground } from '../client/background-state.js';

test('completed cache writes merge with another tab without overwriting user edits or newer cache rows', async()=>{
  const sql=await initSqlJs(), before=new SqliteDatabase(sql);
  before.exec("CREATE TABLE source_entries(id TEXT PRIMARY KEY,code TEXT); INSERT INTO source_entries VALUES('s','old'); CREATE TABLE media(id TEXT PRIMARY KEY,title TEXT); INSERT INTO media VALUES('m','old'); CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('p','old');");
  const bytes=before.export(), background=new SqliteDatabase(sql,bytes), newer=new SqliteDatabase(sql,bytes);
  try {
    background.prepare('UPDATE media SET title=?').run('background');newer.prepare('UPDATE settings SET value=?').run('new-user-settings');
    mergeBackground(sql,bytes,background,newer);
    assert.equal(newer.prepare('SELECT title FROM media').get().title,'background');assert.equal(newer.prepare('SELECT value FROM settings').get().value,'new-user-settings');
    newer.prepare('UPDATE media SET title=?').run('newer-tab-title');mergeBackground(sql,bytes,background,newer);assert.equal(newer.prepare('SELECT title FROM media').get().title,'newer-tab-title');
    newer.prepare('DELETE FROM media').run();mergeBackground(sql,bytes,background,newer);assert.equal(newer.prepare('SELECT * FROM media').get(),undefined);
    newer.prepare("INSERT INTO media VALUES('m','old')").run();newer.prepare('UPDATE source_entries SET code=?').run('updated-extension');mergeBackground(sql,bytes,background,newer);assert.equal(newer.prepare('SELECT title FROM media').get().title,'old');
  } finally { before.close();background.close();newer.close(); }
});
