import { changeDocument, type SyncChange, type SyncDocument } from './upstream-sync.js';
import { updateDocument, type DocumentStore } from './documents.js';
import { syncSchema, syncOrder } from '../sync-schema.js';
const numeric = new Set(['kids', 'season', 'number', 'duration', 'detail_at', 'tmdb_id', 'score', 'checked_at', 'position', 'completed']);
const nullable: Record<string, string[]> = { profiles: ['avatar'], media: ['folder_id'], episodes: ['thumb'], tmdb_links: ['kind', 'tmdb_id', 'season', 'score'] };
export function validateChanges(input: any): { since: number; changes: SyncChange[] } {
  if (!Number.isSafeInteger(input?.since) || input.since < 0 || !Array.isArray(input.changes) || input.changes.length > 100) throw new Error('invalid-sync');
  const seen = new Set<string>();
  for (const row of input.changes) {
    if (typeof row.key !== 'string' || row.key.length > 1000 || seen.has(row.key) || !Number.isSafeInteger(row.base) || row.base < 0) throw new Error('invalid-sync');
    let key; try { key = JSON.parse(row.key); } catch { throw new Error('invalid-sync'); }
    const schema = Array.isArray(key) ? syncSchema[key[0]] : undefined;
    if (!schema || key.length !== schema.key.length + 1 || JSON.stringify(key) !== row.key || key.slice(1).some((id: unknown) => typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x1f]/.test(id))) throw new Error('invalid-sync');
    if (row.value !== null && (!row.value || Array.isArray(row.value) || typeof row.value !== 'object' || Buffer.byteLength(JSON.stringify(row.value)) > 16000)) throw new Error('invalid-sync');
    if (row.value !== null && (Object.keys(row.value).some(name => !schema.fields.includes(name)) || schema.key.some((name, index) => row.value[name] !== key[index + 1]) || schema.fields.some(name => !Object.hasOwn(row.value, name)))) throw new Error('invalid-sync');
    if (row.value && Object.values(row.value).some(value => value !== null && (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && !Number.isFinite(value)))) throw new Error('invalid-sync');
    if (row.value && schema.fields.some(field => row.value[field] === null ? !(nullable[key[0]] ?? []).includes(field) : typeof row.value[field] !== (numeric.has(field) ? 'number' : 'string'))) throw new Error('invalid-sync');
    if (row.value && key[0] === 'profiles' && (!row.value.name.trim() || row.value.name.length > 200 || !['red', 'blue', 'green', 'amber', 'violet', 'teal'].includes(row.value.color) || ![0, 1].includes(row.value.kids))) throw new Error('invalid-sync');
    if (row.value) for (const field of ['value', 'metadata', 'headers']) if (Object.hasOwn(row.value, field)) {
      try { if (typeof row.value[field] !== 'string' || !JSON.parse(row.value[field] as string) || Array.isArray(JSON.parse(row.value[field] as string))) throw new Error(); } catch { throw new Error('invalid-sync'); }
    }
    if (row.value && key[0] === 'media' && row.value.folder_id !== null) throw new Error('invalid-sync');
    seen.add(row.key);
  }
  return input;
}
export async function synchronize(store: DocumentStore, accountId: string, input: any) {
  const changes = validateChanges(input); let result: ReturnType<typeof changeDocument>;
  if (!changes.changes.length) return changeDocument((await store.get(`sync:${accountId}`)).value ?? { revision: 0, rows: {} }, changes);
  for (const change of changes.changes) if (change.value && JSON.parse(change.key)[0] === 'profiles') change.value.account_id = accountId;
  changes.changes.sort((a, b) => syncOrder(a.key) - syncOrder(b.key));
  await updateDocument(store, `sync:${accountId}`, (saved: SyncDocument | null) => {
    const doc = saved ?? { revision: 0, rows: {} };
    const valid = [], rejected: string[] = [];
    const next = structuredClone(doc.rows);
    for (const change of changes.changes) {
      const schema = syncSchema[JSON.parse(change.key)[0]];
      if (change.value && JSON.parse(change.key)[0] === 'profiles' && !next[change.key]?.value && Object.entries(next).filter(([key, row]) => JSON.parse(key)[0] === 'profiles' && row.value).length >= 5) { rejected.push(change.key); continue; }
      if (change.value && Object.entries(schema.refs ?? {}).some(([field, table]) => !next[JSON.stringify([table, change.value![field]])]?.value)) { rejected.push(change.key); continue; }
      valid.push(change);
      if ((next[change.key]?.version ?? 0) === change.base) next[change.key] = { version: 0, value: change.value };
    }
    const conflicts = changeDocument(doc, { since: changes.since, changes: valid }).conflicts;
    // Deleting a profile/media/episode also versions every dependent deletion.
    let removed;
    do {
      removed = false;
      for (const [key, row] of Object.entries(doc.rows)) {
        const schema = syncSchema[JSON.parse(key)[0]];
        if (row.value && Object.entries(schema.refs ?? {}).some(([field, table]) => !doc.rows[JSON.stringify([table, row.value![field]])]?.value)) {
          doc.rows[key] = { version: ++doc.revision, value: null }; removed = true;
        }
      }
    } while (removed);
    result = changeDocument(doc, { since: changes.since, changes: [] });
    result.conflicts = [...new Set([...conflicts, ...rejected])];
    for (const key of result.conflicts) result.rows[key] = doc.rows[key] ?? { version: 0, value: null };
    return doc;
  });
  return result!;
}
