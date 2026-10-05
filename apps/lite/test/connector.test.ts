import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaRules, playlistUrls } from '../connector/media-rules.js';
import { requestSpec, isReader } from '../connector/policy.js';
test('temporary playback rules are restricted to the approved reader, playback tab and media hosts', () => {
  const rules = mediaRules({ url: 'https://cdn.example.org/master.m3u8', headers: { Referer: 'https://source.example.org/' } }, 'https://moa-lite.example.org', 17, 101, ['https://segments.example.org/one.ts']);
  assert.equal(rules.length, 2);
  for (const rule of rules) { assert.deepEqual(rule.condition.tabIds, [17]); assert.deepEqual(rule.condition.initiatorDomains, ['moa-lite.example.org']); assert.deepEqual(rule.condition.resourceTypes, ['media', 'xmlhttprequest']); assert.equal(rule.action.responseHeaders[0].value, 'https://moa-lite.example.org'); }
  assert.equal(rules[0].action.requestHeaders[0].header, 'referer');
  assert.throws(() => mediaRules({ url: 'https://127.0.0.1/video' }, 'https://moa.example.org', 17, 101), /source_url_denied/);
});
test('playlist discovery includes relative segments, variants and encryption key hosts', () => {
  assert.deepEqual(playlistUrls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.org/key"\nvariant.m3u8\nsegments/one.ts\n', 'https://cdn.example.org/master.m3u8'), ['https://keys.example.org/key', 'https://cdn.example.org/variant.m3u8', 'https://cdn.example.org/segments/one.ts']);
  assert.deepEqual(playlistUrls('<html>denied</html>', 'https://cdn.example.org/'), []);
});
test('connector rejects child frames, unknown readers, forged header lines and unsafe requests', () => {
  assert(!isReader({ frameId: 1, tab: { id: 17 }, url: 'https://moa.example.org/' }, ['https://moa.example.org']));
  assert(!isReader({ frameId: 0, tab: { id: 17 }, url: 'https://other.example.org/' }, ['https://moa.example.org']));
  assert.throws(() => requestSpec({ url: 'https://example.org/', headers: { Referer: 'https://example.org/\r\nattack' } }), /invalid_source_invocation/);
});
