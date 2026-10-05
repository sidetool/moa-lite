import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
export interface DocumentStore {
  get(key: string): Promise<{ revision: number; value: any }>;
  compareSet(key: string, revision: number, value: any, ttlSeconds?: number): Promise<boolean>;
  rate(key: string, limit: number, seconds: number): Promise<boolean>;
}
const cas = `local old=redis.call('GET',KEYS[1]); local rev=0; if old then rev=cjson.decode(old).revision end
if rev~=tonumber(ARGV[1]) then return 0 end
redis.call('SET',KEYS[1],ARGV[2]); if tonumber(ARGV[3])>0 then redis.call('EXPIRE',KEYS[1],ARGV[3]) end; return 1`;
const rate = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[2]) end; return n<=tonumber(ARGV[1]) and 1 or 0`;
// Each get validates on Redis; the application auth cache can skip get for up to 30 seconds.
const readCached = `local cached=redis.call('GET',KEYS[1]); if not cached then return '' end
if redis.sha1hex(cached)==ARGV[1] then return false end; return cached`;
export class RedisDocuments implements DocumentStore {
  private cache = new Map<string, { fingerprint: string; bytes: number; row: { revision: number; value: any } }>();
  private cacheBytes = 0;
  constructor(private url: string, private token: string, private namespace = 'moa-lite') {}
  private async call(command: unknown[]) {
    const response = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error('storage-unavailable');
    return result.result;
  }
  async get(key: string) {
    const previous = this.cache.get(key);
    const value = await this.call(previous ? ['EVAL', readCached, 1, `${this.namespace}:${key}`, previous.fingerprint] : ['GET', `${this.namespace}:${key}`]);
    if (previous && value === null) return structuredClone(previous.row);
    const encoded = value ? JSON.parse(value) : { revision: 0, value: null };
    const row = encoded.compression === 'gzip' ? { revision: encoded.revision, value: JSON.parse(gunzipSync(Buffer.from(encoded.value, 'base64'), { maxOutputLength: 3 * 1024 * 1024 }).toString()) } : encoded;
    this.forget(key);
    if (value) {
      const bytes = Math.max(Buffer.byteLength(value), Buffer.byteLength(JSON.stringify(row)));
      this.cache.set(key, { fingerprint: createHash('sha1').update(value).digest('hex'), bytes, row }); this.cacheBytes += bytes;
      while (this.cacheBytes > 8 * 1024 * 1024 || this.cache.size > 64) this.forget(this.cache.keys().next().value!);
    }
    return structuredClone(row);
  }
  private forget(key: string) { this.cacheBytes -= this.cache.get(key)?.bytes ?? 0; this.cache.delete(key); }
  async compareSet(key: string, revision: number, value: any, ttlSeconds = 0) {
    let data = JSON.stringify({ revision: revision + 1, value });
    if (Buffer.byteLength(data) > 3 * 1024 * 1024) throw new Error('storage-limit');
    if (Buffer.byteLength(data) > 4096) {
      const compressed = JSON.stringify({ revision: revision + 1, compression: 'gzip', value: gzipSync(JSON.stringify(value), { level: 1 }).toString('base64') });
      if (compressed.length < data.length) data = compressed;
    }
    const saved = await this.call(['EVAL', cas, 1, `${this.namespace}:${key}`, revision, data, ttlSeconds]) === 1;
    this.forget(key); return saved;
  }
  async rate(key: string, limit: number, seconds: number) { return await this.call(['EVAL', rate, 1, `${this.namespace}:rate:${key}`, limit, seconds]) === 1; }
}
/** Development/test only. Production never falls back to instance-local storage. */
export class MemoryDocuments implements DocumentStore {
  private rows = new Map<string, { revision: number; value: any; expires: number }>();
  private rates = new Map<string, { count: number; expires: number }>();
  async get(key: string) { const row = this.rows.get(key); return row && row.expires > Date.now() ? structuredClone({ revision: row.revision, value: row.value }) : { revision: 0, value: null }; }
  async compareSet(key: string, revision: number, value: any, ttlSeconds = 0) {
    const old = this.rows.get(key);
    if ((old && old.expires > Date.now() ? old.revision : 0) !== revision) return false;
    this.rows.set(key, { revision: revision + 1, value: structuredClone(value), expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity }); return true;
  }
  async rate(key: string, limit: number, seconds: number) {
    const old = this.rates.get(key), row = old && old.expires > Date.now() ? old : { count: 0, expires: Date.now() + seconds * 1000 };
    this.rates.set(key, row); return ++row.count <= limit;
  }
}
export async function updateDocument<T>(store: DocumentStore, key: string, transform: (value: any) => T | Promise<T>, ttl = 0) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await store.get(key), value = await transform(structuredClone(row.value));
    if (await store.compareSet(key, row.revision, value, ttl)) return { revision: row.revision + 1, value };
  }
  throw new Error('storage-conflict');
}
