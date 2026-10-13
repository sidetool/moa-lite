import { randomBytes } from 'node:crypto';
import type { Store } from './db.js';

type Address = { origin: string; resource: string; pathname: string };
type Site = { site_id: string; path: string; active_origin: string };
function baseAddress(value: string): Address | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return { origin: url.origin, resource: url.pathname, pathname: url.pathname };
  } catch { return; }
}
function address(value: string, base: string): Address | undefined {
  if (typeof value !== 'string' || !value || /^[\s{\[]/.test(value)) return;
  const absolute = /^https?:\/\//i.test(value);
  // Bare IDs and non-HTTP schemes are extension-owned, not relative URLs.
  if (!absolute && (!/^(?:\/|\.\.?\/|[?#])/.test(value) && !/^[^:\s]+\//.test(value) || /^[^/?#]*:/.test(value))) return;
  try {
    const url = absolute ? new URL(value) : new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    return { origin: url.origin, resource: url.pathname + url.search + url.hash, pathname: url.pathname };
  } catch { return; }
}
const within = (pathname: string, prefix: string) => prefix === '/' || pathname === prefix || pathname.startsWith(prefix.replace(/\/$/, '') + '/');
function numericFamily(origin: string) {
  const url = new URL(origin);
  return /\d+(?=\.)/.test(url.hostname) ? url.protocol + '//' + url.hostname.replace(/\d+(?=\.)/, '{n}') + ':' + url.port : undefined;
}
const baseOf = (row: any) => { try { return JSON.parse(row.installed_entry || row.entry).baseUrl || ''; } catch { return ''; } };

/** IDs never change. Raw aliases are retained independently from the selected network address. */
export class SourceIdentities {
  constructor(private db: Store) {
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS source_address_state(source_id TEXT PRIMARY KEY REFERENCES source_entries(id) ON DELETE CASCADE,base_url TEXT NOT NULL,site_id TEXT);
      CREATE TABLE IF NOT EXISTS source_address_sites(source_id TEXT NOT NULL REFERENCES source_entries(id) ON DELETE CASCADE,site_id TEXT NOT NULL,path TEXT NOT NULL,active_origin TEXT NOT NULL,PRIMARY KEY(source_id,site_id));
      CREATE TABLE IF NOT EXISTS source_address_origins(source_id TEXT NOT NULL,site_id TEXT NOT NULL,origin TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,site_id,origin),FOREIGN KEY(source_id,site_id) REFERENCES source_address_sites(source_id,site_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_work_alias(source_id TEXT NOT NULL REFERENCES source_entries(id) ON DELETE CASCADE,media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,raw TEXT NOT NULL,origin TEXT NOT NULL,resource TEXT NOT NULL,PRIMARY KEY(media_id,raw,origin));
      CREATE INDEX IF NOT EXISTS source_work_alias_raw ON source_work_alias(source_id,raw);
      CREATE INDEX IF NOT EXISTS source_work_alias_path ON source_work_alias(source_id,resource,origin);
      CREATE TABLE IF NOT EXISTS source_episode_alias(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,raw TEXT NOT NULL,origin TEXT NOT NULL,resource TEXT NOT NULL,PRIMARY KEY(episode_id,raw,origin));
      CREATE INDEX IF NOT EXISTS source_episode_alias_raw ON source_episode_alias(media_id,raw);
      CREATE INDEX IF NOT EXISTS source_episode_alias_path ON source_episode_alias(media_id,resource,origin);
      CREATE TABLE IF NOT EXISTS source_identity_migrations(name TEXT PRIMARY KEY);`);
    if (!db.get("SELECT 1 FROM source_identity_migrations WHERE name='aliases-v2'")) db.transaction(() => {
      for (const row of db.all('SELECT * FROM source_entries WHERE installed_entry IS NOT NULL')) this.sync(row.id, baseOf(row));
      // Do not promote the old PR's numeric-family tables to verified domain transitions.
      for (const row of db.all('SELECT m.*,s.installed_entry,s.entry FROM source_media m JOIN source_entries s ON s.id=m.source_id')) this.work(row.source_id,row.media_id,row.url,baseOf(row),false);
      for (const row of db.all('SELECT x.*,e.media_id,s.installed_entry,s.entry FROM source_episodes x JOIN episodes e ON e.id=x.episode_id JOIN source_media m ON m.media_id=e.media_id JOIN source_entries s ON s.id=m.source_id')) this.episode(row.media_id,row.episode_id,row.url,baseOf(row),false);
      db.run("INSERT INTO source_identity_migrations VALUES('aliases-v2')");
    });
  }
  /** Call with installed metadata only, never the uninstalled repository entry. */
  sync(source: string, base: string, force=false) {
    base = typeof base === 'string' ? base : '';
    const state = this.db.get('SELECT * FROM source_address_state WHERE source_id=?',source);
    if (state?.base_url === base && !force) return;
    if (!state && !this.db.get('SELECT 1 FROM source_entries WHERE id=?',source)) return;
    const next = baseAddress(base), previous = baseAddress(state?.base_url || '');
    let site: string | null = null;
    if (next) {
      // A base-path change is not evidence that two different catalogues are identical.
      site = this.db.get('SELECT s.site_id FROM source_address_sites s JOIN source_address_origins o USING(source_id,site_id) WHERE s.source_id=? AND s.path=? AND o.origin=?',source,next.pathname,next.origin)?.site_id ?? (previous && previous.pathname === next.pathname ? state?.site_id : null);
      site ??= randomBytes(12).toString('hex');
      this.db.run('INSERT INTO source_address_sites VALUES(?,?,?,?) ON CONFLICT(source_id,site_id) DO UPDATE SET active_origin=excluded.active_origin',source,site,next.pathname,next.origin);
      // A real installation transition retires previously observed addresses as well.
      this.db.run('UPDATE source_address_origins SET used=1 WHERE source_id=? AND site_id=?',source,site);
      this.db.run('INSERT INTO source_address_origins VALUES(?,?,?,1) ON CONFLICT(source_id,site_id,origin) DO UPDATE SET used=1',source,site,next.origin);
    }
    this.db.run('INSERT OR REPLACE INTO source_address_state VALUES(?,?,?)',source,base,site);
  }
  /** Match only known namespaces, plus the existing numbered-host compatibility rule. */
  private site(source: string, value: Address, base: string, discover=true): Site | undefined {
    this.sync(source,base);
    const sites = this.db.all('SELECT * FROM source_address_sites WHERE source_id=? ORDER BY length(path) DESC',source) as Site[];
    for (const site of sites) if (within(value.pathname,site.path) && this.db.get('SELECT 1 FROM source_address_origins WHERE source_id=? AND site_id=? AND origin=?',source,site.site_id,value.origin)) return site;
    const state = this.db.get('SELECT site_id FROM source_address_state WHERE source_id=?',source);
    const current = sites.find(s=>s.site_id===state?.site_id);
    const family = numericFamily(value.origin);
    if (discover && current && within(value.pathname,current.path) && family && this.db.all('SELECT origin FROM source_address_origins WHERE source_id=? AND site_id=?',source,current.site_id).some(row=>numericFamily(row.origin)===family)) {
      this.db.run('INSERT OR IGNORE INTO source_address_origins VALUES(?,?,?,0)',source,current.site_id,value.origin);
      return current;
    }
  }
  private origins(source: string, value: Address, base: string) {
    const site = this.site(source,value,base);
    return site ? this.db.all('SELECT origin FROM source_address_origins WHERE source_id=? AND site_id=?',source,site.site_id).map(row=>row.origin as string) : [value.origin];
  }
  private find(kind: 'work'|'episode', owner: string, source: string, raw: string, base: string): string | undefined {
    const table=kind==='work'?'source_work_alias':'source_episode_alias', scope=kind==='work'?'source_id':'media_id', id=kind==='work'?'media_id':'episode_id';
    const exact=this.db.all(`SELECT DISTINCT ${id} AS id FROM ${table} WHERE ${scope}=? AND raw=? LIMIT 2`,owner,raw);
    if(exact.length)return exact.length===1?exact[0].id:undefined;
    const value=address(raw,base); if(!value)return;
    const origins=this.origins(source,value,base);
    const rows=this.db.all(`SELECT DISTINCT ${id} AS id FROM ${table} WHERE ${scope}=? AND resource=? AND origin IN (${origins.map(()=>'?').join(',')}) LIMIT 2`,owner,value.resource,...origins);
    return rows.length===1?rows[0].id:undefined;
  }
  findWork(source: string, raw: string, base: string) { this.sync(source,base);return this.find('work',source,source,raw,base); }
  findEpisode(media: string, raw: string, base: string) {
    const source=this.db.get('SELECT source_id FROM source_media WHERE media_id=?',media)?.source_id;
    return source?this.find('episode',media,source,raw,base):undefined;
  }
  work(source: string, media: string, raw: string, base: string, observe=true) {
    this.sync(source,base);
    const value=address(raw,base), site=value && this.site(source,value,base);
    this.db.run('INSERT OR IGNORE INTO source_work_alias VALUES(?,?,?,?,?)',source,media,raw,value?.origin || '',value?.resource || raw);
    if(observe && value && site)this.observe(source,value,site);
  }
  private observe(source: string, value: Address, site: Site) {
    const seen=this.db.get('SELECT used FROM source_address_origins WHERE source_id=? AND site_id=? AND origin=?',source,site.site_id,value.origin);
    // Fresh unseen origins can become candidates in either numeric direction.
    // A retired origin from a stale response cannot undo installation/rollback.
    if(!seen?.used) {
      this.db.run('UPDATE source_address_sites SET active_origin=? WHERE source_id=? AND site_id=?',value.origin,source,site.site_id);
      this.db.run('UPDATE source_address_origins SET used=1 WHERE source_id=? AND site_id=? AND origin=?',source,site.site_id,value.origin);
    }
  }
  episode(media: string, episode: string, raw: string, base: string, observe=true) {
    const value=address(raw,base);
    this.db.run('INSERT OR IGNORE INTO source_episode_alias VALUES(?,?,?,?,?)',media,episode,raw,value?.origin || '',value?.resource || raw);
    const source=this.db.get('SELECT source_id FROM source_media WHERE media_id=?',media)?.source_id;
    const site=value && source && this.site(source,value,base);
    if(observe && value && site)this.observe(source,value,site);
  }
  /** A successful detail call establishes a work-local alias, not a source-wide migration. */
  detailAlias(source: string, media: string, requested: string, returned: unknown, base: string) {
    if(typeof returned!=='string' || !returned || returned.length>16384)return;
    const from=address(requested,base), to=address(returned,base);
    if(!from || !to || from.resource!==to.resource)return;
    this.work(source,media,returned,base,false);
  }
  navigationUrl(source: string, raw: string, base: string): string {
    this.sync(source,base);
    if(!/^https?:\/\//i.test(raw))return raw;
    const value=address(raw,base); if(!value)return raw;
    const site=this.site(source,value,base,false);
    if(!site || site.active_origin===value.origin || /^https:/i.test(raw) && site.active_origin.startsWith('http:'))return raw;
    // Backfilled URLs may be newer than a static manifest. Keep them until an
    // actual observed/installed transition establishes that their origin retired.
    if(!this.db.get('SELECT used FROM source_address_origins WHERE source_id=? AND site_id=? AND origin=?',source,site.site_id,value.origin)?.used)return raw;
    return raw.replace(/^https?:\/\/[^/?#]+/i,site.active_origin);
  }
  clear(source: string) {
    this.db.run('DELETE FROM source_episode_alias WHERE media_id IN (SELECT media_id FROM source_media WHERE source_id=?)',source);
    this.db.run('DELETE FROM source_work_alias WHERE source_id=?',source);
    this.db.run('DELETE FROM source_address_state WHERE source_id=?',source);
    this.db.run('DELETE FROM source_address_sites WHERE source_id=?',source);
  }
}
