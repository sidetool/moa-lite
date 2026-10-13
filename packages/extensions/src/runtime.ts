import { mangayomiWebViewScript } from './webview-script.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runExtension } from './vendor/host.mjs';
import type { MangayomiEntry } from './types.js';
import { mangayomiBootstrap, mangayomiDispatch } from './bootstrap.js';
import { compatibilityHttp, type CompatibilityHttpInput } from './http.js';
import type { SourceWebViewRequest } from './types.js';
import { compatibilityHttpPolicy } from './http-options.js';
import { validatePreferenceState } from './preferences.js';

export type PreferenceValues = Record<string, string | number | boolean | string[] | null>;
export interface MangayomiInvocation {
  entry: MangayomiEntry;
  source: string;
  action: string;
  params?: Record<string, unknown>;
  preferences?: PreferenceValues;
  timeoutMs?: number;
  /** Chosen by the MOA host, never by source code. */
  outboundProxy?: string;
  /** Host-owned opt-in session HTTP; no credentials cross the guest boundary. */
  http?: (request: CompatibilityHttpInput, signal: AbortSignal) => ReturnType<typeof compatibilityHttp>;
  webview?: (request: SourceWebViewRequest, signal: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
}
let dom: Promise<string> | undefined;
async function domSource() {
  dom ??= readFile(join(dirname(createRequire(import.meta.url).resolve('linkedom')), '../worker.js'), 'utf8').then(
    (source) => {
      if (!/\nexport \{[^}]+\};\s*$/.test(source) || source.length > 1024 * 1024)
        throw new Error('compatibility_runtime_unavailable');
      return (
        '(function(){\n' +
        source.replace(/\nexport \{[^}]+\};\s*$/, '\nglobalThis.__moaParseHTML=parseHTML;') +
        '\n})();'
      );
    },
  );
  return dom;
}
/** The bundled DOM library and adapter execute in the same bounded WASM realm as the original source. */
export async function invokeMangayomi(input: MangayomiInvocation, transport = compatibilityHttp) {
  if (input.entry.format !== 'mangayomi-js' || Buffer.byteLength(input.source) > 1024 * 1024)
    throw new Error('compatibility_feature_unsupported');
  let requests = 0,
    bytes = 0;
  let lastTransportFailure: string | undefined;
  const value = (await runExtension({
    source:
      (await domSource()) +
      '\nconst sourceMetadata=' +
      JSON.stringify(input.entry) +
      ';\n' +
      mangayomiBootstrap +
      '\n' +
      input.source +
      '\n' +
      mangayomiDispatch,
    method: 'invoke',
    input: { action: input.action, params: input.params, preferences: input.preferences },
    profile: 'mangayomi-v1',
    timeoutMs: input.timeoutMs ?? (input.action === 'videos' ? 60_000 : 30_000),
    memoryBytes: 64 * 1024 * 1024,
    signal: input.signal,
    broker: {
      'compatibility.webview': async (raw, signal) => {
        const request = raw as { url: string; headers?: Record<string, string>; scripts?: unknown; timeout?: unknown };
        if (['preferences', 'metadata'].includes(input.action) || !input.webview)
          throw new Error('source_browser_unavailable');
        if (
          !Array.isArray(request?.scripts) ||
          request.scripts.length > 32 ||
          request.scripts.some((script) => typeof script !== 'string' || script.length > 65536) ||
          (request.timeout !== undefined &&
            (typeof request.timeout !== 'number' || !Number.isFinite(request.timeout) || request.timeout <= 0))
        )
          throw new Error('invalid_source_invocation');
        const scriptTimeoutMs =
          request.timeout === undefined
            ? 25000
            : Math.max(100, Math.min(90000, Math.round(Number(request.timeout) * 1000)));
        try {
          const result = await input.webview(
            {
              url: request.url,
              headers: request.headers,
              script: mangayomiWebViewScript(request.scripts as string[]),
              waitUntil: 'load',
              // A full chapter can spend time loading images before its collector script starts.
              // Allow navigation overhead without consuming all of the maker's collection window.
              timeoutMs: Math.min(90000, scriptTimeoutMs + (input.action === 'pages' ? 30000 : 0)),
            },
            signal,
          );
          lastTransportFailure = undefined;
          return result;
        } catch (error) {
          if (
            [
              'source_body_limit',
              'source_request_timeout',
              'source_browser_unavailable',
              'source_browser_failed',
              'source_connection_failed',
              'source_http_failed',
              'source_tls_failed',
              'source_access_denied',
            ].includes((error as Error).message)
          )
            lastTransportFailure = (error as Error).message;
          throw error;
        }
      },
      'compatibility.http': async (raw, signal) => {
        if (['preferences', 'metadata'].includes(input.action) || ++requests > 240)
          throw new Error('permission_denied');
        const request = raw as CompatibilityHttpInput;
        const policy = compatibilityHttpPolicy(request?.options);
        let response: Awaited<ReturnType<typeof transport>>;
        try {
          if (request.options?.browserSession && !input.http) throw new Error('source_browser_unavailable');
          response = input.http ? await input.http(request, signal) : await transport(request, signal, [], 4 * 1024 * 1024, input.outboundProxy);
          lastTransportFailure = response.statusCode >= 400 ? 'source_http_failed' : undefined;
        } catch (error) {
          if (
            [
              'source_connection_failed',
              'source_http_failed',
              'source_request_timeout',
              'source_tls_failed',
              'source_address_denied',
              'source_body_limit',
            ].includes((error as Error).message)
          )
            lastTransportFailure = (error as Error).message;
          throw error;
        }
        bytes += response.bytes.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('source_body_limit');
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] ?? 'utf-8';
        let body: string;
        try {
          body = new TextDecoder(charset).decode(response.bytes);
        } catch {
          throw new Error('source_encoding_unsupported');
        }
        return {
          statusCode: response.statusCode,
          headers: response.headers,
          body,
          isRedirect: [301, 302, 303, 307, 308].includes(response.statusCode),
          // Only guest-supplied metadata: never expose vault-injected session headers.
          request: {
            url: request.url,
            method: request.method ?? 'GET',
            headers: request.headers ?? {},
            contentLength: Buffer.byteLength(request.body ?? ''),
            followRedirects: policy.followRedirects,
            maxRedirects: policy.maxRedirects,
          },
        };
      },
      'compatibility.sleep': async (raw, signal) => {
        const delay = Number((raw as { delay?: unknown })?.delay);
        if (!Number.isFinite(delay) || delay < 0 || delay > 10000) throw new Error('permission_denied');
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error('cancelled'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
          }, delay);
          signal.addEventListener('abort', cancel, { once: true });
        });
        return null;
      },
    },
  }).catch((error) => {
    // Some original scripts replace transport exceptions with their own text. Preserve only safe host diagnostics.
    if (error?.message === 'execution_failed' && lastTransportFailure) throw new Error(lastTransportFailure);
    throw error;
  })) as { result: unknown; changes: PreferenceValues };
  if (!value || !value.changes || typeof value.changes !== 'object') throw new Error('invalid_source_result');
  // An extension may swallow a request failure and return an empty catalogue.
  // Report the safe host error so callers don't cache a failure as “no works”.
  const result = value.result as { list?: unknown[] } | unknown[] | undefined;
  if (lastTransportFailure && (
    input.action === 'list' && result && !Array.isArray(result) && Array.isArray(result.list) && result.list.length === 0 ||
    input.action === 'videos' && Array.isArray(result) && result.length === 0
  )) throw new Error(lastTransportFailure);
  validatePreferenceState(value.changes);
  return value;
}
