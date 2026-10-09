import { parseSeason } from '@moa/subtitles-ko';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Settings, NavigationTab } from '@moa/shared';

export const DEFAULT_SETTINGS: Settings = { groupHistory: true, autoplayNext: true, autoplayDelay: 5, defaultSubtitleLang: 'ko', subtitleSize: 'medium', preferredQuality: 'auto', hardwareTranscoding: true, autoFetchSubtitles: true, translationMode: 'manual', translationSourcePriority: 'site', skipSubtitleSearchWithSiteTrack: true, skipTranslationWithoutSubtitles: true };
export class Store {
  db: DatabaseSync;
  constructor(dataDir: string, database?: DatabaseSync) {
    mkdirSync(dataDir, { recursive: true });
    this.db = database ?? new DatabaseSync(path.join(dataDir, 'moa.db'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,kids INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,type TEXT NOT NULL,label TEXT NOT NULL,last_scan_at TEXT);
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,title TEXT NOT NULL,type TEXT NOT NULL,metadata TEXT NOT NULL,added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,season INTEGER NOT NULL,number INTEGER NOT NULL,title TEXT NOT NULL,duration REAL NOT NULL,thumb TEXT);
      CREATE TABLE IF NOT EXISTS files(episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,fingerprint TEXT NOT NULL,probe TEXT NOT NULL,subtitles TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress(profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,position REAL NOT NULL,duration REAL NOT NULL,completed INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(profile_id,episode_id));
      CREATE TABLE IF NOT EXISTS watchlist(profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,media_id TEXT REFERENCES media(id) ON DELETE CASCADE,added_at TEXT NOT NULL,PRIMARY KEY(profile_id,media_id));
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,path TEXT NOT NULL,local INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enrichment_cache(key TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS media_titles(media_id TEXT REFERENCES media(id) ON DELETE CASCADE,season INTEGER NOT NULL,original_title TEXT NOT NULL,title TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(media_id,season));
      CREATE TABLE IF NOT EXISTS online_subtitles(id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,creator_name TEXT NOT NULL,source_url TEXT NOT NULL,format TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,token TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(episode_id,creator_name,content_hash));
      CREATE TABLE IF NOT EXISTS episode_skip_markers(episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,source TEXT NOT NULL,markers TEXT NOT NULL,file_path TEXT NOT NULL,file_size INTEGER NOT NULL,file_mtime REAL NOT NULL,revision TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(episode_id,source));
      CREATE TABLE IF NOT EXISTS skip_analysis_jobs(season_key TEXT PRIMARY KEY,media_id TEXT REFERENCES media(id) ON DELETE CASCADE,season INTEGER NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,phase TEXT,progress REAL NOT NULL DEFAULT 0,error TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tmdb_links(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,kind TEXT,tmdb_id INTEGER,season INTEGER,status TEXT NOT NULL,score REAL,checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tmdb_match_versions(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tmdb_titles(kind TEXT NOT NULL,tmdb_id INTEGER NOT NULL,card TEXT NOT NULL,detail TEXT NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(kind,tmdb_id));
      CREATE TABLE IF NOT EXISTS tmdb_seasons(tmdb_id INTEGER NOT NULL,season INTEGER NOT NULL,payload TEXT NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(tmdb_id,season));
      CREATE INDEX IF NOT EXISTS episodes_media ON episodes(media_id,season,number);
      CREATE INDEX IF NOT EXISTS progress_profile ON progress(profile_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS media_folder ON media(folder_id);`);
    this.transaction(() => {
      const columns = this.all<{ name: string }>('PRAGMA table_info(profiles)');
      if (!columns.some(c => c.name === 'account_id')) this.db.exec('ALTER TABLE profiles ADD COLUMN account_id TEXT');
      if (!columns.some(c => c.name === 'avatar')) this.db.exec('ALTER TABLE profiles ADD COLUMN avatar TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS profiles_account ON profiles(account_id); CREATE TABLE IF NOT EXISTS account_migrations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL)');
    });
  }
  claimProfiles(accountId: string) {
    this.transaction(() => {
      if (this.get("SELECT 1 FROM account_migrations WHERE id='legacy-profiles'")) return;
      this.run('UPDATE profiles SET account_id=? WHERE account_id IS NULL', accountId);
      this.run("INSERT INTO account_migrations VALUES('legacy-profiles',?)", accountId);
    });
  }
  all<T = Record<string, any>>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  get<T = Record<string, any>>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  transaction(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  settings(profile: string): Settings { return { ...DEFAULT_SETTINGS, ...JSON.parse(this.get('SELECT value FROM settings WHERE id=?', profile)?.value || '{}') }; }
  defaultNavigation(): NavigationTab[] | null {
    return JSON.parse(this.get("SELECT value FROM admin_settings WHERE key='default-navigation'")?.value || 'null');
  }
  saveDefaultNavigation(navigation: NavigationTab[] | null) {
    this.run("INSERT OR REPLACE INTO admin_settings VALUES('default-navigation',?)", JSON.stringify(navigation));
  }
  filterNavigation(navigation: NavigationTab[], removed: Set<string>): NavigationTab[] {
    return navigation.map(tab => ({ ...tab, sourceIds: tab.sourceIds.filter(id => !removed.has(id)),
      ...(tab.sourceFilters ? { sourceFilters: Object.fromEntries(Object.entries(tab.sourceFilters).filter(([id]) => !removed.has(id))) } : {}) }));
  }
  availableNavigation(navigation: NavigationTab[]): NavigationTab[] {
    const enabled = new Set(this.all('SELECT id FROM source_entries WHERE code IS NOT NULL AND enabled=1').map(r => r.id));
    return this.filterNavigation(navigation, new Set(navigation.flatMap(t => [...t.sourceIds, ...Object.keys(t.sourceFilters || {})]).filter(id => !enabled.has(id))));
  }
  removeNavigationSources(ids: Set<string>, profiles = true) {
    if (profiles) for (const row of this.all('SELECT id,value FROM settings')) {
      const settings: Settings = JSON.parse(row.value);
      if (settings.navigation) this.run('UPDATE settings SET value=? WHERE id=?', JSON.stringify({ ...settings, navigation: this.filterNavigation(settings.navigation, ids) }), row.id);
    }
    const defaults = this.defaultNavigation();
    if (defaults) this.saveDefaultNavigation(this.filterNavigation(defaults, ids));
  }
  displayTitle(mediaId: string, original: string, season?: number): string {
    season = parseSeason(original) ?? season;
    return this.get(`SELECT title FROM media_titles WHERE media_id=? AND original_title=? ${season === undefined ? '' : 'AND season=?'} ORDER BY season DESC LIMIT 1`, mediaId, original, ...(season === undefined ? [] : [season]))?.title || original;
  }
  close() { this.db.close(); }
}
