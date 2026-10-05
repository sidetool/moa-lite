import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDocuments, updateDocument } from '../server/documents.js';
import { synchronize, validateChanges } from '../server/sync.js';
const key = (table: string, ...id: string[]) => JSON.stringify([table, ...id]);
const profile = { id: 'p', name: '프로필', color: 'blue', kids: 0, created_at: '2026-10-05', account_id: 'forged', avatar: null };
test('sync serializes concurrent changes, applies server revisions and isolates accounts', async () => {
  const store = new MemoryDocuments(), pk = key('profiles', 'p');
  const initial = await synchronize(store, 'one', { since: 0, changes: [{ key: pk, base: 0, value: profile }] });
  assert.equal(initial.rows[pk].value!.account_id, 'one');
  const [a, b] = await Promise.all(['A', 'B'].map(name => synchronize(store, 'one', { since: 1, changes: [{ key: pk, base: 1, value: { ...profile, name } }] })));
  assert.equal(a.conflicts.length + b.conflicts.length, 1);
  const restored = await synchronize(store, 'one', { since: 0, changes: [] }); assert.equal(restored.revision, 2);
  assert.deepEqual((await synchronize(store, 'two', { since: 0, changes: [] })).rows, {});
  assert.equal((await store.get('sync:one')).value.rows[pk].version, 2);
});
test('profile deletion cascades versioned tombstones and stale offline children cannot revive it', async () => {
  const store = new MemoryDocuments(), pk = key('profiles', 'p'), sk = key('settings', 'p');
  await synchronize(store, 'one', { since: 0, changes: [{ key: sk, base: 0, value: { id: 'p', value: '{}' } }, { key: pk, base: 0, value: profile }] });
  const removed = await synchronize(store, 'one', { since: 0, changes: [{ key: pk, base: 1, value: null }] });
  assert.equal(removed.rows[sk].value, null);
  const retry = await synchronize(store, 'one', { since: removed.revision, changes: [{ key: sk, base: 2, value: { id: 'p', value: '{"autoplayNext":true}' } }] });
  assert.deepEqual(retry.conflicts, [sk]); assert.equal(retry.rows[sk].value, null);
});
test('sync rejects unknown columns, malformed identities, invalid JSON, oversized rows and batches', () => {
  for (const row of [
    { key: key('profiles', 'other'), base: 0, value: profile },
    { key: key('profiles', 'p'), base: 0, value: { ...profile, malicious: 'column' } },
    { key: key('settings', 'p'), base: 0, value: { id: 'p', value: 'broken JSON' } },
    { key: key('profiles', 'p'), base: 0, value: { ...profile, name: {} } },
    { key: key('profiles', 'p'), base: 0, value: { ...profile, name: null } },
    { key: key('profiles', 'p'), base: 0, value: { ...profile, kids: '1' } },
    { key: key('profiles', 'p'), base: 0, value: { ...profile, name: 'x'.repeat(16000) } }
  ]) assert.throws(() => validateChanges({ since: 0, changes: [row] }), /invalid-sync/);
  assert.throws(() => validateChanges({ since: 0, changes: new Array(101).fill({}) }), /invalid-sync/);
});
test('cloud profile limit rejects concurrent sixth profiles without deleting existing data', async () => {
  const store = new MemoryDocuments();
  const result = await synchronize(store, 'one', { since: 0, changes: Array.from({ length: 6 }, (_, n) => ({ key: key('profiles', String(n)), base: 0, value: { ...profile, id: String(n) } })) });
  assert.deepEqual(result.conflicts, [key('profiles', '5')]);
  assert.equal(Object.values(result.rows).filter(row => row.value).length, 5);
});
test('atomic document retries preserve independent writes', async () => {
  const store = new MemoryDocuments();
  await Promise.all(['one', 'two', 'three'].map(name => updateDocument(store, 'shared', (old: any) => ({ ...old, [name]: true }))));
  assert.deepEqual((await store.get('shared')).value, { one: true, two: true, three: true });
});
