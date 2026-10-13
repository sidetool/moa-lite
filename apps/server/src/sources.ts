import { SourceIdentities } from './source-identity.js';
import { isInlineHls } from './inline-hls.js';
import { SourceQueue, type SourceLane } from './source-queue.js';
import { CacheStats } from './cache-stats.js';
import { DetailPolicy } from './detail-policy.js';
import { SourceReadCache } from './source-cache.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ApkBridge, apkIconUrl, type ApkEntry, type ExtractedVideos } from './apk-bridge.js';
import { parseSeason } from '@moa/subtitles-ko';
import { createHash } from 'node:crypto';
import { publicUrl, parseOutboundProxy, compatibilityHttp, fetchRepository, fetchExtension, invokeMangayomi, preferenceSchema, trimPreferenceState, validatePreferenceState, type MangayomiEntry, type PreferenceValues, type SourceItem, type SourcePage, type SourceVideo } from '@moa/extensions';
import type { MediaType, VideoSource, SourcePreference, BrowseSchema, BrowseSelection, SourceRemovalImpact, SourceRemovalResult } from '@moa/shared';
import { Store } from './db.js';
import { Catalog } from './catalog.js';
import { ApiFailure, now } from './util.js';
const key = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const webUrl = (value: unknown, base: string) => { try { if (!text(value, 8192)) return undefined; const u = new URL(text(value, 8192), base || undefined); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export class Sources {
  private removing = new Set<string>();
  private reading = new Map<string, Set<Promise<unknown>>>();
  private async trackRead<T>(id:string, task:()=>Promise<T>):Promise<T> {
    if(this.removing.has(id))return Promise.reject(new ApiFailure(409,'source-removing'));
    const readers=this.reading.get(id)||new Set<Promise<unknown>>();this.reading.set(id,readers);
    const work=task().finally(()=>{readers.delete(work);if(!readers.size)this.reading.delete(id);});
    readers.add(work);return work;
  }
  private queues = new SourceQueue();
  private abort = new AbortController();
  private reads: SourceReadCache;
  readonly stats = new CacheStats();
  private details: DetailPolicy;
  private identities: SourceIdentities;
  private navigationRevision = new Map<string,number>();
  private failedNavigation = new Map<string,{source:string;until:number}>();
  constructor(public db: Store, public catalog: Catalog, private runtime = invokeMangayomi, private fetchCode = fetchExtension, private fetchRegistry = fetchRepository, public apk = new ApkBridge()) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS server_network(id INTEGER PRIMARY KEY CHECK(id=1),proxy TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_entries(id TEXT PRIMARY KEY,repository TEXT NOT NULL,entry TEXT NOT NULL,installed_entry TEXT,code TEXT,sha256 TEXT,preferences TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 0,type TEXT NOT NULL DEFAULT 'series',live INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_media(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES source_entries(id),url TEXT NOT NULL,detail_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_episodes(episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_images(id TEXT PRIMARY KEY,url TEXT NOT NULL,headers TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_image_owners(source_id TEXT NOT NULL REFERENCES source_entries(id),image_id TEXT NOT NULL REFERENCES source_images(id) ON DELETE CASCADE,PRIMARY KEY(source_id,image_id));
      INSERT OR IGNORE INTO source_image_owners SELECT s.source_id,i.id FROM source_media s JOIN media m ON m.id=s.media_id JOIN source_images i ON '/api/images/' || i.id=json_extract(m.metadata,'$.poster');
      CREATE TABLE IF NOT EXISTS source_repositories(url TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 1,checked_at TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS source_backups(source_id TEXT PRIMARY KEY REFERENCES source_entries(id),entry TEXT NOT NULL,code TEXT NOT NULL,sha256 TEXT NOT NULL,preferences TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_apk(source_id TEXT PRIMARY KEY REFERENCES source_entries(id),package_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_apk_removals(package_id TEXT PRIMARY KEY,repository TEXT NOT NULL,pkg TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_health(source_id TEXT PRIMARY KEY REFERENCES source_entries(id),ok INTEGER NOT NULL,checked_at TEXT NOT NULL,action TEXT NOT NULL,code TEXT);
      CREATE INDEX IF NOT EXISTS source_media_source ON source_media(source_id);
      INSERT OR IGNORE INTO source_repositories(url) SELECT DISTINCT repository FROM source_entries;`);
    if(!db.all('PRAGMA table_info(source_repositories)').some(r=>r.name==='kind')) db.db.exec("ALTER TABLE source_repositories ADD COLUMN kind TEXT NOT NULL DEFAULT 'mangayomi-js'");
    this.reads = new SourceReadCache(db,this.abort.signal,Date.now,undefined,this.stats);
    this.details = new DetailPolicy(db);
    this.identities = new SourceIdentities(db);
  }
  network() {
    const row = this.db.get('SELECT * FROM server_network WHERE id=1');
    return { defaultProxy: row?.proxy || '', revision: row?.revision || 0 };
  }
  proxy() { return this.network().defaultProxy || undefined; }
  saveNetwork(proxy: string, revision: number) {
    let value: string; try { value = parseOutboundProxy(proxy) || ''; } catch { throw new ApiFailure(400,'invalid-proxy-address'); }
    if (this.network().revision !== revision) throw new ApiFailure(409,'network-settings-conflict');
    this.db.run('INSERT OR REPLACE INTO server_network VALUES(1,?,?)',value,revision+1);
    this.reads.clear(); this.db.run('DELETE FROM source_detail_observations'); this.db.run('UPDATE source_media SET detail_at=0');
    return this.network();
  }
  async testNetwork(proxy: string) {
    let value: string | undefined; try { value = parseOutboundProxy(proxy); } catch { throw new ApiFailure(400,'invalid-proxy-address'); }
    const repository = this.repositories().find(r => r.kind === 'mangayomi-js');
    if (!repository) return { ok: false, skipped: true, elapsedMs: 0 };
    const start = Date.now();
    try { const entries = await this.fetchRegistry(repository.url,AbortSignal.timeout(15_000),value); return { ok: true, elapsedMs: Date.now()-start, sources: entries.length }; }
    catch { throw new ApiFailure(502,'proxy-connection-failed'); }
  }
  list(): VideoSource[] {
    return this.db.all('SELECT * FROM source_entries WHERE code IS NOT NULL OR repository IN (SELECT url FROM source_repositories WHERE active=1) ORDER BY enabled DESC,id').map(r => { const e: MangayomiEntry = JSON.parse(r.entry); const backup = this.db.get('SELECT entry FROM source_backups WHERE source_id=?',r.id), health=this.db.get('SELECT * FROM source_health WHERE source_id=?',r.id); return { rollbackVersion:backup ? JSON.parse(backup.entry).version : undefined, health:health ? {ok:Boolean(health.ok),checkedAt:health.checked_at,action:health.action,code:health.code || undefined} : undefined, kind: (e as any).format === 'aniyomi-apk' ? 'aniyomi-apk' : 'mangayomi-js', id: r.id, iconUrl: this.sourceIcon(r.id,r.repository,e), name: e.name, version: e.version, installedVersion: r.installed_entry ? JSON.parse(r.installed_entry).version : undefined, installed: Boolean(r.code), enabled: Boolean(r.enabled), type: r.type, live: Boolean(r.live), repository: r.repository, lang: e.lang, notes: e.notes }; });
  }
  repositories() { return this.db.all('SELECT url,kind,checked_at AS checkedAt,error FROM source_repositories WHERE active=1 ORDER BY url'); }
  private repositoryUrl(value:string) { try{return publicUrl(value);}catch{throw new ApiFailure(400,'invalid-repository-url');} }
  removeRepository(value:string) {
    const url=this.repositoryUrl(value);
    return this.serial('repository:'+url,async()=>{this.db.run('UPDATE source_repositories SET active=0 WHERE url=?',url);return this.repositories();});
  }
  async refresh(value: string, kind?: 'mangayomi-js' | 'aniyomi-apk') {
    const url=this.repositoryUrl(value);
    return this.serial('repository:'+url,async()=>{
      const saved = this.db.get('SELECT kind FROM source_repositories WHERE url=?',url)?.kind;
      if (saved && kind && saved !== kind && this.db.get('SELECT 1 FROM source_entries WHERE repository=?',url)) throw new ApiFailure(409,'repository-kind-conflict');
      const format = kind || saved || 'mangayomi-js';
      this.db.run('INSERT INTO source_repositories(url,active,kind) VALUES(?,1,?) ON CONFLICT(url) DO UPDATE SET active=1,kind=excluded.kind',url,format);
      let entries;
      try {
        entries=format === 'aniyomi-apk' ? await this.apk.registry(url,this.abort.signal,this.proxy()) : await this.fetchRegistry(url,this.abort.signal,this.proxy());
      }
      catch(error){this.db.run('UPDATE source_repositories SET error=? WHERE url=?','목록을 가져오지 못했습니다. 주소와 프록시 설정을 확인해 주세요.',url);throw error;}
      this.db.transaction(()=>{
        for(const entry of entries) this.db.run(`INSERT INTO source_entries(id,repository,entry,type,live) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry`,entry.format === 'aniyomi-apk' ? key(url,entry.package.pkg,entry.id) : this.jsSourceId(url,entry),url,JSON.stringify(entry),/애니|anime/i.test(entry.name + ' ' + url)?'anime':/영화|movie/i.test(entry.name)?'movie':'series',/\b(?:iptv|live ?tv)\b|라이브/i.test(entry.name)?1:0);
        this.db.run('UPDATE source_repositories SET checked_at=?,error=NULL WHERE url=?',now(),url);
      });
      return this.list();
    });
  }
  private jsSourceId(repository: string, entry: MangayomiEntry): string {
    // Preserve pre-language IDs and all attached history/preferences when refreshing older installations.
    const legacy=key(repository,entry.id), row=this.db.get('SELECT entry FROM source_entries WHERE id=?',legacy);
    if(row && (JSON.parse(row.entry).lang || 'all') === (entry.lang || 'all')) return legacy;
    return key(repository,entry.id,entry.lang || 'all');
  }
  private sourceIcon(id: string, repository: string, entry: MangayomiEntry | ApkEntry) {
    const candidate=entry.iconUrl || (entry.format === 'aniyomi-apk' ? apkIconUrl(repository,entry.package.pkg) : undefined);
    if(!candidate)return undefined;
    let url:string;try{url=publicUrl(candidate);}catch{return undefined;}
    return this.image(id,url,{});
  }
  row(id: string, installed = true) {
    const row = this.db.get('SELECT * FROM source_entries WHERE id=?', id);
    if (!row || installed && (!row.code || !row.enabled)) throw new ApiFailure(404, 'source-unavailable');
    return row;
  }
  async serial<T>(id: string, task: () => Promise<T>, lane: SourceLane = 'exclusive'): Promise<T> {
    if (this.removing.has(id)) throw new ApiFailure(409, 'source-removing');
    // APK packages share native worker state and retain their exclusive package lane.
    if (lane !== 'exclusive' && JSON.parse(this.row(id).installed_entry || this.row(id).entry).format === 'aniyomi-apk') lane = 'exclusive';
    try { return await this.queues.run(id, lane, () => { this.abort.signal.throwIfAborted(); return task(); }); }
    catch (error) { if (error instanceof Error && error.message === 'source-busy') throw new ApiFailure(429,'source-busy'); throw error; }
  }
  private removalIds(ids: string[]) {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (id === 'local') throw new ApiFailure(400, 'local-source-protected');
      this.row(id, false);
      if (this.removing.has(id)) throw new ApiFailure(409, 'source-removing');
    }
    return unique;
  }
  removalImpact(ids: string[]): SourceRemovalImpact {
    return this.impact(this.removalIds(ids));
  }
  private impact(ids: string[]): SourceRemovalImpact {
    const media = new Set(this.db.all('SELECT media_id,source_id FROM source_media').filter(r => ids.includes(r.source_id)).map(r => r.media_id));
    const episodes = new Set(this.db.all('SELECT id,media_id FROM episodes').filter(r => media.has(r.media_id)).map(r => r.id));
    const progress = this.db.all('SELECT profile_id,episode_id FROM progress').filter(r => episodes.has(r.episode_id));
    const watchlist = this.db.all('SELECT profile_id,media_id FROM watchlist').filter(r => media.has(r.media_id));
    const profiles = new Set([...progress, ...watchlist].map(r => r.profile_id));
    if (this.db.get("SELECT 1 FROM sqlite_master WHERE name='title_group_overrides'"))
      for (const r of this.db.all('SELECT profile_id,media_id FROM title_group_overrides')) if (media.has(r.media_id)) profiles.add(r.profile_id);
    for (const r of this.db.all('SELECT id,value FROM settings')) {
      const tabs = JSON.parse(r.value).navigation as import('@moa/shared').NavigationTab[] | undefined;
      if (tabs?.some(t => t.sourceIds.some(id => ids.includes(id)) || Object.keys(t.sourceFilters || {}).some(id => ids.includes(id)))) profiles.add(r.id);
    }
    return { mediaCount: media.size, episodeCount: episodes.size, progressCount: progress.length, watchlistCount: watchlist.length, profilesAffected: profiles.size };
  }
  async remove(ids: string[], cleanup: (episodeIds: Set<string>, imageIds: Set<string>) => Promise<void> = async () => {}): Promise<SourceRemovalResult> {
    const unique = this.removalIds(ids);
    for (const id of unique) this.removing.add(id);
    try {
      // Drain already accepted work and reject new work until deletion and session cleanup finish.
      await Promise.allSettled(unique.flatMap(id => [...(this.reading.get(id)||[]), this.queues.drain(id)]));
      await Promise.all(unique.map(id=>this.reads.drain(id)));
      const impact = this.impact(unique), episodes = new Set<string>(), images = new Set<string>();
      const packages = unique.flatMap(id => {
        const row = this.db.get('SELECT a.package_id,s.repository,s.installed_entry,s.entry FROM source_apk a JOIN source_entries s ON s.id=a.source_id WHERE s.id=?',id);
        return row ? [{ id: row.package_id, repository: row.repository, pkg: JSON.parse(row.installed_entry || row.entry).package.pkg }] : [];
      });
      this.db.transaction(() => {
        // Durable cleanup intent survives an unavailable worker and can be retried by removal.
        for (const p of packages) this.db.run('INSERT OR REPLACE INTO source_apk_removals VALUES(?,?,?)',p.id,p.repository,p.pkg);
        for (const id of unique) {
          this.identities.clear(id);
          for (const e of this.db.all('SELECT e.id FROM episodes e JOIN source_media s ON s.media_id=e.media_id WHERE s.source_id=?', id)) episodes.add(e.id);
          for (const image of this.db.all('SELECT image_id FROM source_image_owners WHERE source_id=?', id)) images.add(image.image_id);
          this.db.run('DELETE FROM source_image_owners WHERE source_id=?', id);
          this.db.run('DELETE FROM media WHERE id IN (SELECT media_id FROM source_media WHERE source_id=?)', id);
          this.db.run('DELETE FROM source_backups WHERE source_id=?', id);
          this.db.run('DELETE FROM source_apk WHERE source_id=?', id);
          this.db.run('DELETE FROM source_health WHERE source_id=?', id);
          this.db.run("UPDATE source_entries SET code=NULL,installed_entry=NULL,sha256=NULL,preferences='{}',enabled=0 WHERE id=?", id);
          this.invalidate(id);
        }
        this.db.removeNavigationSources(new Set(unique));
        // Images may be shared by several sources; retain any still referenced by a catalog item.
        for (const image of images) this.db.run("DELETE FROM source_images WHERE id=? AND NOT EXISTS (SELECT 1 FROM source_image_owners WHERE image_id=source_images.id) AND NOT EXISTS (SELECT 1 FROM media WHERE instr(metadata, '/api/images/' || source_images.id)>0) AND NOT EXISTS (SELECT 1 FROM episodes WHERE instr(COALESCE(thumb,''), '/api/images/' || source_images.id)>0)", image);
      });
      await cleanup(episodes, new Set([...images].filter(id => !this.db.get('SELECT 1 FROM source_images WHERE id=?', id))));
      // The sources are already gone; an unavailable worker only delays cleanup to the next removal.
      for (const p of this.db.all('SELECT * FROM source_apk_removals')) await this.serial('apk:'+p.repository+':'+p.pkg, async () => {
        // Recheck under the same package lock as install: another sibling may have installed meanwhile.
        const referenced = this.db.get('SELECT 1 FROM source_apk a JOIN source_entries s ON s.id=a.source_id WHERE a.package_id=? AND s.code IS NOT NULL',p.package_id);
        if (!referenced) await this.apk.remove(p.package_id);
        this.db.run('DELETE FROM source_apk_removals WHERE package_id=?',p.package_id);
      }).catch(() => {});
      return { removedIds: unique, impact };
    } finally { for (const id of unique) this.removing.delete(id); }
  }
  async install(id: string) {
    return this.serial(id, async () => {
      const row = this.row(id, false), entry = JSON.parse(row.entry);
      if (entry.format === 'aniyomi-apk') return this.serial('apk:'+row.repository+':'+entry.package.pkg, async () => {
        const record = await this.apk.install(entry,row.repository,this.abort.signal,this.proxy());
        // Some indexes advertise IDs that differ from IDs calculated inside the APK.
        // Match only an exact, unique name+language within the verified package; never fuzzy-match.
        const descriptorFor = (candidate: ApkEntry) => {
          const exact = record.sources.find((source:any)=>source.id===candidate.id);
          if(exact) return exact;
          const named = record.sources.filter((source:any)=>source.name===candidate.name && source.lang===candidate.lang);
          return named.length===1 ? named[0] : undefined;
        };
        const actual = descriptorFor(entry);
        if (!actual) throw new ApiFailure(502,'apk-source-missing');
        this.db.transaction(() => {
          this.db.run('DELETE FROM source_apk_removals WHERE package_id=?',record.id);
          // One APK can expose several sources. Update existing siblings as one package version.
          const siblings = this.db.all('SELECT s.* FROM source_entries s JOIN source_apk a ON a.source_id=s.id WHERE a.package_id=?',record.id);
          for (const r of [...siblings.filter(r=>r.id!==id),row]) {
            const old = JSON.parse(r.entry), descriptor = descriptorFor(old);
            if (!descriptor) { this.db.run('UPDATE source_entries SET enabled=0 WHERE id=?',r.id); continue; }
            const installed = { ...old, ...descriptor, version:record.metadata.version, package:entry.package };
            this.db.run("UPDATE source_entries SET code='@aniyomi-apk',sha256=?,installed_entry=?,enabled=? WHERE id=?",record.digest,JSON.stringify(installed),r.id===id?1:r.enabled,r.id);
            this.db.run('INSERT OR REPLACE INTO source_apk VALUES(?,?)',r.id,record.id); this.db.run('DELETE FROM source_health WHERE source_id=?',r.id); this.invalidate(r.id);
          }
        });
        return this.list().find(s=>s.id===id)!;
      });
      const fetched = await this.fetchCode(entry, this.abort.signal, this.proxy());
      // Validate the new guest before replacing a working installation. No listing or playback request is made.
      await this.runtime({entry,source:fetched.source,preferences:JSON.parse(row.preferences),action:'filters',outboundProxy:this.proxy(),signal:this.abort.signal});
      this.db.transaction(() => {
        if(row.code && (row.sha256 !== fetched.sha256 || JSON.parse(row.installed_entry).version !== entry.version)) this.db.run('INSERT OR REPLACE INTO source_backups VALUES(?,?,?,?,?)',id,row.installed_entry,row.code,row.sha256 || '',row.preferences);
        this.identities.sync(id,JSON.parse(row.installed_entry || row.entry).baseUrl);
        this.identities.sync(id,entry.baseUrl);
        this.db.run('UPDATE source_entries SET code=?,sha256=?,installed_entry=?,enabled=1 WHERE id=?', fetched.source, fetched.sha256, row.entry, id);
      });
      this.invalidate(id); return this.list().find(s => s.id === id)!;
    });
  }
  rollback(id:string) {
    return this.serial(id,async()=>{
      this.row(id,false);
      const backup=this.db.get('SELECT * FROM source_backups WHERE source_id=?',id);
      if(!backup) throw new ApiFailure(409,'source-no-backup');
      this.db.transaction(()=>{
        this.identities.sync(id,JSON.parse(this.row(id,false).installed_entry).baseUrl);
        this.identities.sync(id,JSON.parse(backup.entry).baseUrl,true);
        this.db.run('UPDATE source_entries SET code=?,sha256=?,installed_entry=?,preferences=? WHERE id=?',backup.code,backup.sha256,backup.entry,backup.preferences,id);
        this.db.run('DELETE FROM source_backups WHERE source_id=?',id);
        this.db.run('DELETE FROM source_health WHERE source_id=?',id);
      });
      this.invalidate(id);return this.list().find(s=>s.id===id)!;
    });
  }
  async diagnose(id:string,profile:string) {
    this.row(id); this.invalidate(id);
    try { await this.browse(id,profile,'popular',1,''); }
    catch(error) { this.recordHealth(id,false,'check',error); }
    return this.list().find(s=>s.id===id)!;
  }
  private recordHealth(id:string,ok:boolean,action:string,error?:unknown) {
    if (!this.db.get('SELECT 1 FROM source_entries WHERE id=? AND code IS NOT NULL',id)) return;
    const raw=error instanceof Error ? error.message : '';
    const code = /apk_(reprepare_required|cache_integrity|not_installed)|apk-installation-missing/.test(raw) ? 'preparation-required' : /timeout|timed.?out/i.test(raw) ? 'timeout' : /cloudflare|403|captcha/i.test(raw) ? 'access-denied' : /proxy|connect|fetch|network/i.test(raw) ? 'connection-failed' : /unsupported|not implemented/i.test(raw) ? 'unsupported' : 'source-error';
    this.db.run('INSERT OR REPLACE INTO source_health VALUES(?,?,?,?,?)',id,Number(ok),now(),action,ok ? null : code);
  }
  invalidate(id: string) {
    this.navigationRevision.set(id,(this.navigationRevision.get(id)||0)+1);
    for(const [key,value] of this.failedNavigation)if(value.source===id)this.failedNavigation.delete(key); this.reads.invalidate(id); this.details.invalidateSource(id); this.db.run('UPDATE source_media SET detail_at=0 WHERE source_id=?', id); }
  configure(id: string, values: { enabled?: boolean; type?: MediaType; live?: boolean }) {
    const r = this.row(id, false);
    if (!r.code) throw new ApiFailure(409, 'source-not-installed');
    this.db.transaction(() => {
      this.db.run('UPDATE source_entries SET enabled=?,type=?,live=? WHERE id=?', Number(values.enabled ?? Boolean(r.enabled)), values.type || r.type, Number(values.live ?? Boolean(r.live)), id);
      if (values.enabled === false) this.db.removeNavigationSources(new Set([id]), false);
      for (const m of this.db.all('SELECT m.* FROM media m JOIN source_media s ON s.media_id=m.id WHERE s.source_id=?', id)) {
        const meta = JSON.parse(m.metadata); meta.live = values.live ?? Boolean(r.live);
        this.db.run('UPDATE media SET type=?,metadata=? WHERE id=?', values.type || m.type, JSON.stringify(meta), m.id);
      }
    });
    this.invalidate(id); return this.list().find(s => s.id === id)!;
  }
  private async call(id: string, action: string, params: Record<string, unknown> = {}) {
    const r = this.row(id), preferences: PreferenceValues = JSON.parse(r.preferences);
    const entry = JSON.parse(r.installed_entry || r.entry);
    const operation = action === 'list' ? (params.mode === 'search' || params.query ? 'search' : 'list') : action === 'detail' || action === 'videos' || action === 'filters' ? action : undefined;
    if (entry.format === 'aniyomi-apk') return this.serial('apk:'+r.repository+':'+entry.package.pkg, async () => {
      const mapping = this.db.get('SELECT package_id FROM source_apk WHERE source_id=?',id);
      if (!mapping) throw new ApiFailure(409,'apk-installation-missing');
      try { if(operation)this.stats.external(id,operation); const result = await this.apk.call(mapping.package_id,entry,action,params,this.proxy(),this.abort.signal); this.recordHealth(id,true,action); return result; }
      catch(error) { this.recordHealth(id,false,action,error); throw error; }
    });
    let result;
    try { if(operation)this.stats.external(id,operation); result = await this.runtime({ entry: JSON.parse(r.installed_entry), source: r.code, preferences, action, params, outboundProxy: this.proxy(), signal: this.abort.signal }); } catch(error) {this.recordHealth(id,false,action,error);throw error;}
    if(['list','detail','videos'].includes(action)) this.recordHealth(id,true,action);
    // Calls have independent guest processes. Commit only their delta against current storage;
    // another lane may have finished since this invocation read its preferences snapshot.
    this.db.transaction(() => {
      const latest = JSON.parse(this.row(id).preferences);
      const updated = trimPreferenceState({ ...latest, ...result.changes }, Object.keys(result.changes ?? {}));
      validatePreferenceState(updated);
      this.db.run('UPDATE source_entries SET preferences=? WHERE id=?', JSON.stringify(updated), id);
    });
    return result.result;
  }
  async preferences(id: string, changes?: Record<string, unknown>): Promise<SourcePreference[]> {
    return this.serial(id, async () => {
      const row = this.row(id), entry = JSON.parse(row.installed_entry);
      if (entry.format === 'aniyomi-apk') return this.serial('apk:'+row.repository+':'+entry.package.pkg, async () => {
        const mapping = this.db.get('SELECT package_id FROM source_apk WHERE source_id=?',id);
        if (!mapping) throw new ApiFailure(409,'apk-installation-missing');
        const result = await this.apk.preferences(mapping.package_id,entry,changes); if(changes) this.invalidate(id); return result;
      });
      const schema = preferenceSchema(await this.call(id, 'preferences'));
      if (changes) {
        if (Object.keys(changes).some(k => !schema.some(p => p.key === k))) throw new ApiFailure(400, 'invalid-source-preference');
        for (const p of schema) if (Object.hasOwn(changes, p.key)) {
          const v = changes[p.key];
          if (p.kind === 'boolean' ? typeof v !== 'boolean' : p.kind === 'select' ? !p.choices?.some(c => c.value === v) : p.kind === 'multi-select' ? !Array.isArray(v) || v.some(x => !p.choices?.some(c => c.value === x)) : typeof v !== 'string' || v.length > 8192) throw new ApiFailure(400, 'invalid-source-preference');
        }
        const state = { ...JSON.parse(this.row(id).preferences), ...changes }; validatePreferenceState(state);
        this.db.run('UPDATE source_entries SET preferences=? WHERE id=?', JSON.stringify(state), id); this.invalidate(id);
      }
      const state = JSON.parse(this.row(id).preferences);
      return schema.map(p => { const v = state[p.key] ?? p.value; return { ...p, value: p.secret ? undefined : v, configured: p.secret ? Boolean(v) : undefined }; });
    });
  }
  private image(sourceId: string, url: string | undefined, headers: Record<string,string>) {
    if (!url) return undefined;
    const id = 'source-' + key(url, JSON.stringify(headers));
    this.db.run('INSERT OR IGNORE INTO source_images VALUES(?,?,?)', id,url,JSON.stringify(headers));
    this.db.run('INSERT OR IGNORE INTO source_image_owners VALUES(?,?)', sourceId, id);
    return `/api/images/${id}`;
  }
  async imageContent(id: string) {
    const row = this.db.get('SELECT * FROM source_images WHERE id=?',id);
    if (!row) throw new ApiFailure(404,'image-not-found');
    const result = await compatibilityHttp({url:row.url,headers:JSON.parse(row.headers)},this.abort.signal,[],8*1024*1024,this.proxy());
    if (result.statusCode !== 200) throw new ApiFailure(502,'image-unavailable');
    return result.bytes;
  }
  private putItem(sourceId: string, item: SourceItem, knownId?: string) {
    const r = this.row(sourceId), entry: MangayomiEntry = JSON.parse(r.installed_entry);
    if (!item || !text(item.name) || !text(item.link, 16_384)) return null;
    // These extension navigation cards contain instructions rather than playable media.
    if (/(?:^|\/)__[^/]*(?:card|divider|guide)__\//.test(item.link)) return null;
    if (item.link.startsWith('{')) { try { if (JSON.parse(item.link).weekdayCard) return null; } catch {} }
    const exactId = 'remote-' + key(sourceId, item.link);
    const id = knownId ?? this.identities.findWork(sourceId,item.link,entry.baseUrl) ?? exactId;
    const old = this.db.get('SELECT title,type,metadata FROM media WHERE id=?', id);
    const meta = { ...JSON.parse(old?.metadata || '{}'), ...('adult' in item && typeof item.adult === 'boolean' ? { adult: item.adult } : {}), provider: { id: sourceId, name: entry.name, lang: entry.lang, kind: (entry as unknown as ApkEntry).format === 'aniyomi-apk' ? 'aniyomi-apk' : 'mangayomi-js' }, live: Boolean(r.live), ...(item.imageUrl ? { poster: this.image(sourceId, webUrl(item.imageUrl, entry.baseUrl), { Referer: entry.baseUrl, ...(item.imageHeaders || {}) }) } : {}), ...(item.description ? { overview: text(item.description, 20_000) } : {}), ...(Array.isArray(item.genre) ? { genres: item.genre.filter(g => typeof g === 'string').slice(0, 50) } : {}) };
    let title = item.name.slice(0,500);
    const shortened = /(?:\.{3}|…)\s*$/.test(title);
    if (shortened && old?.title && !/(?:\.{3}|…)\s*$/.test(old.title) && old.title.startsWith(title.replace(/(?:\.{3}|…)\s*$/,''))) title = old.title;
    // Prefer explicit media types; otherwise infer only a canonical leading category segment.
    let category: string | undefined;
    try { category = new URL(item.link, entry.baseUrl || 'https://example.invalid').pathname.split('/')[1]?.toLowerCase(); } catch {}
    const inferred = /^(anime|animation)$/.test(category || '') ? 'anime' : /^movies?$/.test(category || '') ? 'movie' : /^(dramas?|tv|series)$/.test(category || '') ? 'series' : undefined;
    const type = ['anime','movie','series'].includes(item.type || '') ? item.type : inferred || old?.type || r.type;
    this.db.run(`INSERT INTO media VALUES(?,NULL,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,type=excluded.type,metadata=excluded.metadata`, id, title, type, JSON.stringify(meta), now());
    this.identities.work(sourceId,id,item.link,entry.baseUrl);
    const previous=this.db.get('SELECT url FROM source_media WHERE media_id=?',id)?.url;
    const url=previous && this.identities.navigationUrl(sourceId,item.link,entry.baseUrl)===previous?previous:item.link;
    this.db.run('INSERT INTO source_media(media_id,source_id,url) VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET url=excluded.url', id, sourceId, url);
    return id;
  }
  private async navigationCall(id: string, action: 'detail'|'videos', url: string, params: Record<string,unknown> = {}) {
    const row=this.row(id), entry=JSON.parse(row.installed_entry || row.entry);
    const revision=this.navigationRevision.get(id)||0;
    const current=()=>{
      this.abort.signal.throwIfAborted();
      if(this.removing.has(id) || (this.navigationRevision.get(id)||0)!==revision)throw new ApiFailure(409,'source-changed');
      const latest=this.row(id);
      if(latest.installed_entry!==row.installed_entry || latest.sha256!==row.sha256)throw new ApiFailure(409,'source-changed');
    };
    const resolved=this.identities.navigationUrl(id,url,entry.baseUrl);
    const field=action==='detail'?'workUrl':'episodeUrl', failureKey=key(id,action,url,resolved);
    const invoke=async(value:string)=>{
      current();
      const result=await (action==='detail'?this.readCall(id,action,{...params,[field]:value}):this.call(id,action,{...params,[field]:value}));
      try { current(); } catch(error) { if(action==='videos')void this.apk.release((result as ExtractedVideos)?.apkLease);throw error; }
      return result;
    };
    if(resolved!==url && (this.failedNavigation.get(failureKey)?.until||0)<=Date.now()) {
      try {
        const result=await invoke(resolved);
        const valid=action==='detail'?Array.isArray((result as SourceItem)?.chapters):Array.isArray(result) && result.some(v=>v && typeof v.url==='string' && (v.url.startsWith('edl://') || webUrl(v.url,'') || isInlineHls(v.url)));
        if(valid)return {result,url:resolved,current};
        if(action==='videos')void this.apk.release((result as ExtractedVideos)?.apkLease);
      } catch(error) { current(); }
      // Bound both retry count and repeated failures without storing raw signed URLs.
      if(this.failedNavigation.size>=1024)this.failedNavigation.delete(this.failedNavigation.keys().next().value!);
      this.failedNavigation.set(failureKey,{source:id,until:Date.now()+5*60_000});
    }
    return {result:await invoke(url),url,current};
  }
  private async readCall(id:string,action:string,params:Record<string,unknown>={}) {
    const started=Date.now();
    try { return await this.call(id,action,params); }
    catch(error) {
      const code=error instanceof Error?error.message:'';
      // One quick retry for a transient read failure; never replay installation, settings or extraction.
      if(Date.now()-started>1500 || !/^(source_connection_failed|source-busy|execution_busy|apk_worker_busy|apk_network_failed|ECONNRESET|EPIPE)$/.test(code))throw error;
      await delay(250,undefined,{signal:this.abort.signal});return this.call(id,action,params);
    }
  }
  // Filter positions can change at the source; coalesce concurrent reads but always revalidate.
  private async schema(id: string): Promise<BrowseSchema> {
    if (this.removing.has(id)) return Promise.reject(new ApiFailure(409, 'source-removing'));
    this.row(id);
    return this.reads.read(id,'schema',{freshMs:0,staleMs:0,background:false,fallback:false,cache:false},current=>this.serial(id,async()=>{
      current();
      const schema = await this.schemaValue(id); current(); return schema;
    }, 'background'));
  }
  private async schemaValue(id:string):Promise<BrowseSchema> {
    const raw=await this.readCall(id,'filters') as {browse:Omit<BrowseSchema,'revision'>};
    if(!raw?.browse || !Array.isArray(raw.browse.filters))throw new ApiFailure(502,'source-filters-unavailable');
    const {filters,availableModes}=raw.browse;
    return {filters,availableModes,revision:key(this.row(id).sha256||'',JSON.stringify(filters))};
  }
  capabilities(id: string) { return this.trackRead(id,()=>this.schema(id)); }
  private async checkFilters(id: string, selection: BrowseSelection, definition?:BrowseSchema) {
    const schema = definition || await this.schema(id);
    if (selection.revision !== schema.revision) throw new ApiFailure(409, 'source-filters-changed');
    const seen = new Set<string>();
    for (const change of selection.filters) {
      const f = schema.filters.find(f => f.position === change.position && f.groupPosition === change.groupPosition);
      const k = `${change.position}:${change.groupPosition ?? ''}`, v = change.value;
      const index = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < (f?.options?.length || 0);
      if (!f || seen.has(k) || !(f.kind === 'select' ? index(v) : f.kind === 'sort' ? typeof v === 'object' && v && index(v.index) && typeof v.ascending === 'boolean' : f.kind === 'checkbox' ? typeof v === 'boolean' : f.kind === 'text' ? typeof v === 'string' && v.length <= 2000 : f.kind === 'tri_state' && ['IGNORE','INCLUDE','EXCLUDE'].includes(String(v)))) throw new ApiFailure(400, 'invalid-source-filters');
      if (/탭 저장|Popular\/Latest 규칙/.test(f.label) && v !== f.defaultValue) throw new ApiFailure(400,'source-global-filter-action');
      seen.add(k);
    }
  }
  browse(id: string, profile: string, mode = 'popular', page = 1, query = '', selection?: BrowseSelection) {
    return this.trackRead(id,()=>this.browseRead(id,profile,mode,page,query,selection));
  }
  private async browseRead(id: string, profile: string, mode: string, page: number, query: string, selection?: BrowseSelection) {
    if (this.removing.has(id)) throw new ApiFailure(409, 'source-removing');
    this.row(id);
    // Validation also shares its schema read. Do it outside the source lane to avoid nested queue waits.
    if(selection)await this.checkFilters(id,selection);
    if(query || selection?.filters.length)mode='search';
    const cacheKey='browse:'+key(mode,String(page),query,JSON.stringify(selection||null));
    const result=await this.reads.read(id,cacheKey,{freshMs:mode==='search'?6*60*60_000:5*60_000,staleMs:mode==='search'?24*60*60_000:60*60_000,operation:mode==='search'?'search':'list'},current=>this.serial(id,async()=>{
      current();this.row(id);
      // A preference update can enter the lane after the first validation. Check again before using positional values.
      if(selection)await this.checkFilters(id,selection,await this.schemaValue(id));
      current();
      const raw=await this.readCall(id,'list',{mode,page,query,filters:selection?.filters||[]}) as SourcePage;
      current();this.row(id);
      if(!raw || !Array.isArray(raw.list))throw new ApiFailure(502,'source-invalid-response');
      const ids:string[]=[];
      this.db.transaction(()=>{for(const item of raw.list.slice(0,500)){const mid=this.putItem(id,item);if(mid&&!ids.includes(mid))ids.push(mid);}});
      return {ids,more:Boolean(raw.hasNextPage)};
    }, 'background'));
    this.row(id);
    const ids=result.ids.filter(mid=>this.db.get('SELECT 1 FROM media WHERE id=?',mid));
    return {items:this.catalog.kids.filter(ids.map(id=>({id})),profile).map(({id:mid})=>this.catalog.card(this.db.get('SELECT * FROM media WHERE id=?',mid)!,profile)),page,hasNextPage:result.more};
  }
  detail(id:string) {
    const mapping=this.db.get('SELECT source_id FROM source_media WHERE media_id=?',id);
    return mapping?this.trackRead(mapping.source_id,()=>this.detailRead(id)):Promise.resolve();
  }
  private async detailRead(id: string) {
    const mapping = this.db.get('SELECT * FROM source_media WHERE media_id=?', id);
    if (!mapping) return;
    if (this.removing.has(mapping.source_id)) throw new ApiFailure(409, 'source-removing');
    this.row(mapping.source_id);
    const cacheKey='detail:'+id;
    // Reuse successful details from before the persistent shared cache migration.
    if(mapping.detail_at>0)this.reads.prime(mapping.source_id,cacheKey,true,mapping.detail_at);
    return this.reads.read(mapping.source_id,cacheKey,this.details.policy(id),current=>this.serial(mapping.source_id, async () => {
      current();const row = this.row(mapping.source_id);
      const entry = JSON.parse(row.installed_entry || row.entry);
      const title=this.db.get('SELECT title FROM media WHERE id=?',id)?.title||'';
      const currentUrl=this.db.get('SELECT url FROM source_media WHERE media_id=?',id)!.url;
      const navigation=await this.navigationCall(mapping.source_id,'detail',currentUrl,{title});
      const raw = navigation.result as SourceItem;
      current();this.row(mapping.source_id);
      if (!raw || !Array.isArray(raw.chapters)) throw new ApiFailure(502, 'source-invalid-response');
      let chapters = raw.chapters.slice(0, 10_000).filter(e => text(e.url, 16_384));
      if (JSON.parse(row.installed_entry || row.entry)?.format === 'aniyomi-apk' && row.type === 'movie') {
        // Movie entries are often trailers plus the feature, not chronological episodes.
        const priority = (name:string) => /본편|full movie/i.test(name) ? 0 : /예고|티저|티져|trailer|teaser/i.test(name) ? 2 : 1;
        chapters = [...chapters].sort((a,b)=>priority(a.name)-priority(b.name)).map((e,i)=>({...e,number:i+1}));
      }
      // Mangayomi chapters normally arrive newest first. Explicit numbers preserve specials and gaps.
      const parsed = chapters.map((e, i) => { const n = /(?:^|\s|제)(\d+(?:\.\d+)?)\s*(?:화|회|편|話|화\b)|(?:episode|ep\.?|e)\s*(\d+)/i.exec(e.name); return { e, n: typeof (e as any).number === 'number' && (e as any).number >= 0 ? (e as any).number : n ? Number(n[1] || n[2]) : chapters.length - i }; });
      const media = this.db.get('SELECT * FROM media WHERE id=?', id)!;
      this.db.transaction(() => {
        this.putItem(mapping.source_id, { ...raw, name: raw.name || media.title, link: navigation.url }, id);
        this.identities.detailAlias(mapping.source_id,id,navigation.url,raw.link,entry.baseUrl);
        if (!row.live && chapters.length === 1 && /영화|movie|film|본편/i.test(mapping.url + ' ' + (raw.genre || []).join(' ') + ' ' + chapters[0].name)) this.db.run("UPDATE media SET type='movie' WHERE id=?", id);
        const observed = new Map<string,number>();
        for (const { e, n } of parsed) {
          const exactId = 'remote-' + key(id, e.url);
          const eid = this.identities.findEpisode(id,e.url,entry.baseUrl) || exactId;
          this.db.run(`INSERT INTO episodes VALUES(?,?,?,?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET season=excluded.season,number=excluded.number,title=excluded.title`, eid, id, parseSeason(raw.name || media.title) ?? 1, n, text(e.name) || `${n}화`);
          this.identities.episode(id,eid,e.url,entry.baseUrl);
          const previous=this.db.get('SELECT url FROM source_episodes WHERE episode_id=?',eid)?.url;
          const url=previous && this.identities.navigationUrl(mapping.source_id,e.url,entry.baseUrl)===previous?previous:e.url;
          this.db.run('INSERT OR REPLACE INTO source_episodes VALUES(?,?)', eid, url);
          observed.set(eid,n);
        }
        // Mangayomi JSON completed=1; Aniyomi SAnime completed=2.
        const apk = JSON.parse(row.installed_entry || row.entry).format === 'aniyomi-apk';
        this.details.observe(id, [...observed].map(([episodeId,number])=>({id:episodeId,number})), raw.status === (apk ? 2 : 1));
        this.db.run('UPDATE source_media SET detail_at=? WHERE media_id=?', Date.now(), id);
      });
      return true;
    }, 'interactive'));
  }
  remoteEpisode(episodeId: string) { return this.db.get('SELECT s.source_id,s.media_id,e.url FROM source_episodes e JOIN episodes ep ON ep.id=e.episode_id JOIN source_media s ON s.media_id=ep.media_id WHERE e.episode_id=?', episodeId); }
  async videos(episodeId: string) {
    const source = this.remoteEpisode(episodeId); if (!source) throw new ApiFailure(404, 'episode-not-found');
    return this.serial(source.source_id, async () => {
      const mapping=this.remoteEpisode(episodeId); if(!mapping)throw new ApiFailure(404,'episode-not-found');
      const navigation=await this.navigationCall(mapping.source_id,'videos',mapping.url);
      const videos = navigation.result as ExtractedVideos;
      try { navigation.current(); } catch(error) { void this.apk.release(videos?.apkLease);throw error; }
      if (!Array.isArray(videos)) throw new ApiFailure(502, 'source-invalid-response');
      const filtered: ExtractedVideos = videos.filter(v => v && typeof v.url === 'string' && (v.url.startsWith('edl://') || webUrl(v.url, '') || isInlineHls(v.url))).slice(0, 32);
      if (videos.length && !filtered.length) {
        // No playback session will own this lease when all returned formats are rejected.
        if (videos.apkLease) void this.apk.release(videos.apkLease);
        throw new ApiFailure(502, 'unsupported-stream-format');
      }
      if(filtered.length && navigation.url!==mapping.url)this.db.transaction(()=>{
        const entry=JSON.parse(this.row(mapping.source_id).installed_entry);
        this.identities.episode(mapping.media_id,episodeId,mapping.url,entry.baseUrl,false);
        this.identities.episode(mapping.media_id,episodeId,navigation.url,entry.baseUrl,false);
        this.db.run('UPDATE source_episodes SET url=? WHERE episode_id=? AND url=?',navigation.url,episodeId,mapping.url);
      });
      filtered.apkLease = videos.apkLease; return filtered;
    }, 'interactive');
  }
  async close() { this.abort.abort(); await Promise.allSettled([...this.reading.values()].flatMap(readers=>[...readers])); await this.reads.drain(); await this.queues.drain(); }
}
