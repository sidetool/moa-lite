import test from 'node:test';
import assert from 'node:assert/strict';
import { BlogCollector } from '../src/blogs.js';
import { PublicHttpClient } from '../src/http.js';
import type { Diagnostic, ResolvedTitle } from '../src/types.js';

const title: ResolvedTitle = { title: '구름 정원', baseTitle: '구름 정원', season: 1, episodeOffset: 0, source: 'input', confidence: .8, aliases: ['Cloud Garden'] };
const subtitle = '1\n00:00:01,000 --> 00:00:02,000\n합성 자막입니다\n';
const link = (url: string, label = '구름 정원 3화 자막') => `<a href="${url}"><span class="sds-comps-text sds-comps-text-type-headline1">${label}</span><span>새 창 열림</span></a>`;
const article = (heading: string) => `<h1>${heading}</h1><div class="post-body"><a href="https://files.example/03.srt">3화 자막</a></div>`;
function fixture(body: (url: URL) => string) {
  const http = new PublicHttpClient(), calls: string[] = [], diagnostics: Diagnostic[] = [];
  http.get = async (raw, options) => {
    options.signal.throwIfAborted(); calls.push(raw);
    return { url: raw, status: 200, headers: {}, body: Buffer.from(body(new URL(raw))) };
  };
  return { calls, diagnostics, collector: new BlogCollector(http, { maxZipBytes: 10000, maxZipEntries: 10, aliases: [] }, diagnostic => diagnostics.push(diagnostic)) };
}

test('public discovery verifies the actual article and preserves the discovered blog attribution', async () => {
  const { collector, calls } = fixture(url => {
    if (url.hostname === 'search.naver.com') return [
      link('https://evil.tistory.com.evil.test/1'),
      link('http://127.0.0.1/03.srt'),
      link('https://wrong.tistory.com/1', '구름 정원 2기 3화 자막'),
      link('https://stale.tistory.com/1'),
      '<a href="https://snippet.tistory.com/3"><span class="sds-comps-text-type-body1">구름 정원 3화 자막</span></a>',
      link('https://m.blog.naver.com/cloud_author/123456', '<mark>구름</mark> 정원 <mark>3화</mark> 자막'),
    ].join('');
    if (url.hostname === 'stale.tistory.com') return article('다른 작품 3화 자막');
    if (url.hostname === 'blog.naver.com') return article('구름 정원 3화 자막');
    if (url.hostname === 'files.example') return subtitle;
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const found = await collector.discover(title, 3, new AbortController().signal);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.creatorName, 'cloud_author');
  assert.equal(found[0]?.matchedEpisode, 3);
  assert.match(found[0]?.content ?? '', /합성 자막/);
  assert.equal(calls.filter(url => new URL(url).hostname === 'files.example').length, 1);
  assert.ok(calls.every(url => !/evil|127\.0|wrong/.test(url)));
  assert.equal(calls.filter(url => new URL(url).hostname === 'search.naver.com').length, 1);
  assert.equal(new URL(calls[0]!).searchParams.get('where'), 'blog');
  assert.equal(new URL(calls[0]!).searchParams.get('query'), '구름 정원 3화 자막');
});

test('public discovery caps search queries and article reads without crawling discovered blogs', async () => {
  let searches = 0;
  const { collector, calls } = fixture(url => {
    if (url.hostname === 'search.naver.com') return ++searches === 1 ? '' : Array.from({ length: 12 }, (_, i) => link(`https://cloud.tistory.com/${i + 1}`)).join('');
    return '<h1>구름 정원 4화 자막</h1>';
  });
  assert.deepEqual(await collector.discover({ ...title, aliases: ['Cloud Garden', '雲の庭'] }, 3, new AbortController().signal), []);
  assert.equal(searches, 2);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(url => new URL(url).hostname === 'search.naver.com' || /^\/[1-4]$/.test(new URL(url).pathname)));
});

test('public discovery leaves absolute numbering to verified article and attachment checks', async () => {
  const { collector, calls } = fixture(url => {
    if (url.hostname === 'search.naver.com') return link('https://cloud.tistory.com/15', '구름 정원 2기 15화 자막');
    if (url.hostname === 'files.example') return subtitle;
    return '<h1>구름 정원 2기 15화 자막</h1><div class="post-body"><a href="https://files.example/15.srt">15화 자막</a></div>';
  });
  const found = await collector.discover({ ...title, title: '구름 정원 2기', season: 2, episodeOffset: 12 }, 3, new AbortController().signal);
  assert.equal(new URL(calls[0]!).searchParams.get('query'), '구름 정원 2기 자막');
  assert.equal(found[0]?.episode, 3);
  assert.equal(found[0]?.matchedEpisode, 15);
});

test('public discovery rejects conflicting season and attachment identity after a matching search result', async () => {
  const { collector, calls } = fixture(url => {
    if (url.hostname === 'search.naver.com') return link('https://wrong-season.blogspot.com/2026/10/sub.html') + link('https://wrong-file.tistory.com/3');
    if (url.hostname === 'wrong-season.blogspot.com') return article('구름 정원 2기 3화 자막');
    return '<h1>구름 정원 3화 자막</h1><div class="post-body"><a href="https://files.example/03.srt">다른 작품 03.srt</a></div>';
  });
  assert.deepEqual(await collector.discover(title, 3, new AbortController().signal), []);
  assert.ok(calls.every(url => new URL(url).hostname !== 'files.example'));
});

test('public discovery reports unreadable and failed search responses without treating them as candidates', async () => {
  const { collector, calls, diagnostics } = fixture(url => {
    if (url.searchParams.get('query')?.startsWith('구름')) return '<html><title>접근 제한</title><p>검색 요청을 확인하세요</p></html>';
    throw new Error('HTTP 429 from search.naver.com');
  });
  assert.deepEqual(await collector.discover(title, 3, new AbortController().signal), []);
  assert.equal(calls.length, 2);
  assert.deepEqual(diagnostics.map(d => d.code), ['not-found', 'error']);
  assert.match(diagnostics[0]!.message, /no readable article titles/);
  assert.match(diagnostics[1]!.message, /HTTP 429/);
});

test('an aborted public discovery makes no requests', async () => {
  const { collector, calls } = fixture(() => { throw new Error('Unexpected request'); });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await collector.discover(title, 3, abort.signal), []);
  assert.deepEqual(calls, []);
});
