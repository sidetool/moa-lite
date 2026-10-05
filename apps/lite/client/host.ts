let sequence = 0;
const requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
export function host(method: string, input: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cancel = () => { requests.delete(id); postMessage({ type: 'host-cancel', id }); reject(new Error('cancelled')); };
    const done = () => signal?.removeEventListener('abort', cancel);
    requests.set(id, { resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); } });
    signal?.addEventListener('abort', cancel, { once: true });
    postMessage({ type: 'host', id, method, input });
  });
}
export function hostReply(data: any) {
  const request = requests.get(data.id); if (!request) return;
  requests.delete(data.id);
  if (data.error) request.reject(Object.assign(new Error(data.error.code), { statusCode: data.error.status }));
  else request.resolve(data.value);
}
