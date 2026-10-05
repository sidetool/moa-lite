import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TranslationConfig, TranslationJob, SubtitleTrack } from '@moa/shared';
import { Store } from '../db.js';
import { Catalog } from '../catalog.js';
import { ApiFailure } from '../util.js';
import { Gemini, MODEL, validModel, validGeminiKey } from './gemini.js';
import { subtitleDocument, nextBatch, translatedRanges, type Document } from './subtitle.js';

interface Secret {
  apiKeys: string[];
  model: string;
  enabled: boolean;
  batchSize: number;
  requestIntervalMs: number;
  retryCount: number;
}
interface Job extends TranslationJob {
  profile: string;
  key: string;
  touched: number;
  sourceUrl?: string;
  priorityAt?: number;
}
interface Work {
  key: string;
  document: Document;
  title: string;
  language: string;
  model: string;
  batchSize: number;
  controller: AbortController;
  subscribers: Set<string>;
  cursor: number;
  first: boolean;
  priorities: Map<string, number>;
}
interface Cache {
  key: string;
  format: 'ass' | 'vtt';
  chunks: string;
  content: string | null;
  complete: number;
  revision: number;
  ranges: string;
  touched: number;
}
interface Asset {
  profile: string;
  episode: string;
  key: string;
  touched: number;
}
const LIMIT = 200 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Manual, shared work queue. Only validated cue text is sent to Gemini. */
export class Translations {
  private secret: Secret;
  private filename: string;
  private jobs = new Map<string, Job>();
  private work = new Map<string, Work>();
  private assets = new Map<string, Asset>();
  private active?: Promise<void>;
  private closed = false;
  private cooldown = new Map<string, number>();
  private preferredKey = 0;
  private lastTranslationFinishedAt = 0;
  private janitor: NodeJS.Timeout;
  constructor(
    private db: Store,
    private catalog: Catalog,
    dataDir: string,
    private gemini = new Gemini(),
  ) {
    this.filename = path.join(dataDir, 'translation-secret.json');
    this.secret = { apiKeys: [], model: MODEL, enabled: false, batchSize: 120, requestIntervalMs: 1000, retryCount: 2 };
    try {
      const saved = JSON.parse(readFileSync(this.filename, 'utf8'));
      const keys = (Array.isArray(saved.apiKeys) ? saved.apiKeys : saved.apiKey ? [saved.apiKey] : [])
        .filter(validGeminiKey)
        .slice(0, 8);
      if (validModel(saved.model))
        this.secret = {
          apiKeys: keys,
          model: saved.model,
          enabled: saved.enabled === true && keys.length > 0,
          batchSize:
            Number.isInteger(saved.batchSize) && saved.batchSize >= 10 && saved.batchSize <= 300
              ? saved.batchSize
              : 120,
          requestIntervalMs: Number.isInteger(saved.requestIntervalMs) && saved.requestIntervalMs >= 0 && saved.requestIntervalMs <= 60000 ? saved.requestIntervalMs : 1000,
          retryCount: Number.isInteger(saved.retryCount) && saved.retryCount >= 0 && saved.retryCount <= 5 ? saved.retryCount : 2,
        };
      chmodSync(this.filename, 0o600);
    } catch (error: any) {
      this.secret = { apiKeys: [], model: MODEL, enabled: false, batchSize: 120, requestIntervalMs: 1000, retryCount: 2 };
      if (error.code !== 'ENOENT') console.warn('translation-config-unreadable: translation disabled');
    }
    db.db
      .exec(`CREATE TABLE IF NOT EXISTS translation_cache(key TEXT PRIMARY KEY,format TEXT NOT NULL,chunks TEXT NOT NULL,content TEXT,touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS translated_subtitles(episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,cache_key TEXT NOT NULL REFERENCES translation_cache(key) ON DELETE CASCADE,created_at INTEGER NOT NULL,source_url TEXT,PRIMARY KEY(episode_id,cache_key));`);
    if (!db.all('PRAGMA table_info(translated_subtitles)').some((row) => row.name === 'source_url'))
      db.db.exec('ALTER TABLE translated_subtitles ADD COLUMN source_url TEXT');
    const columns = new Set(db.all('PRAGMA table_info(translation_cache)').map(row => row.name));
    db.transaction(() => {
      if (!columns.has('complete')) {
        db.db.exec('ALTER TABLE translation_cache ADD COLUMN complete INTEGER NOT NULL DEFAULT 0');
        db.db.exec('UPDATE translation_cache SET complete=1 WHERE content IS NOT NULL');
      }
      if (!columns.has('revision')) db.db.exec('ALTER TABLE translation_cache ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('ranges')) db.db.exec("ALTER TABLE translation_cache ADD COLUMN ranges TEXT NOT NULL DEFAULT '[]'");
    });
    this.janitor = setInterval(() => this.prune(), 60000);
    this.janitor.unref();
    this.prune();
  }
  config(): TranslationConfig {
    return {
      configured: !!this.secret.apiKeys.length,
      enabled: this.secret.enabled,
      model: this.secret.model,
      batchSize: this.secret.batchSize,
      requestIntervalMs: this.secret.requestIntervalMs,
      retryCount: this.secret.retryCount,
      keys: this.secret.apiKeys.map((key, i) => ({
        id: digest(key).slice(0, 16),
        label: `키 ${i + 1} · …${key.slice(-4)}`,
      })),
    };
  }
  configure(update: {
    apiKey?: string;
    model?: string;
    enabled?: boolean;
    clearKey?: boolean;
    batchSize?: number;
    requestIntervalMs?: number;
    retryCount?: number;
    addKeys?: string[];
    removeKeyIds?: string[];
  }): TranslationConfig {
    const next = { ...this.secret, apiKeys: [...this.secret.apiKeys] };
    if (update.apiKey !== undefined) {
      const key = update.apiKey.trim();
      if (!validGeminiKey(key)) throw new ApiFailure(400, 'translation-key-invalid');
      next.apiKeys = [key];
    }
    if (update.clearKey) next.apiKeys = [];
    if (update.removeKeyIds)
      next.apiKeys = next.apiKeys.filter((key) => !update.removeKeyIds!.includes(digest(key).slice(0, 16)));
    for (const input of update.addKeys || []) {
      const key = input.trim();
      if (!validGeminiKey(key)) throw new ApiFailure(400, 'translation-key-invalid');
      if (!next.apiKeys.includes(key)) next.apiKeys.push(key);
    }
    if (next.apiKeys.length > 8) throw new ApiFailure(400, 'translation-too-many-keys');
    if (update.batchSize !== undefined) {
      if (!Number.isInteger(update.batchSize) || update.batchSize < 10 || update.batchSize > 300)
        throw new ApiFailure(400, 'translation-batch-invalid');
      next.batchSize = update.batchSize;
    }
    for (const field of ['requestIntervalMs', 'retryCount'] as const) {
      const value = update[field], max = field === 'requestIntervalMs' ? 60000 : 5;
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > max) throw new ApiFailure(400, 'translation-config-invalid');
      next[field] = value;
    }
    if (update.model !== undefined) {
      if (!validModel(update.model)) throw new ApiFailure(400, 'translation-model-invalid');
      next.model = update.model;
    }
    if (update.enabled !== undefined) next.enabled = update.enabled;
    if (!next.apiKeys.length) next.enabled = false;
    writeFileSync(this.filename + '.tmp', JSON.stringify(next), { mode: 0o600 });
    chmodSync(this.filename + '.tmp', 0o600);
    renameSync(this.filename + '.tmp', this.filename);
    this.secret = next;
    this.cooldown.clear();
    this.preferredKey = 0;
    if (!next.enabled)
      for (const job of this.jobs.values())
        if (job.state === 'queued' || job.state === 'running') this.cancel(job.id, job.profile);
    return this.config();
  }
  async models(): Promise<{ models: string[] }> {
    if (!this.secret.apiKeys.length) throw new ApiFailure(400, 'translation-not-configured');
    return { models: await this.withKey((key) => this.gemini.models(key, AbortSignal.timeout(15000))) };
  }
  private async withKey<T>(operation: (key: string) => Promise<T>): Promise<T> {
    const keys = [...this.secret.apiKeys];
    let last: unknown = new ApiFailure(502, 'translation-quota');
    for (let offset = 0; offset < keys.length; offset++) {
      const index = (this.preferredKey + offset) % keys.length,
        key = keys[index];
      if ((this.cooldown.get(key) || 0) > Date.now()) {
        last = new ApiFailure(
          502,
          this.cooldown.get(key) === Infinity ? 'translation-key-invalid' : 'translation-quota',
        );
        continue;
      }
      try {
        const result = await operation(key);
        this.preferredKey = index;
        return result;
      } catch (error) {
        if (!(error instanceof ApiFailure) || !['translation-quota', 'translation-key-invalid'].includes(error.error))
          throw error;
        this.cooldown.set(key, error.error === 'translation-key-invalid' ? Infinity : Date.now() + 60000);
        last = error;
      }
    }
    throw last;
  }
  /** One shared worker serializes generation, including key failover and inter-job spacing. */
  private async translateWithRetry<T>(operation: (key: string) => Promise<T>, signal: AbortSignal): Promise<T> {
    const retryCount = this.secret.retryCount;
    const retryable = new Set(['translation-quota', 'translation-key-invalid', 'translation-unavailable', 'translation-invalid-response', 'translation-incomplete']);
    let last: unknown = new ApiFailure(502, 'translation-quota');
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      signal.throwIfAborted();
      const keys = this.secret.apiKeys;
      if (!keys.length || !this.secret.enabled) throw new ApiFailure(409, 'translation-cancelled');
      const ordered = Array.from({ length: keys.length }, (_, i) => (this.preferredKey + i) % keys.length);
      const index = ordered.find(i => (this.cooldown.get(keys[i]) || 0) <= Date.now())
        ?? ordered.filter(i => this.cooldown.get(keys[i]) !== Infinity).sort((a, b) => (this.cooldown.get(keys[a]) || 0) - (this.cooldown.get(keys[b]) || 0))[0];
      if (index === undefined) throw last instanceof ApiFailure && last.error !== 'translation-quota' ? last : new ApiFailure(502, 'translation-key-invalid');
      const key = keys[index];
      const wait = Math.max(0, this.lastTranslationFinishedAt + this.secret.requestIntervalMs - Date.now(), (this.cooldown.get(key) || 0) - Date.now());
      if (wait) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      // An admin may remove a key or disable translation while this request is waiting.
      if (!this.secret.enabled || !this.secret.apiKeys.includes(key)) throw new ApiFailure(409, 'translation-cancelled');
      try {
        const result = await operation(key);
        this.preferredKey = Math.max(0, this.secret.apiKeys.indexOf(key));
        return result;
      } catch (error) {
        last = error;
        if (!(error instanceof ApiFailure) || !retryable.has(error.error) || signal.aborted) throw error;
        if (error.error === 'translation-key-invalid' || error.error === 'translation-quota') {
          this.cooldown.set(key, error.error === 'translation-key-invalid' ? Infinity : Date.now() + 60000);
          this.preferredKey = (index + 1) % keys.length;
        }
      } finally {
        this.lastTranslationFinishedAt = Date.now();
      }
    }
    throw last;
  }
  private episode(id: string, profile: string) {
    const row = this.db.get(
      'SELECT e.media_id,m.title FROM episodes e JOIN media m ON m.id=e.media_id WHERE e.id=?',
      id,
    );
    if (!row) throw new ApiFailure(404, 'episode-not-found');
    if (!this.db.get('SELECT 1 FROM profiles WHERE id=?', profile)) throw new ApiFailure(401, 'profile-required');
    this.catalog.kids.assert(row.media_id, profile);
    return row;
  }
  start(
    episodeId: string,
    profile: string,
    input: { content: string; format: string; sourceLabel: string; sourceLanguage?: string; sourceUrl?: string; startAt?: number },
  ): TranslationJob {
    const episode = this.episode(episodeId, profile);
    this.validatePosition(input.startAt ?? 0);
    if (!this.secret.apiKeys.length) throw new ApiFailure(400, 'translation-not-configured');
    if (!this.secret.enabled || this.closed) throw new ApiFailure(409, 'translation-disabled');
    const document = subtitleDocument(input.content, input.format);
    const title = episode.title.slice(0, 300),
      language = (input.sourceLanguage || 'auto').slice(0, 32),
      model = this.secret.model;
    // Include the original bytes and context: different edits/offsets never share output.
    const key = digest(JSON.stringify(['ko-v1', input.content, document.format, title, language, model]));
    for (const job of this.jobs.values())
      if (
        job.key === key &&
        job.profile === profile &&
        job.episodeId === episodeId &&
        ['queued', 'running', 'completed'].includes(job.state)
      )
        return this.get(job.id, profile);
    this.prune();
    if (this.jobs.size >= 200) {
      const oldest = [...this.jobs.values()].filter(job => !['queued', 'running'].includes(job.state)).sort((a, b) => a.touched - b.touched)[0];
      if (oldest) this.jobs.delete(oldest.id);
      else throw new ApiFailure(429, 'translation-queue-full');
    }
    const cached = this.db.get<Cache>('SELECT * FROM translation_cache WHERE key=?', key);
    if (!(cached?.complete && cached.content) && !this.work.has(key) && this.work.size >= 20)
      throw new ApiFailure(429, 'translation-queue-full');
    if (
      !(cached?.complete && cached.content) &&
      [...this.jobs.values()].filter((j) => j.profile === profile && ['running', 'queued'].includes(j.state)).length >=
        3
    )
      throw new ApiFailure(429, 'translation-queue-full');
    const job: Job = {
      id: randomUUID(),
      profile,
      key,
      episodeId,
      state: cached?.complete && cached.content ? 'completed' : 'queued',
      done: cached?.complete && cached.content ? document.lines.length : Object.keys(JSON.parse(cached?.chunks || '{}')).length,
      total: document.lines.length,
      model,
      cached: !!(cached?.complete && cached.content),
      revision: cached?.revision || 0,
      partial: !cached?.complete,
      translatedRanges: JSON.parse(cached?.ranges || "[]"),
      touched: Date.now(),
      sourceUrl: input.sourceUrl,
    };
    this.jobs.set(job.id, job);
    if (cached?.complete && cached.content) this.link(job);
    else {
      let work = this.work.get(key);
      if (!work) {
        work = {
          key,
          document,
          title,
          language,
          model,
          batchSize: this.secret.batchSize,
          controller: new AbortController(),
          subscribers: new Set(),
          cursor: input.startAt ?? 0,
          first: true,
          priorities: new Map(),
        };
        this.work.set(key, work);
        this.db.run(
          'INSERT OR IGNORE INTO translation_cache(key,format,chunks,content,touched) VALUES(?,?,?,?,?)',
          key,
          document.format,
          '{}',
          null,
          Date.now(),
        );
      }
      if (work.subscribers.size && input.startAt !== undefined) work.priorities.set(job.id, input.startAt);
      work.subscribers.add(job.id);
      this.pump();
    }
    return this.get(job.id, profile);
  }
  get(id: string, profile: string): TranslationJob {
    const job = this.jobs.get(id);
    if (!job || job.profile !== profile) throw new ApiFailure(404, 'translation-job-not-found');
    this.episode(job.episodeId, profile);
    job.touched = Date.now();
    const { key, profile: _, touched, sourceUrl, priorityAt, ...result } = job;
    const cache = this.db.get<Cache>('SELECT * FROM translation_cache WHERE key=?', key);
    result.revision = cache?.revision || 0;
    result.partial = !cache?.complete;
    result.translatedRanges = JSON.parse(cache?.ranges || '[]');
    if (cache?.content) {
      result.track = this.track(job.episodeId, key, profile);
      if (sourceUrl) result.track.provenance = {creatorName: 'Jimaku', sourceUrl};
    }
    return result;
  }
  private validatePosition(startAt: number) {
    if (!Number.isFinite(startAt) || startAt < 0 || startAt > 864000) throw new ApiFailure(400, 'translation-position-invalid');
  }
  priority(id: string, profile: string, startAt: number) {
    this.validatePosition(startAt);
    this.get(id, profile);
    const job = this.jobs.get(id)!;
    if (!['queued','running'].includes(job.state)) return;
    if (job.priorityAt !== undefined && Date.now()-job.priorityAt < 2000) return;
    const work = this.work.get(job.key);
    if (!work || (!work.priorities.has(id) && work.priorities.size >= 20)) return;
    work.priorities.set(id, startAt);
    job.priorityAt = Date.now();
  }
  cancel(id: string, profile: string) {
    const job = this.jobs.get(id);
    if (!job || job.profile !== profile) throw new ApiFailure(404, 'translation-job-not-found');
    if (job.state !== 'queued' && job.state !== 'running') return;
    job.state = 'cancelled';
    job.touched = Date.now();
    const work = this.work.get(job.key);
    work?.subscribers.delete(id);
    work?.priorities.delete(id);
    if (work && !work.subscribers.size) {
      work.controller.abort();
      this.work.delete(job.key);
    }
  }
  removeProfile(profile: string) {
    for (const job of this.jobs.values())
      if (job.profile === profile) {
        this.cancel(job.id, profile);
        this.jobs.delete(job.id);
      }
    for (const [id, asset] of this.assets) if (asset.profile === profile) this.assets.delete(id);
  }
  private link(job: Job) {
    this.db.run(
      'INSERT OR IGNORE INTO translated_subtitles(episode_id,cache_key,created_at,source_url) VALUES(?,?,?,?)',
      job.episodeId,
      job.key,
      Date.now(),
      job.sourceUrl ?? null,
    );
    this.db.run('UPDATE translation_cache SET touched=? WHERE key=?', Date.now(), job.key);
  }
  private pump() {
    if (this.active || this.closed) return;
    const work = this.work.values().next().value as Work | undefined;
    if (!work) return;
    this.active = this.run(work).finally(() => {
      if (this.work.get(work.key) === work) this.work.delete(work.key);
      this.active = undefined;
      this.prune();
      this.pump();
    });
  }
  private async run(work: Work) {
    const update = (fields: Partial<Job>) => {
      for (const id of work.subscribers) {
        const job = this.jobs.get(id);
        if (job) Object.assign(job, fields, { touched: Date.now() });
      }
    };
    try {
      update({ state: 'running' });
      const row = this.db.get<Cache>('SELECT * FROM translation_cache WHERE key=?', work.key)!;
      const output: Record<string, string> = JSON.parse(row.chunks);
      while (Object.keys(output).length < work.document.lines.length) {
        const priority = work.priorities.entries().next().value;
        if (priority) { work.cursor = priority[1]; work.priorities.delete(priority[0]); }
        const batch = nextBatch(work.document.lines, output, work.cursor, work.first || priority ? Math.min(25,work.batchSize) : work.batchSize);
        work.first = false;
        if (!batch.length) break;
        if (work.controller.signal.aborted) throw new ApiFailure(409, 'translation-cancelled');
        const missing = batch.filter((line) => !output[line.id]);
        if (missing.length) {
          const previous = work.document.lines
            .filter((line) => line.id < missing[0].id && output[line.id])
            .slice(-6)
            .map((line) => ({ original: line.text.slice(0, 500), translation: output[line.id].slice(0, 500) }));
          const translated = await this.translateWithRetry((key) =>
            this.gemini.translate(
              key,
              work.model,
              missing,
              { title: work.title, sourceLanguage: work.language, previous },
              work.controller.signal,
            ),
            work.controller.signal,
          );
          if (work.controller.signal.aborted) throw new ApiFailure(409, 'translation-cancelled');
          Object.assign(output, translated);
          const content = work.document.render(output, true);
          if (Buffer.byteLength(content) > 4*1024*1024) throw new ApiFailure(413, 'translation-subtitle-too-large');
          work.cursor = Math.max(...batch.map(line => line.end));
          this.db.run(
            'UPDATE translation_cache SET chunks=?,content=?,revision=revision+1,ranges=?,touched=? WHERE key=?',
            JSON.stringify(output),
            content,
            JSON.stringify(translatedRanges(work.document.lines, output)),
            Date.now(),
            work.key,
          );
        }
        update({ state: 'running', done: Object.keys(output).length });
      }
      const content = work.document.render(output);
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new ApiFailure(413, 'translation-subtitle-too-large');
      this.db.run(
        'UPDATE translation_cache SET content=?,chunks=?,complete=1,touched=? WHERE key=?',
        content,
        '{}',
        Date.now(),
        work.key,
      );
      for (const id of work.subscribers) {
        const job = this.jobs.get(id);
        if (job && this.db.get('SELECT 1 FROM episodes WHERE id=?', job.episodeId)) {
          this.link(job);
          job.state = 'completed';
          job.done = job.total;
        }
      }
    } catch (error) {
      update({
        state: work.controller.signal.aborted ? 'cancelled' : 'failed',
        error: error instanceof ApiFailure ? error.error : 'translation-failed',
      });
    }
  }
  tracks(episode: string, profile: string): SubtitleTrack[] {
    this.episode(episode, profile);
    return this.db
      .all('SELECT cache_key FROM translated_subtitles WHERE episode_id=? ORDER BY created_at DESC LIMIT 8', episode)
      .map((row) => this.track(episode, row.cache_key, profile));
  }
  private track(episode: string, key: string, profile: string): SubtitleTrack {
    const row = this.db.get<Cache>('SELECT * FROM translation_cache WHERE key=? AND content IS NOT NULL', key);
    if (!row) throw new ApiFailure(404, 'translation-cache-expired');
    let id = [...this.assets].find(
      ([, asset]) => asset.profile === profile && asset.episode === episode && asset.key === key,
    )?.[0];
    if (!id) {
      if (this.assets.size >= 2000) {
        const oldest = [...this.assets].sort((a, b) => a[1].touched - b[1].touched)[0];
        this.assets.delete(oldest[0]);
      }
      id = randomUUID();
      this.assets.set(id, { profile, episode, key, touched: Date.now() });
    }
    this.assets.get(id)!.touched = Date.now();
    this.db.run('UPDATE translation_cache SET touched=? WHERE key=?', Date.now(), key);
    const sourceUrl = this.db.get(
      'SELECT source_url FROM translated_subtitles WHERE episode_id=? AND cache_key=?',
      episode,
      key,
    )?.source_url;
    return {
      ...(sourceUrl ? { provenance: { creatorName: 'Jimaku', sourceUrl } } : {}),
      id: `translation-${key}`,
      label: '한국어 · AI 번역',
      lang: 'ko',
      format: row.format,
      source: 'translation',
      default: false,
      url: `/api/playback/${id}/subtitles/translation.${row.format}?revision=${row.revision}`,
    };
  }
  assetProfile(id: string) {
    return this.assets.get(id)?.profile;
  }
  asset(id: string, track: string, profile?: string) {
    const asset = this.assets.get(id);
    if (!asset) return undefined;
    if (profile !== undefined && profile !== asset.profile) throw new ApiFailure(403, 'session-profile-mismatch');
    this.episode(asset.episode, asset.profile);
    const row = this.db.get<Cache>('SELECT * FROM translation_cache WHERE key=? AND content IS NOT NULL', asset.key);
    if (!row || track !== `translation.${row.format}`) throw new ApiFailure(404, 'subtitle-not-found');
    asset.touched = Date.now();
    return row;
  }
  private prune() {
    const cutoff = Date.now() - TTL;
    for (const [id, job] of this.jobs)
      if (job.touched < cutoff && !['queued', 'running'].includes(job.state)) this.jobs.delete(id);
    for (const [id, asset] of this.assets) if (asset.touched < cutoff) this.assets.delete(id);
    let bytes = Number(
      this.db.get(
        "SELECT COALESCE(SUM(length(CAST(COALESCE(content,'') AS BLOB))+length(CAST(chunks AS BLOB))),0) AS bytes FROM translation_cache",
      )?.bytes || 0,
    );
    const protectedKeys = new Set(this.work.keys());
    for (const row of this.db.all(
      "SELECT key,touched,length(CAST(COALESCE(content,'') AS BLOB))+length(CAST(chunks AS BLOB)) AS bytes FROM translation_cache ORDER BY touched",
    )) {
      if (protectedKeys.has(row.key)) continue;
      if (bytes <= LIMIT && row.touched > Date.now() - 90 * TTL) break;
      this.db.run('DELETE FROM translation_cache WHERE key=?', row.key);
      bytes -= row.bytes;
      for (const [id, job] of this.jobs) if (job.key === row.key) this.jobs.delete(id);
      for (const [id, asset] of this.assets) if (asset.key === row.key) this.assets.delete(id);
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.janitor);
    for (const work of this.work.values()) work.controller.abort();
    await this.active;
  }
}
