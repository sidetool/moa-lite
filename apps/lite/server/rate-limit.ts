/** Fixed windows local to one warm instance; auth brute-force protection stays in Redis. */
export class InstanceRateLimiter {
  private windows = new Map<string, { count: number; expires: number }>();
  constructor(private maxKeys = 10_000) {}
  rate(key: string, limit: number, seconds: number, now = Date.now()) {
    // Bounded scan also evicts inactive accounts without a background timer.
    for (const [key, row] of this.windows) if (row.expires <= now) this.windows.delete(key);
    let row = this.windows.get(key);
    if (!row) {
      // Fail closed at capacity rather than evict an active account's limit.
      if (this.windows.size >= this.maxKeys) return false;
      row = { count: 0, expires: now + seconds * 1000 };
      this.windows.set(key, row);
    }
    if (row.count >= limit) return false;
    row.count++; return true;
  }
}
