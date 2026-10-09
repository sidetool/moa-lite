import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { BlogCollector } from '../src/blogs.js';
import { PublicHttpClient, type HttpOptions, type HttpResponse } from '../src/http.js';
import { MetadataClient } from '../src/metadata.js';
import { createOfflineSubtitleClient as createSubtitleClient } from './fixtures/synthetic.js';
import type { AliasEntry, SubtitleCandidate, SubtitleCreator } from '../src/types.js';

// All responses, including metadata, are supplied here. No live HTTP or DNS.
// Compare with the same test copied beside `git archive b1fcfb9` sources;
// the reviewed worktree stays at 7d67c0e. Assertions describe correct behavior,
// Root review retains bounded search and flags ambiguous numbering for manual choice;
// see docs/ANISKIP-AND-LEGACY-SUBTITLES.md for reviewed expectation changes.
PublicHttpClient.prototype.get = async () => { throw new Error('Live HTTP is forbidden in review tests'); };
const signal = () => new AbortController().signal;
const srt = (text = '요청한 첫 화') => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
const response = (url: string, body: string | Buffer): HttpResponse => ({
  url, status: 200, headers: {}, body: Buffer.isBuffer(body) ? body : Buffer.from(body),
});
const zip = (name: string) => readFileSync(new URL(`fixtures/review-${name}.zip`, import.meta.url));
const creator = (overrides: Partial<SubtitleCreator> = {}): SubtitleCreator => ({
  id: 'review', name: '합성 제작자', website: 'https://example-reviewer.tistory.com/', source: 'archive',
  title: 'Example', season: 1, episodeOffset: 0, isCurrentEpisode: false, confidence: .85,
  ...overrides,
});
const anchor = (path: string, title: string) => `<a href="${path}">${title}</a>`;
const page = (title: string, label = '1화.srt', path = 'https://files.example/01.srt') =>
  `<h1>${title}</h1><div class="post-body">${anchor(path, label)}</div>`;
const isSearch = (url: string) => new URL(url).pathname.startsWith('/search');
const queryOf = (url: string) => new URL(url).searchParams.get('q') ??
  decodeURIComponent(new URL(url).pathname.slice('/search/'.length));

function mock(route: (url: string) => string | Buffer, aliases: AliasEntry[] = []) {
  const http = new PublicHttpClient();
  const calls: string[] = [];
  http.get = async url => { calls.push(url); return response(url, route(url)); };
  return { http, calls, collector: new BlogCollector(http, { maxZipBytes: 100_000, maxZipEntries: 20, aliases }) };
}

function observation(result: SubtitleCandidate | null, calls: string[]) {
  return JSON.stringify({ result: result && { source: result.sourceUrl, filename: result.filename,
    matchedEpisode: result.matchedEpisode, content: result.content }, calls });
}

for (const edition of ['Movie', 'OVA', '외전', '2기', 'Part2']) {
  test(`identity: Example must reject Example ${edition} episode 1`, async () => {
    const title = `Example ${edition} 1화 자막`;
    const m = mock(url => isSearch(url) ? anchor('/wrong', title) :
      url.endsWith('/wrong') ? page(title) : srt('다른 작품 첫 화'));
    const result = await m.collector.collect(creator(), 1, signal());
    assert.equal(result, null, observation(result, m.calls));
  });

  test(`identity: propagated English alias must reject Example ${edition} episode 1`, async () => {
    const title = `Example ${edition} 1화 자막`;
    const m = mock(url => isSearch(url) ? anchor('/wrong', title) :
      url.endsWith('/wrong') ? page(title) : srt('영어 별칭의 다른 작품'));
    const metadata = new MetadataClient(m.http, [], false);
    const resolved = await metadata.resolve('가상 예제', 1, signal(), ['Example']);
    const c = { ...metadata.archive(resolved), website: 'https://example-reviewer.tistory.com/' };
    const result = await m.collector.collect(c, 1, signal());
    assert.equal(result, null, observation(result, m.calls));
  });
}

test('batch: removing 전편 must not merge a distinct installment with Example', async () => {
  const title = 'Example 전편 12화 자막';
  const m = mock(url => isSearch(url) ? anchor('/wrong', title) : url.endsWith('/wrong') ?
    page(title, 'Example 전편 통합.zip', 'https://files.example/batch.zip') : zip('prequel'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result, null, observation(result, m.calls));
});

test('batch: a seasonless final post cannot prove that a later-season local 01 belongs to season 1', async () => {
  const title = 'Example 12화 자막';
  const m = mock(url => isSearch(url) ? anchor('/final', title) : url.endsWith('/final') ?
    page(title, '전편.zip', 'https://files.example/batch.zip') : zip('later-unlabelled'));
  const result = await m.collector.collect(creator(), 1, signal());
  // The fixture deliberately has later-season content and no season token anywhere.
  assert.equal(result, null, observation(result, m.calls));
});

test('page identity: matching listing and 1.srt cannot override a different actual h1', async () => {
  const m = mock(url => isSearch(url) ? anchor('/wrong', 'Example 1화 자막') :
    url.endsWith('/wrong') ? page('Different Work 1화 자막') : srt('다른 작품의 자막'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result, null, observation(result, m.calls));
});

test('page episode: episode-1 listing and attachment cannot override an episode-13 h1', async () => {
  const m = mock(url => isSearch(url) ? anchor('/wrong', 'Example 1화 자막') :
    url.endsWith('/wrong') ? page('Example 13화 자막') : srt('제목과 첨부 회차 모순'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result, null, observation(result, m.calls));
});

test('verified article identity is sufficient even when the attachment uses an unrecognized title', async () => {
  const m = mock(url => isSearch(url) ? anchor('/post', 'Example 1화 자막') :
    url.endsWith('/post') ? page('Example 1화 자막', 'Different Work 1화.srt') : srt('다른 작품 첨부'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.ok(result && result.confidence >= .5, observation(result, m.calls));
});

test('verified article identity also applies to unrecognized ZIP member titles', async () => {
  const m = mock(url => isSearch(url) ? anchor('/post', 'Example 1화 자막') :
    url.endsWith('/post') ? page('Example 1화 자막', 'Example 1화.zip', 'https://files.example/01.zip') : zip('different-work'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.ok(result && result.confidence >= .5, observation(result, m.calls));
});

test('archive episode: a 1~25.zip label cannot identify unnamed.srt as episode 1', async () => {
  const m = mock(url => isSearch(url) ? anchor('/post', 'Example 자막') :
    url.endsWith('/post') ? page('Example 자막', '1~25.zip', 'https://files.example/1~25.zip') : zip('unnamed'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result, null, observation(result, m.calls));
});

test('later-season numbering: an absolute-25 page with local-01 entry remains manual-only', async () => {
  const m = mock(url => isSearch(url) ? anchor('/post', 'Example 2기 25화 자막') :
    url.endsWith('/post') ? page('Example 2기 25화 자막', '25화.zip', 'https://files.example/25.zip') : zip('numbered'));
  const result = await m.collector.collect(creator({ title: 'Example 2기', season: 2, episodeOffset: 24 }), 1, signal());
  // Both labels can denote the same episode with the verified offset; do not
  // suppress a potentially valid file, but never automatically select it.
  assert.ok(result && result.confidence < .5, observation(result, m.calls));
});

test('metadata: Anissia English aliases must not authorize a different Movie post', async () => {
  const m = mock(url => url.includes('/caption/') ? JSON.stringify({ code: 'ok', data: [
    { name: '합성 제작자', episode: '1', website: 'https://example-reviewer.tistory.com/latest' },
  ] }) : isSearch(url) ? anchor('/wrong', 'Example Movie 1화 자막') :
    url.endsWith('/latest') ? '<h1>가상 예제 13화 자막</h1>' :
    url.endsWith('/wrong') ? page('Example Movie 1화 자막') : srt('다른 극장판'));
  const metadata = new MetadataClient(m.http, [], false);
  const resolved = { ...await metadata.resolve('가상 예제', 1, signal(), ['Example']), animeNo: 42 };
  const [c] = await metadata.creators(resolved, 1, signal());
  assert.ok(c);
  const result = await m.collector.collect(c, 1, signal());
  assert.equal(result, null, observation(result, m.calls));
});

test('archive control: an exact single-episode post can identify an unnamed singleton', async () => {
  const m = mock(url => isSearch(url) ? anchor('/post', 'Example 1화 자막') :
    url.endsWith('/post') ? page('Example 1화 자막', '1화.zip', 'https://files.example/01.zip') : zip('unnamed'));
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result?.filename, 'unnamed.srt', observation(result, m.calls));
  assert.equal(result?.matchedEpisode, 1);
});

for (const [stage, title, label, payload] of [
  ['page season', 'Example 2기 1화 자막', '1화.zip', 'numbered'],
  ['attachment episode', 'Example 1화 자막', '13화.zip', 'numbered'],
  ['entry episode', 'Example 1화 자막', '1화.zip', 'episode-13'],
  ['entry season', 'Example 1화 자막', '1화.zip', 'season-2'],
] as const) {
  test(`contradiction control: reject ${stage}`, async () => {
    const m = mock(url => isSearch(url) ? anchor('/post', 'Example 1화 자막') :
      url.endsWith('/post') ? page(title, label, 'https://files.example/batch.zip') : zip(payload));
    const result = await m.collector.collect(creator(), 1, signal());
    assert.equal(result, null, observation(result, m.calls));
  });
}

test('episode ranking control: four other-episode posts in the same query do not hide the fifth exact post', async () => {
  const listing = [9, 10, 11, 12].map(n => anchor(`/bad${n}`, `Example ${n}화 자막`)).join('') +
    anchor('/exact', 'Example 1화 자막');
  const m = mock(url => isSearch(url) ? listing : url.endsWith('/exact') ? page('Example 1화 자막') :
    url.includes('/bad') ? '<h1>Example 13화 자막</h1>' : srt());
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result?.sourceUrl, 'https://example-reviewer.tistory.com/exact', observation(result, m.calls));
});

test('episode ranking control: an exact post precedes four series-page fallbacks in the same query', async () => {
  const listing = Array.from({ length: 4 }, (_, i) => anchor(`/series${i}`, 'Example 자막')).join('') +
    anchor('/exact', 'Example 1화 자막');
  const m = mock(url => isSearch(url) ? listing : url.endsWith('/exact') ? page('Example 1화 자막') :
    url.includes('/series') ? page('Example 자막', '13화.srt', 'https://files.example/13.srt') : srt());
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result?.sourceUrl, 'https://example-reviewer.tistory.com/exact', observation(result, m.calls));
});

test('query ranking: four batch fallbacks from the first query must not hide the second-query exact post', async () => {
  const batches = [9, 10, 11, 12].map(n => anchor(`/bad${n}`, `Example ${n}화 자막`)).join('');
  const m = mock(url => isSearch(url) ? queryOf(url) === 'Example 1' ? batches : anchor('/exact', 'Example 1화 자막') :
    url.endsWith('/exact') ? page('Example 1화 자막') : url.includes('/bad') ? '<h1>Example 13화 자막</h1>' : srt());
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result?.sourceUrl, 'https://example-reviewer.tistory.com/exact', observation(result, m.calls));
});

test('listing limit: retain the four-article budget even when later unseen entries could match', async () => {
  const listing = Array.from({ length: 4 }, (_, i) => anchor(`/stale${i}`, 'Example 1화 자막')).join('') +
    anchor('/exact', 'Example 1화 자막');
  const m = mock(url => isSearch(url) ? listing : url.endsWith('/exact') ? page('Example 1화 자막') :
    url.includes('/stale') ? page('Example 13화 자막', '13화.srt', 'https://files.example/13.srt') : srt());
  const result = await m.collector.collect(creator(), 1, signal());
  assert.equal(result, null, observation(result, m.calls));
  assert.equal(m.calls.filter(url=>/\/stale\d+$/.test(url)).length,4);
  assert.ok(!m.calls.some(url=>url.endsWith('/exact')), 'bounded search can miss later entries');
});

const longTitle = '가상 예제 작품';
const shorthandAliases: AliasEntry[] = [{ korean: longTitle, aliases: ['예제'] }];

function clientHttp(client: ReturnType<typeof createSubtitleClient>): PublicHttpClient {
  // Replace the shared HTTP boundary; keep metadata, search scheduling and ZIP logic real.
  return (client as unknown as { collector: { http: PublicHttpClient } }).collector.http;
}

for (const obstacle of ['compact query', 'archive navigation'] as const) {
  test(`deadline: existing shorthand result must survive a slow new ${obstacle}`, async t => {
    const client = createSubtitleClient({ aliases: shorthandAliases, enableAniList: false,
      enableKairan: false, enableCsora: false, enableMelody: false });
    const calls: { url: string; atMs: number }[] = [];
    const started = performance.now();
    clientHttp(client).get = async (url, options) => {
      calls.push({ url, atMs: Math.round(performance.now() - started) });
      options.signal.throwIfAborted();
      if (isSearch(url)) {
        const q = queryOf(url);
        if (q === '예제') return response(url, anchor('/exact', `${longTitle} 1화 자막`));
        if (q === longTitle.replace(/\s/g, '') && obstacle === 'compact query')
          await delay(1000, undefined, { signal: options.signal });
        else await delay(35, undefined, { signal: options.signal });
        return response(url, obstacle === 'archive navigation' ? anchor('/category/old', longTitle) : '');
      }
      if (url.includes('/category/')) {
        await delay(1000, undefined, { signal: options.signal });
        return response(url, '');
      }
      if (url.endsWith('/exact')) return response(url, page(`${longTitle} 1화 자막`));
      assert.equal(url, 'https://files.example/01.srt');
      return response(url, srt());
    };
    const result = await client.fetchCreatorSubtitle({
      creator: creator({ title: longTitle }), episode: 1, timeoutMs: 250,
    });
    t.diagnostic(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), calls }));
    assert.equal(result?.sourceUrl, 'https://example-reviewer.tistory.com/exact', JSON.stringify({ result, calls }));
  });
}

for (const discovery of ['예제', 'Example']) {
  test(`request envelope: ${discovery} discovery keeps queries, indexes, posts and files bounded`, async t => {
    const aliases = [{ korean: longTitle, aliases: ['예제', 'Example'] }];
    const calls: string[] = [];
    let active = 0, peak = 0, activeIndexes = 0, peakIndexes = 0;
    const http = new PublicHttpClient();
    http.get = async (url, options) => {
      calls.push(url); active++; peak = Math.max(peak, active);
      const index = isSearch(url) || url.includes('/category/');
      if (index) { activeIndexes++; peakIndexes = Math.max(peakIndexes, activeIndexes); }
      try {
        await delay(2, undefined, { signal: options.signal });
        if (isSearch(url)) return response(url, queryOf(url) === discovery ?
          Array.from({ length: 8 }, (_, i) => anchor(`/post${i}`, `${longTitle} 1화 자막`)).join('') :
          Array.from({ length: 8 }, (_, i) => anchor(`/category/c${i}`, longTitle)).join(''));
        if (url.includes('/category/')) return response(url, '');
        if (new URL(url).hostname === 'example-reviewer.tistory.com' && /^\/post\d+$/.test(new URL(url).pathname)) return response(url,
          `<h1>${longTitle} 1화 자막</h1><div class="post-body">` +
          Array.from({ length: 10 }, (_, i) => anchor(`https://files.example/${new URL(url).pathname.slice(1)}-${i}.srt`, '1화.srt')).join('') + '</div>');
        assert.equal(new URL(url).hostname, 'files.example');
        return response(url, srt('no Korean subtitle here'));
      } finally { active--; if (index) activeIndexes--; }
    };
    const collector = new BlogCollector(http, { maxZipBytes: 100_000, maxZipEntries: 20, aliases });
    const result = await collector.collect(creator({ title: longTitle, aliases: ['Example'] }), 1, signal());
    const counts = { searches: calls.filter(isSearch).length,
      archives: calls.filter(url => url.includes('/category/')).length,
      posts: calls.filter(url => new URL(url).hostname === 'example-reviewer.tistory.com' && /^\/post\d+$/.test(new URL(url).pathname)).length,
      downloads: calls.filter(url => new URL(url).hostname === 'files.example').length,
      total: calls.length, peak, peakIndexes };
    t.diagnostic(JSON.stringify(counts));
    assert.equal(result, null);
    assert.ok(counts.searches <= 5 && counts.archives <= 2 && counts.posts <= 4 && counts.downloads <= 24, JSON.stringify(counts));
    assert.ok(counts.total <= 24 && peakIndexes <= 3, JSON.stringify(counts));
  });
}

test('request envelope: public folders and Drive retry/confirmation stay within 24 HTTP calls per creator', async t => {
  const aliases = [{ korean: longTitle, aliases: ['예제', 'Example'] }];
  const calls: string[] = [];
  let active = 0, peak = 0;
  const http = new PublicHttpClient();
  http.get = async (url, options) => {
    calls.push(url); active++; peak = Math.max(peak, active);
    try {
      await delay(1, undefined, { signal: options.signal });
      const u = new URL(url);
      if (isSearch(url)) return response(url, queryOf(url) === 'Example' ?
        Array.from({ length: 8 }, (_, i) => anchor(`/post${i}`, `${longTitle} 1화 자막`)).join('') :
        Array.from({ length: 8 }, (_, i) => anchor(`/category/c${i}`, longTitle)).join(''));
      if (u.pathname.startsWith('/category/')) return response(url, '');
      if (/^\/post\d+$/.test(u.pathname)) return response(url,
        `<h1>${longTitle} 1화 자막</h1><div class="post-body">` +
        Array.from({ length: 8 }, (_, i) => anchor(`https://drive.google.com/drive/folders/review_folder_${u.pathname.slice(1)}_${i}`, '자막 폴더')).join('') + '</div>');
      if (u.hostname === 'drive.google.com') {
        const folderId = u.pathname.split('/').at(-1)!;
        const items = Array.from({ length: 10 }, (_, i) => [`review_file_${folderId}_${i}`, [folderId], `${longTitle} 1화.srt`]);
        return response(url, `window['_DRIVE_ivd'] = '${JSON.stringify([items])}';`);
      }
      if (u.hostname === 'docs.google.com') return response(url,
        `<html><form id="download-form" action="https://drive.usercontent.google.com/download">` +
        `<input name="id" value="${u.searchParams.get('id')}"><input name="confirm" value="review-confirmed"></form></html>`);
      assert.equal(u.hostname, 'drive.usercontent.google.com');
      if (u.searchParams.get('confirm') !== 'review-confirmed') throw new Error('Synthetic first Drive request failure');
      return response(url, srt('no Korean subtitle here'));
    } finally { active--; }
  };
  const collector = new BlogCollector(http, { maxZipBytes: 100_000, maxZipEntries: 20, aliases });
  const result = await collector.collect(creator({ title: longTitle, aliases: ['Example'] }), 1, signal());
  const counts = { searches: calls.filter(isSearch).length,
    archives: calls.filter(url => new URL(url).pathname.startsWith('/category/')).length,
    posts: calls.filter(url => /^\/post\d+$/.test(new URL(url).pathname)).length,
    folders: calls.filter(url => new URL(url).hostname === 'drive.google.com').length,
    downloads: calls.filter(url => ['docs.google.com', 'drive.usercontent.google.com'].includes(new URL(url).hostname)).length,
    total: calls.length, peak };
  t.diagnostic(JSON.stringify(counts));
  assert.equal(result, null);
  assert.ok(counts.searches <= 5 && counts.archives <= 2 && counts.posts <= 4 && counts.folders <= 8 && counts.downloads <= 72, JSON.stringify(counts));
  assert.ok(counts.total <= 24 && peak <= 3, JSON.stringify(counts));
});

for (const concurrency of [1, 4]) {
  test(`global request observation: independent creator/archive pools with concurrency ${concurrency}`, async t => {
    const client = createSubtitleClient({ enableAniList: false, concurrency });
    const calls: string[] = [];
    let active = 0, peak = 0;
    clientHttp(client).get = async (url, options) => {
      calls.push(url); active++; peak = Math.max(peak, active);
      try {
        if (url.includes('/anime/list/')) {
          await delay(2, undefined, { signal: options.signal });
          return response(url, JSON.stringify({ code: 'ok', data: { content: [{ animeNo: 42, subject: '예제작품' }], last: true } }));
        }
        if (url.includes('/caption/')) {
          await delay(2, undefined, { signal: options.signal });
          return response(url, JSON.stringify({ code: 'ok', data: Array.from({ length: 4 }, (_, i) => ({
            name: `합성 제작자 ${i}`, episode: '1', website: `https://review-maker${i}.tistory.com/latest`,
          })) }));
        }
        if (isSearch(url)) await delay(40, undefined, { signal: options.signal });
        else await delay(2, undefined, { signal: options.signal });
        return response(url, '');
      } finally { active--; }
    };
    const results = await client.searchSubtitles({ title: '예제작품', episode: 1, timeoutMs: 1500 });
    const counts = { total: calls.length, peak,
      searches: calls.filter(isSearch).length, metadata: calls.filter(url => url.includes('api.anissia.net')).length };
    t.diagnostic(JSON.stringify(counts));
    assert.deepEqual(results, []);
    // concurrency limits each creator pool, not all HTTP calls. Two index
    // requests per collector and the separate pools explain this upper bound.
    assert.ok(peak <= 2 * (Math.min(3, concurrency) + concurrency), JSON.stringify(counts));
    assert.equal(calls.filter(url => url.includes("/feeds/posts/default")).length, 2);
    // One bounded public-search fallback after the ordinary providers fail.
    assert.equal(calls.filter(url => url.startsWith('https://search.naver.com/')).length, 1);
    assert.ok(calls.length <= 23, JSON.stringify(counts));
  });
}

// A synthetic transport with two shared service slots isolates contention. This
// is a controlled capacity experiment, not a claim that PublicHttpClient has a pool.
function queuedTransport(http: PublicHttpClient, route: (url: string) => string, serviceMs: number) {
  let busy = 0, outstanding = 0, peakOutstanding = 0, peakServiced = 0;
  const waiting: (() => void)[] = [];
  const calls: string[] = [];
  const acquire = () => new Promise<void>(resolve => {
    if (busy < 2) { busy++; resolve(); } else waiting.push(resolve);
  });
  http.get = async (url: string, options: HttpOptions) => {
    calls.push(url); outstanding++; peakOutstanding = Math.max(peakOutstanding, outstanding);
    await acquire(); peakServiced = Math.max(peakServiced, busy);
    try {
      options.signal.throwIfAborted();
      await delay(serviceMs, undefined, { signal: options.signal });
      return response(url, route(url));
    } finally {
      outstanding--;
      const next = waiting.shift();
      if (next) next(); else busy--;
    }
  };
  return () => ({ calls, peakOutstanding, peakServiced, outstanding });
}

for (const legacy of [false, true]) {
  test(`shared-capacity deadline: existing synthetic archive result survives with legacy archive ${legacy ? 'default-enabled' : 'disabled'}`, async t => {
    const client = createSubtitleClient({ enableAniList: false, ...(legacy ? {} : { enableMelody: false }) });
    const stats = queuedTransport(clientHttp(client), url => {
      if (url.includes('api.anissia.net')) return JSON.stringify({ code: 'ok', data: { content: [], last: true } });
      if (isSearch(url)) return new URL(url).hostname === 'example-creator-b.blogspot.com' ? anchor('/exact', '예제작품 1화 자막') : '';
      if (url.endsWith('/exact')) return page('예제작품 1화 자막');
      assert.equal(url, 'https://files.example/01.srt');
      return srt();
    }, 100);
    const started = performance.now();
    const result = await client.searchSubtitles({ title: '예제작품', episode: 1, timeoutMs: 450 });
    await delay(0);
    t.diagnostic(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), ...stats() }));
    assert.equal(result[0]?.sourceUrl, 'https://example-creator-b.blogspot.com/exact', JSON.stringify({ result, ...stats() }));
  });
}

test('deadline control: already completed creator results survive a slow added archive', async t => {
  const client = createSubtitleClient({ enableAniList: false, enableKairan: false, enableCsora: false });
  const calls: string[] = [];
  clientHttp(client).get = async (url, options) => {
    calls.push(url);
    if (url.includes('example-legacy.tistory.com')) {
      await delay(1000, undefined, { signal: options.signal });
      return response(url, '');
    }
    if (url.includes('/anime/list/')) return response(url,
      JSON.stringify({ code: 'ok', data: { content: [{ animeNo: 42, subject: '예제작품' }], last: true } }));
    if (url.includes('/caption/')) return response(url,
      JSON.stringify({ code: 'ok', data: [{ name: '완료된 제작자', episode: '1', website: 'https://example-reviewer.tistory.com/exact' }] }));
    if (url.endsWith('/exact')) return response(url, page('예제작품 1화 자막'));
    assert.equal(url, 'https://files.example/01.srt');
    return response(url, srt());
  };
  const results = await client.searchSubtitles({ title: '예제작품', episode: 1, timeoutMs: 100 });
  t.diagnostic(JSON.stringify({ calls, completed: results.length }));
  assert.equal(results[0]?.creatorName, '완료된 제작자');
  assert.equal(results[0]?.sourceUrl, 'https://example-reviewer.tistory.com/exact');
});
