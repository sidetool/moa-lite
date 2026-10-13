export interface CompatibilityHttpOptions {
  /** Explicit opt-in; POST must be a source-defined read operation. */
  browserSession?: { url: string; readOnly?: boolean };
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
}

/** Client timeouts are seconds upstream. Host limits cannot be lifted by guest options. */
export function compatibilityHttpPolicy(options?: CompatibilityHttpOptions) {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
    throw new Error('invalid_source_invocation');
  const { timeout, followRedirects, maxRedirects, browserSession } = options ?? {};
  if (
    (browserSession !== undefined && (!browserSession || typeof browserSession !== 'object' || Array.isArray(browserSession) || typeof browserSession.url !== 'string' || browserSession.url.length > 8192 || (browserSession.readOnly !== undefined && typeof browserSession.readOnly !== 'boolean'))) ||
    (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) ||
    (followRedirects !== undefined && typeof followRedirects !== 'boolean') ||
    (maxRedirects !== undefined && (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0))
  )
    throw new Error('invalid_source_invocation');
  return {
    timeoutMs: timeout === undefined ? 15000 : Math.max(1, Math.min(90000, Math.round(timeout * 1000))),
    followRedirects: followRedirects !== false,
    maxRedirects: Math.min(4, maxRedirects ?? 4),
  };
}
