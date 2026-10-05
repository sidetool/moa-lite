export function setTimeout(ms: number, value?: unknown, options?: { signal?: AbortSignal }) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(options?.signal?.reason ?? new Error('cancelled')); };
    const timer = globalThis.setTimeout(() => { options?.signal?.removeEventListener('abort', cancel); resolve(value); }, ms);
    if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener('abort', cancel, { once: true });
  });
}
