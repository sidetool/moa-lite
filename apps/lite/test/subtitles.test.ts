import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOnlineSubtitles } from '../server/subtitles.js';
import { subtitleSearchTtl, reuseSubtitleSearch } from '../client/subtitle-cache.js';
import type { SubtitleCandidate } from '@moa/subtitles-ko';
const query = { title: '가상의 작품', season: 1, episode: 3 };
const candidate = (id: string, content = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n테스트\n'): SubtitleCandidate => ({
  id, creatorId: 'test', creatorName: '작성자', sourceUrl: 'https://example.com/3', format: 'vtt', content,
  filename: '03.vtt', episode: 3, matchedEpisode: 3, title: query.title, season: 1, confidence: .9,
});
test('subtitle response keeps completed candidates and bounded diagnostics without network error details', async () => {
  const signal = AbortSignal.timeout(1000);
  const result = await searchOnlineSubtitles(query,signal, options => {
    assert.equal(options.maxResponseBytes,2*1024*1024);assert.equal(options.maxZipBytes,4*1024*1024);
    assert.equal(options.maxRequests,64);
    return {async searchSubtitles(input) {
      assert.equal(input.signal,signal);assert.equal(input.timeoutMs,20000);
      for(let i=0;i<20;i++) options.onDiagnostic?.({stage:'page',code:'error',creatorName:'작성자',message:'HTTP 403 https://private.example/?token=secret'});
      options.onDiagnostic?.({stage:'page',code:'timeout',message:'secret raw error'});
      return [candidate('large','가'.repeat(400000)),candidate('1'),candidate('2'),candidate('3'),candidate('4')];
    }};
  });
  assert.deepEqual(result.candidates.map(c=>c.id),['1','2','3']);
  assert.equal(result.partial,true);assert.deepEqual(result.issues,[{kind:'access-denied',creatorName:'작성자'},{kind:'timeout'}]);
  assert(!JSON.stringify(result.issues).includes('secret'));
  const next=await searchOnlineSubtitles(query,signal,()=>({searchSubtitles:async()=>[]}));
  assert.deepEqual(next,{candidates:[],partial:false,issues:[]});
});

test('positive, partial and failed searches have bounded reuse with explicit retry', () => {
  const complete = { candidates: [candidate('1')], partial: false };
  assert.equal(subtitleSearchTtl(complete), 86400000);
  assert.equal(subtitleSearchTtl({ ...complete, partial: true }), 300000);
  assert.equal(subtitleSearchTtl({ candidates: [], partial: true }), 30000);
  assert.equal(reuseSubtitleSearch({ queryKey: 'one', result: complete }, 'one', false), true);
  assert.equal(reuseSubtitleSearch({ queryKey: 'one', result: complete }, 'one', true), false);
  assert.equal(reuseSubtitleSearch({ queryKey: 'one', result: complete }, 'two', false), false);
});
