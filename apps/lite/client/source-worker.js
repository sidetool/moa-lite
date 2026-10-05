// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeHttpBody } from './http-body.ts';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import releaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import { cbc } from '@noble/ciphers/aes.js';
import { mangayomiBootstrap, mangayomiDispatch } from '../../../packages/extensions/src/bootstrap.ts';
import { validatePreferenceState } from '../../../packages/extensions/src/preferences.ts';

const encode = value => new TextEncoder().encode(value);
const limitJson = (value, maximum) => {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || encode(text).length > maximum) throw new Error('payload_limit');
  return text;
};
let started = false, finished = false, nextRpc = 0, lastFailure, totalBytes = 0;
const pending = new Map();
function fail(error) {
  if (finished) return;
  finished = true;
  const message = error?.message;
  postMessage({ type: 'failure', code: /^[a-z][a-z0-9_]{2,80}$/.test(message) ? message : 'execution_failed' });
}
function http(request) {
  if (pending.size >= 4 || ++nextRpc > 240) return Promise.reject(new Error('permission_denied'));
  limitJson(request, 1024 * 1024);
  return new Promise((resolve, reject) => {
    pending.set(nextRpc, { resolve, reject });
    postMessage({ type: 'http', id: nextRpc, request });
  });
}
function cryptoText(text, ivText, keyText, encrypt) {
  if (encode(text).length > 4 * 1024 * 1024 || encode(ivText).length !== 16 || ![16, 24, 32].includes(encode(keyText).length)) return text;
  try {
    const cipher = cbc(encode(keyText), encode(ivText));
    if (encrypt) {
      const bytes = cipher.encrypt(encode(text));
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(cipher.decrypt(Uint8Array.from(atob(text), ch => ch.charCodeAt(0))));
  } catch { return text; }
}

async function invoke(bundle) {
  validatePreferenceState(bundle.preferences);
  if (encode(bundle.source).length > 1024 * 1024) throw new Error('payload_limit');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encode(bundle.source)))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== bundle.codeDigest) throw new Error('source_digest_changed');
  const deadline = performance.now() + bundle.timeoutMs;
  const engine = await newQuickJSWASMModuleFromVariant(newVariant(releaseVariant, { wasmLocation: '/runtime/quickjs.wasm' }));
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const context = runtime.newContext();
  const unwrap = result => {
    if (result.error) { result.error.dispose(); throw new Error(performance.now() >= deadline ? 'execution_timeout' : 'execution_failed'); }
    return result.value;
  };
  const cryptoHandler = context.newFunction('__moaCryptoHandler', (text, iv, key, encrypt) => {
    if ([text, iv, key].some(handle => context.typeof(handle) !== 'string')) return context.newString('');
    return context.newString(cryptoText(context.getString(text), context.getString(iv), context.getString(key), context.dump(encrypt) === true));
  });
  context.setProp(context.global, '__moaCryptoHandler', cryptoHandler);
  cryptoHandler.dispose();
  let guestPending = 0, guestRequests = 0;
  const bridge = async (method, input) => {
    if (method === 'compatibility.sleep') {
      const delay = Number(input?.delay);
      if (!Number.isFinite(delay) || delay < 0 || delay > 10000) throw new Error('permission_denied');
      await new Promise(resolve => setTimeout(resolve, delay));
      return null;
    }
    if (['metadata', 'preferences'].includes(bundle.action)) throw new Error('permission_denied');
    if (method === 'compatibility.http') return http(input);
    if (method === 'compatibility.webview') {
      if (!Array.isArray(input?.scripts) || input.scripts.length > 32 || input.scripts.some(s => typeof s !== 'string' || s.length > 65536))
        throw new Error('invalid_source_invocation');
      // HTTP and HTML parsing are available through Client and Document.
      // WebView scripts require a browser page environment this worker does not provide.
      throw new Error('source_browser_unavailable');
    }
    throw new Error('permission_denied');
  };
  const rpc = context.newFunction('rpc', handle => {
    if (context.typeof(handle) !== 'string' || guestPending >= 4 || ++guestRequests > 512) return { error: context.newError('permission_denied') };
    let request;
    try {
      const text = context.getString(handle);
      if (encode(text).length > 1024 * 1024) throw new Error('payload_limit');
      request = JSON.parse(text);
    } catch { return { error: context.newError('invalid_rpc') }; }
    const deferred = context.newPromise();
    guestPending++;
    Promise.resolve().then(() => bridge(request.method, request.input)).then(value => {
      // Let the extension inspect/retry an HTTP rejection, but preserve its cause
      // if parsing the denial page subsequently throws inside the guest.
      lastFailure = value?.statusCode >= 400 ? 'source_http_failed' : undefined;
      return { ok: true, value };
    }, error => {
      lastFailure = /^[a-z][a-z0-9_]{2,80}$/.test(error.message) ? error.message : 'source_failed';
      return { ok: false, code: lastFailure };
    }).then(reply => {
      if (finished) return;
      const result = context.newString(limitJson(reply, 16 * 1024 * 1024));
      deferred.resolve(result);
      result.dispose();
      deferred.dispose();
      guestPending--;
    }).catch(fail);
    return deferred.handle;
  });
  const factory = unwrap(context.evalCode(`(function(rpc){
    const parse=JSON.parse, stringify=JSON.stringify;
    const host=Object.freeze({request:async function(method,input){
      const reply=parse(await rpc(stringify({method,input})));
      if(!reply.ok){const e=new Error(reply.code);e.code=reply.code;throw e;}return reply.value;
    }});
    return async function(fn,input){return stringify(await fn('invoke',parse(input),host));};
  })`));
  const dispatch = unwrap(context.callFunction(factory, context.undefined, rpc));
  factory.dispose(); rpc.dispose();
  unwrap(context.evalCode(__MOA_DOM_SOURCE__ + '\nconst sourceMetadata=' + JSON.stringify(bundle.entry) + ';\n' +
    mangayomiBootstrap + '\n' + bundle.source + '\n' + mangayomiDispatch, 'extension.js')).dispose();
  const extension = context.getProp(context.global, 'moaExtension');
  const input = context.newString(limitJson({ action: bundle.action, params: bundle.params, preferences: bundle.preferences }, 3 * 1024 * 1024));
  const promise = unwrap(context.callFunction(dispatch, context.undefined, extension, input));
  extension.dispose(); input.dispose(); dispatch.dispose();
  const timerPump = context.getProp(context.global, '__moaRunTimers');
  const pump = () => {
    if (finished) return;
    try {
      if (performance.now() >= deadline) throw new Error('execution_timeout');
      unwrap(context.callFunction(timerPump, context.undefined)).dispose();
      const jobs = runtime.executePendingJobs(64);
      if (jobs.error) { jobs.error.dispose(); throw new Error('execution_failed'); }
      const state = context.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        if (context.typeof(state.value) !== 'string') throw new Error('invalid_source_result');
        const text = context.getString(state.value);
        state.value.dispose();
        if (encode(text).length > 4 * 1024 * 1024) throw new Error('payload_limit');
        const output = JSON.parse(text);
        validatePreferenceState(output.changes);
        if (lastFailure && (bundle.action === 'list' && Array.isArray(output.result?.list) && !output.result.list.length || bundle.action === 'videos' && Array.isArray(output.result) && !output.result.length)) throw new Error(lastFailure);
        finished = true;
        postMessage({ type: 'result', value: output });
        // The owning page terminates this one-shot worker, reclaiming WASM and all handles.
        return;
      }
      if (state.type === 'rejected') {
        const code = context.getProp(state.error, 'code');
        const message = context.typeof(code) === 'string' ? context.getString(code) : undefined;
        code.dispose(); state.error.dispose();
        throw new Error(performance.now() >= deadline ? 'execution_timeout' : lastFailure || message || 'execution_failed');
      }
      setTimeout(pump, runtime.hasPendingJob() ? 0 : 5);
    } catch (error) { fail(error); }
  };
  pump();
}
self.onmessage = ({ data }) => {
  if (finished) return;
  if (!started && data?.type === 'invoke') {
    started = true;
    invoke(data.bundle).catch(fail);
  } else if (data?.type === 'http-result' && pending.has(data.id)) {
    const task = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else {
      try {
        const response = data.value;
        let bytes;
        try { bytes = Uint8Array.from(atob(response.bytes), ch => ch.charCodeAt(0)); }
        catch { throw new Error('source_http_failed'); }
        totalBytes += bytes.length;
        if (bytes.length > 2 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('source_body_limit');
        const body = decodeHttpBody(bytes,response.contentType);
        delete response.bytes;
        task.resolve({ ...response, body });
      } catch (error) { task.reject(error); }
    }
  }
};
