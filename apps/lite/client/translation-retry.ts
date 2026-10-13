/** Retry one provider request at a time; never churn through a broken model/config. */
export function translationRetry(code: string, attempt: number, retries: number, keys: number, interval: number): number | null {
  if (attempt >= retries || ['translation-cancelled','translation-disabled','translation-not-configured','translation-model-unavailable','translation-request-rejected'].includes(code)) return null;
  if (['translation-key-invalid','translation-permission-denied','translation-credit-exhausted'].includes(code) && attempt + 1 >= keys) return null;
  return Math.min(60000, Math.max(interval, code === 'translation-quota' ? 5000 * 2 ** attempt : 1000 * 2 ** attempt));
}
export function translationDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('translation-cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('translation-cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
