import { Buffer } from 'buffer';
import { host } from './host.js';
import { createHash } from './crypto.js';
export { publicUrl, parseRepository, fetchRepository, fetchExtension } from '../../../packages/extensions/src/repository.js';
export { preferenceSchema, trimPreferenceState, validatePreferenceState } from '../../../packages/extensions/src/preferences.js';
export type * from '../../../packages/extensions/src/types.js';
export const parseOutboundProxy = (value: string) => { if (value) throw new Error('compatibility_feature_unsupported'); return undefined; };
export async function compatibilityHttp(input: any, signal: AbortSignal, _headers: string[] = [], maximum = 2 * 1024 * 1024) {
  const wire = await host('http', input, signal);
  const bytes = Buffer.from(wire.bytes, 'base64');
  if (bytes.length > maximum) throw new Error('source_body_limit');
  return { ...wire, bytes };
}
export function invokeMangayomi(input: any): Promise<any> {
  const timeoutMs = input.timeoutMs ?? (input.action === 'videos' ? 60_000 : 30_000);
  return new Promise((resolve, reject) => {
    const worker = new Worker('/runtime/source-worker.js', { type: 'module' });
    const operation = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, operation.signal]) : operation.signal;
    let finished = false;
    const cancel = () => finish(new Error('cancelled'));
    const timer = setTimeout(() => finish(new Error('execution_timeout')), timeoutMs + 1000);
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return; finished = true; operation.abort();
      clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) { cancel(); return; }
    worker.onerror = () => finish(new Error('execution_failed'));
    worker.onmessage = async ({ data }) => {
      if (data.type === 'result') finish(undefined, data.value);
      else if (data.type === 'failure') finish(new Error(data.code));
      else if (data.type === 'http') {
        try { const value = await host('http', data.request, signal); if (!finished) worker.postMessage({ type: 'http-result', id: data.id, value }); }
        catch (error) { if (!finished) worker.postMessage({ type: 'http-result', id: data.id, error: (error as Error).message }); }
      }
    };
    worker.postMessage({ type: 'invoke', bundle: { entry: input.entry, source: input.source, codeDigest: createHash('sha256').update(input.source).digest('hex'), action: input.action, params: input.params, preferences: input.preferences ?? {}, timeoutMs } });
  });
}
