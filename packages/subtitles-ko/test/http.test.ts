import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { PublicHttpClient, isPublicAddress, validatePublicUrl, resolvePublicHost, type HttpResponse } from "../src/http.js";

test("private/reserved IPv4 and IPv6, exotic localhost forms and credential URLs are rejected", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "2001::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAddress(address), true, address);
  for (const url of ["http://localhost", "http://localhost.", "http://a.localhost", "http://foo.local", "http://127.1", "http://2130706433", "http://0x7f000001", "http://[::ffff:7f00:1]", "file:///etc/passwd", "ftp://public.example/file", "https://user:password@example.com", "http://example.com:8080"]) assert.throws(() => validatePublicUrl(url), /public/);
});

test("all DNS answers must be public, DNS lookup respects cancellation", async () => {
  const signal = new AbortController().signal;
  const url = new URL("https://public.example/file");
  await assert.rejects(resolvePublicHost(url, signal, async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]), /non-public/);
  const controller = new AbortController();
  const pending = resolvePublicHost(url, controller.signal, () => new Promise(() => {}));
  controller.abort(); await assert.rejects(pending);
});

test('request budget covers concurrent calls and redirects before DNS/transport', async () => {
  let requests = 0;
  const client = new PublicHttpClient(100, 1024, async () => [{address: '1.1.1.1', family: 4}], 2);
  (client as any).request = async () => { requests++; return {status: 302, headers: {location: '/next'}, body: Buffer.alloc(0)}; };
  const results = await Promise.allSettled([1,2,3].map(() => client.get('https://public.example/', {signal: AbortSignal.timeout(100)})));
  assert.equal(requests, 2);
  assert(results.every(result => result.status === 'rejected' && /budget/.test(result.reason.message)));
});

test('an access-denied host is not retried for every article in one search client', async () => {
  let requests = 0;
  const client = new PublicHttpClient(100, 1024, async () => [{address: '1.1.1.1', family: 4}]);
  (client as any).request = async () => { requests++; return {status: 403, headers: {}, body: Buffer.alloc(0)}; };
  for (const path of ['one', 'two', 'three']) await assert.rejects(client.get('https://public.example/' + path, {signal: AbortSignal.timeout(100)}), /HTTP 403/);
  assert.equal(requests, 1);
});

test("redirect targets and changed DNS are checked before transport", async () => {
  const signal = new AbortController().signal;
  let requests = 0;
  let dnsCalls = 0;
  const client = new PublicHttpClient(100, 1024, async () => {
    dnsCalls++; return [{ address: dnsCalls === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 }];
  });
  const transport = client as unknown as { request: () => Promise<HttpResponse> };
  transport.request = async () => { requests++; return { url: "https://public.example", status: 302, headers: { location: "/next" }, body: Buffer.alloc(0) }; };
  await assert.rejects(client.get("https://public.example", { signal }), /non-public/);
  assert.equal(requests, 1); assert.equal(dnsCalls, 2);
  dnsCalls = 0;
  transport.request = async () => ({ url: "https://public.example", status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, body: Buffer.alloc(0) });
  await assert.rejects(client.get("https://public.example", { signal }), /public/);
});

test("transport pins the checked IP and rejects oversized streamed bodies without a Content-Length", async t => {
  let selectedAddress: string | undefined;
  t.mock.method(https, "request", (_url: URL, options: any, callback: any) => {
    const request = new EventEmitter() as any;
    const response = new PassThrough() as any;
    response.headers = {}; response.statusCode = 200;
    request.destroy = (error?: Error) => { response.destroy(); if (error) request.emit("error", error); };
    request.end = () => queueMicrotask(() => {
      options.lookup("public.example", {}, (_error: unknown, address: string) => { selectedAddress = address; });
      callback(response);
      response.write(Buffer.alloc(60)); response.end(Buffer.alloc(60));
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    const client = new PublicHttpClient(100, 100, async () => [{ address: "1.1.1.1", family: 4 }]);
    await assert.rejects(client.get("https://public.example/large", { signal: new AbortController().signal }), /limit/);
    assert.equal(selectedAddress, "1.1.1.1");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
