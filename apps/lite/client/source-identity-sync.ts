import { hash } from '../domain.js';
import type { Store } from '../../../apps/server/src/db.js';
import { SourceIdentities } from '../../../apps/server/src/source-identity.js';

// Only aliases belonging to synchronized works/episodes travel to another device.
// Each row stays below the sync protocol's 16 KB limit, even with long source IDs.
const bounded = (value: any, field: string, rows: any[]) => {
  value[field] = [];
  for (const row of rows) {
    value[field].push(row);
    if (new TextEncoder().encode(JSON.stringify({id:'x'.repeat(200),value:JSON.stringify(value)})).length > 15500) value[field].pop();
  }
  return JSON.stringify(value);
};
export function identitySchema(db: Store) {
  db.db.exec(`CREATE TABLE IF NOT EXISTS lite_work_identity(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lite_episode_identity(episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,value TEXT NOT NULL)`);
}
export function workIdentity(db: Store, media: string) {
  const source = db.get('SELECT source_id FROM source_media WHERE media_id=?', media)?.source_id;
  if (!source) return;
  const state = db.get('SELECT * FROM source_address_state WHERE source_id=?', source);
  const sites = db.all('SELECT * FROM source_address_sites WHERE source_id=? ORDER BY path,active_origin', source).map(site => ({
    source_id: source, site_id: String(site.site_id), path: String(site.path), active_origin: String(site.active_origin), origins: db.all('SELECT origin,used FROM source_address_origins WHERE source_id=? AND site_id=? ORDER BY used DESC,origin', source, site.site_id)
  }));
  for (const site of sites) site.site_id = hash(JSON.stringify([source,site.path,site.origins.map(o => o.origin)]));
  const value: any = { source, base: state?.base_url ?? '', sites: [], aliases: db.all('SELECT raw,origin,resource FROM source_work_alias WHERE media_id=? ORDER BY raw,origin LIMIT 4', media) };
  // Installation origins take priority over optional historical aliases.
  while (value.aliases.length && new TextEncoder().encode(JSON.stringify(value)).length > 6000) value.aliases.pop();
  return { media_id: media, value: bounded(value, 'sites', sites) };
}
export function episodeIdentity(db: Store, episode: string) {
  return { episode_id: episode, value: bounded({}, 'aliases', db.all('SELECT raw,origin,resource FROM source_episode_alias WHERE episode_id=? ORDER BY raw,origin LIMIT 4', episode)) };
}
export function restoreIdentities(db: Store) {
  const identities = new SourceIdentities(db);
  for (const row of db.all('SELECT * FROM lite_work_identity')) {
    let value: any; try { value = JSON.parse(row.value); } catch { continue; }
    const source = db.get('SELECT s.* FROM source_media m JOIN source_entries s ON s.id=m.source_id WHERE m.media_id=?', row.media_id);
    if (!source || value.source !== source.id || !Array.isArray(value.sites) || !Array.isArray(value.aliases)) continue;
    const installed = JSON.parse(source.installed_entry || source.entry).baseUrl || '';
    for (const site of value.sites) {
      if (!site || typeof site.site_id !== 'string' || typeof site.path !== 'string' || typeof site.active_origin !== 'string' || !Array.isArray(site.origins)) continue;
      let local = db.all('SELECT * FROM source_address_sites WHERE source_id=? AND path=?', source.id, site.path).find(candidate =>
        site.origins.some((o: any) => typeof o?.origin === 'string' && db.get('SELECT 1 FROM source_address_origins WHERE source_id=? AND site_id=? AND origin=?', source.id, candidate.site_id, o.origin)));
      if (!local && typeof value.base === 'string') {
        try {
          const previous = new URL(value.base), current = new URL(installed);
          if (previous.pathname === site.path && current.pathname === site.path && site.origins.some((o: any) => o.origin === previous.origin))
            local = db.get('SELECT s.* FROM source_address_sites s JOIN source_address_state a USING(source_id,site_id) WHERE s.source_id=? AND s.path=?', source.id, site.path);
        } catch {}
      }
      // Match the upstream observation rule: only a not-yet-used origin can
      // advance an unchanged installation. A retired address cannot undo rollback.
      if (local && value.base === installed && site.origins.some((o: any) => o.origin === site.active_origin && o.used === 1)
        && !db.get('SELECT used FROM source_address_origins WHERE source_id=? AND site_id=? AND origin=?',source.id,local.site_id,site.active_origin)?.used
        && db.get('SELECT site_id FROM source_address_state WHERE source_id=?',source.id)?.site_id === local.site_id)
        db.run('UPDATE source_address_sites SET active_origin=? WHERE source_id=? AND site_id=?',site.active_origin,source.id,local.site_id);
      const id = local?.site_id ?? site.site_id;
      db.run('INSERT OR IGNORE INTO source_address_sites VALUES(?,?,?,?)', source.id, id, site.path, site.active_origin);
      for (const origin of site.origins) if (typeof origin?.origin === 'string' && [0, 1].includes(origin.used)) db.run('INSERT INTO source_address_origins VALUES(?,?,?,?) ON CONFLICT(source_id,site_id,origin) DO UPDATE SET used=MAX(used,excluded.used)', source.id, id, origin.origin, origin.used);
    }
    // A new device starts with the exported installation before moving to the
    // currently installed version. Existing devices keep their observed state.
    if (!db.get('SELECT 1 FROM source_address_state WHERE source_id=?', source.id)) {
      const base = typeof value.base === 'string' ? value.base : installed;
      let site: any;
      try {
        const url = new URL(base);
        site = db.get('SELECT s.site_id FROM source_address_sites s JOIN source_address_origins o USING(source_id,site_id) WHERE s.source_id=? AND s.path=? AND o.origin=?',source.id,url.pathname,url.origin);
      } catch {}
      if (site) db.run('INSERT INTO source_address_state VALUES(?,?,?)',source.id,base,site.site_id);
      else identities.sync(source.id,base);
    }
    identities.sync(source.id, installed);
    for (const alias of value.aliases) if (['raw','origin','resource'].every(k => typeof alias?.[k] === 'string')) db.run('INSERT OR IGNORE INTO source_work_alias VALUES(?,?,?,?,?)', source.id, row.media_id, alias.raw, alias.origin, alias.resource);
    const raw = db.get('SELECT url FROM source_media WHERE media_id=?', row.media_id)?.url;
    if (raw) identities.work(source.id, row.media_id, raw, installed, false);
  }
  for (const row of db.all('SELECT a.*,e.media_id FROM lite_episode_identity a JOIN episodes e ON e.id=a.episode_id')) {
    let value: any; try { value = JSON.parse(row.value); } catch { continue; }
    if (!Array.isArray(value.aliases)) continue;
    for (const alias of value.aliases) if (['raw','origin','resource'].every(k => typeof alias?.[k] === 'string')) db.run('INSERT OR IGNORE INTO source_episode_alias VALUES(?,?,?,?,?)', row.media_id, row.episode_id, alias.raw, alias.origin, alias.resource);
  }
  for (const row of db.all('SELECT m.*,s.installed_entry,s.entry FROM source_media m JOIN source_entries s ON s.id=m.source_id')) {
    const base = JSON.parse(row.installed_entry || row.entry).baseUrl || '';
    identities.work(row.source_id,row.media_id,row.url,base,false);
    for (const episode of db.all('SELECT x.* FROM source_episodes x JOIN episodes e ON e.id=x.episode_id WHERE e.media_id=?',row.media_id)) identities.episode(row.media_id,episode.episode_id,episode.url,base,false);
  }

}
