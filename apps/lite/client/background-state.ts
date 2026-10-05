import { SqliteDatabase } from '../sqlite.js';
import type { SqlJsStatic } from 'sql.js';

// Only provider/TMDB cache facts may be produced outside an API transaction.
// User rows (settings, progress, watchlist, jobs) always belong to the newer snapshot.
const tables = ['source_entries', 'media', 'episodes', 'source_media', 'source_episodes', 'source_images', 'source_image_owners', 'source_read_cache', 'source_detail_observations', 'source_health', 'enrichment_cache', 'media_titles', 'tmdb_links', 'tmdb_match_versions', 'tmdb_titles', 'tmdb_seasons'];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Merge completed background writes only when their base row is still current. */
export function mergeBackground(sql: SqlJsStatic, baseBytes: Uint8Array, previous: SqliteDatabase, incoming: SqliteDatabase) {
  const base = new SqliteDatabase(sql, baseBytes);
  try {
    const entries = (db: SqliteDatabase) => db.prepare('SELECT * FROM source_entries ORDER BY id').all();
    // Installing/removing/updating/configuring a source invalidates its pending work.
    if (!equal(entries(base), entries(incoming))) return;
    incoming.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    try {
      for (const table of tables) {
        const columns: Array<{name:string;pk:number}> = base.prepare(`PRAGMA table_info(${table})`).all();
        const keys = columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name);
        if (!keys.length) continue;
        const identity = (row: any) => JSON.stringify(keys.map(k => row[k]));
        const rows = (db: SqliteDatabase) => new Map<string, Record<string, any>>(db.prepare(`SELECT * FROM ${table}`).all().map((row: Record<string, any>) => [identity(row),row]));
        const before = rows(base), after = rows(previous), current = rows(incoming);
        for (const [key, row] of after) {
          if (equal(row, before.get(key)) || !equal(current.get(key), before.get(key))) continue;
          const names = Object.keys(row), update = names.filter(name => !keys.includes(name));
          incoming.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')}) ON CONFLICT(${keys.join(',')}) DO ${update.length ? 'UPDATE SET '+update.map(name=>`${name}=excluded.${name}`).join(',') : 'NOTHING'}`).run(...names.map(name=>row[name]));
        }
        // Background eviction must never cascade into another tab's history.
        // Expired rows can be evicted by that tab's next ordinary cache operation.
      }
      incoming.exec('COMMIT');
    } catch (error) { incoming.exec('ROLLBACK'); return; }
  } finally { base.close(); }
}
