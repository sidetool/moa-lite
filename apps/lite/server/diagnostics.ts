import type { IncomingMessage, ServerResponse } from 'node:http';

function category(path: string) {
  if (path.startsWith('/__moa/')) return 'auth';
  const name = path.split('?')[0].split('/').pop();
  return ['http', 'image', 'images', 'sync', 'tmdb', 'translate', 'subtitles', 'config', 'health', 'diagnostics'].includes(name ?? '') ? name! : 'other';
}
type Route = { requests: number; errors: number; responseBytes: number; totalMs: number; maxMs: number };
/** Instance-local diagnostic counters. No request payloads, URLs, credentials or persistent writes. */
export class RuntimeDiagnostics {
  private startedAt = new Date().toISOString();
  private baseline = process.cpuUsage();
  private routes = new Map<string, Route>();
  private recent: { at: string; route: string; status: number }[] = [];
  private active = 0;
  track(req: IncomingMessage, res: ServerResponse) {
    const route = category(req.url ?? ''), started = performance.now();
    let bytes = 0, done = false;
    this.active++;
    const length = (chunk: unknown, encoding?: unknown) => typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined) : chunk instanceof Uint8Array ? chunk.byteLength : 0;
    const write = res.write, end = res.end;
    res.write = function(this: ServerResponse, ...args: any[]) { bytes += length(args[0], args[1]); return (write as any).apply(this, args); } as typeof res.write;
    res.end = function(this: ServerResponse, ...args: any[]) { bytes += length(args[0], args[1]); return (end as any).apply(this, args); } as typeof res.end;
    const finish = () => {
      if (done) return; done = true; this.active--;
      const elapsed = performance.now() - started, status = res.writableFinished ? res.statusCode : 499;
      const row = this.routes.get(route) ?? { requests: 0, errors: 0, responseBytes: 0, totalMs: 0, maxMs: 0 };
      row.requests++; row.errors += status >= 400 ? 1 : 0; row.responseBytes += bytes;
      row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed); this.routes.set(route, row);
      if (status >= 400) { this.recent.unshift({ at: new Date().toISOString(), route, status }); this.recent.length = Math.min(this.recent.length, 20); }
    };
    res.once('finish', finish); res.once('close', finish);
  }
  snapshot() {
    const cpu = process.cpuUsage(this.baseline), memory = process.memoryUsage();
    return { startedAt: this.startedAt, sampledAt: new Date().toISOString(), scope: 'instance' as const,
      cpuMs: (cpu.user + cpu.system) / 1000, rssBytes: memory.rss, active: this.active,
      routes: Object.fromEntries(this.routes), recent: [...this.recent] };
  }
}

export type QuotaMetric = { id: string; label: string; used: number | null; limit: number; unit: 'bytes' | 'count' | 'hours' | 'gb-hours' };
export const vercelLimits: QuotaMetric[] = [
  { id: 'cpu', label: 'Active CPU', used: null, limit: 4, unit: 'hours' },
  { id: 'memory', label: 'Provisioned Memory', used: null, limit: 360, unit: 'gb-hours' },
  { id: 'origin', label: '함수 ↔ CDN 전송', used: null, limit: 10e9, unit: 'bytes' },
  { id: 'transfer', label: 'CDN 전송', used: null, limit: 100e9, unit: 'bytes' },
  { id: 'invocations', label: '함수 호출', used: null, limit: 1e6, unit: 'count' },
  { id: 'cdn', label: 'CDN 요청', used: null, limit: 1e6, unit: 'count' },
];
const unknownRedis: QuotaMetric[] = [
  { id: 'commands', label: '이번 달 Redis 명령', used: null, limit: 500000, unit: 'count' },
  { id: 'bandwidth', label: '이번 달 Redis 전송', used: null, limit: 10e9, unit: 'bytes' },
  { id: 'storage', label: 'Redis 저장 공간', used: null, limit: 256e6, unit: 'bytes' },
];
export function upstashMetrics(data: any): QuotaMetric[] {
  const fields = ['total_monthly_requests', 'total_monthly_bandwidth', 'current_storage'];
  return unknownRedis.map((metric, index) => ({ ...metric, used: typeof data?.[fields[index]] === 'number' && Number.isFinite(data[fields[index]]) && data[fields[index]] >= 0 ? data[fields[index]] : null }));
}
/** Only explicit admin reads fetch provider stats; cache successes AND failures, collapse concurrent reads. */
export function createQuotaReader(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  let cached: { until: number; value: any } | undefined, pending: Promise<any> | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const email = env.UPSTASH_MANAGEMENT_EMAIL, key = env.UPSTASH_MANAGEMENT_API_KEY, id = env.UPSTASH_DATABASE_ID;
      let status = 'not-configured', metrics = unknownRedis, checkedAt: string | null = null;
      if (email && key && id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
        status = 'unavailable';
        try {
          const response = await request(`https://api.upstash.com/v2/redis/stats/${id}`, { headers: { Authorization: 'Basic ' + Buffer.from(email + ':' + key).toString('base64') }, redirect: 'error', signal: AbortSignal.timeout(8000) });
          if (response.ok) {
            // Bound the management response; never relay provider payloads or errors to the browser.
            const reader = response.body?.getReader(); let size = 0; const parts: Uint8Array[] = [];
            if (!reader) throw new Error('empty');
            try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 2 * 1024 * 1024) throw new Error('large'); parts.push(chunk.value); } } finally { await reader.cancel().catch(() => {}); }
            metrics = upstashMetrics(JSON.parse(Buffer.concat(parts).toString()));
            status = metrics.every(metric => metric.used !== null) ? 'available' : 'partial'; checkedAt = new Date().toISOString();
          } else await response.body?.cancel();
        } catch { /* Missing access / unavailable provider is shown as unknown, never as zero usage. */ }
      }
      const value = { status, metrics, checkedAt, dashboard: 'https://console.upstash.com/redis', cachedSeconds: 300 };
      cached = { until: Date.now() + 300000, value }; return value;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
