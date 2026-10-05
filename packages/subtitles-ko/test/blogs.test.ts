import test from "node:test";
import assert from "node:assert/strict";
import { extractAttachmentLinks, googleDriveDownloadUrl, naverPostUrl, responseFilename } from "../src/blogs.js";

test("Tistory, Blogger and Naver attachments are recognized without executing scripts", () => {
  const html = `<div class="post-body">
    <a href="https://files.example.com/attachment/sample.zip?attach=1">작품 03.zip</a>
    <a href="https://drive.google.com/file/d/abcdefghijklmnop/view">자막</a>
    <a href="https://public.example/fonts.zip">폰트 다운로드</a>
    <a href="http://127.0.0.1/bad.zip">작품 03.zip</a>
    </div><aside><a href="https://public.example/wrong.zip">다른 작품</a></aside>
    <script>var attachment = {"encodedAttachFileUrl":"https%3A%2F%2Ffiles.example.org%2Ffile%2F03.smi"};</script>`;
  const links = extractAttachmentLinks(html, "https://public.example/post");
  assert.equal(links.length, 3);
  assert.ok(links.some(link => link.url.includes("files.example.org")));
  assert.ok(!links.some(link => /wrong|fonts|127\.0/.test(link.url)));
});

test("cloud direct URLs require a real Google host; Naver posts use the frame-free URL", () => {
  assert.equal(googleDriveDownloadUrl("https://evil.example/file/d/abcdefghijklmnop"), undefined);
  assert.equal(googleDriveDownloadUrl("https://drive.google.com.evil.example/file/d/abcdefghijklmnop"), undefined);
  assert.ok(googleDriveDownloadUrl("https://docs.google.com/uc?id=abcdefghijklmnop&export=download")?.startsWith("https://drive.usercontent.google.com/download?"));
  const url = new URL(naverPostUrl("https://m.blog.naver.com/test/123456789"));
  assert.equal(url.pathname, "/PostView.naver"); assert.equal(url.searchParams.get("blogId"), "test");
  assert.equal(url.searchParams.get("logNo"), "123456789");
});

test("UTF-8 Content-Disposition filenames decode RFC5987 and legacy Latin-1 headers", () => {
  const name = "예제 03.ass";
  const base = { url: "https://public.example/download", status: 200, body: Buffer.alloc(0) };
  assert.equal(responseFilename({ ...base, headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } }, "fallback"), name);
  assert.equal(responseFilename({ ...base, headers: { "content-disposition": `attachment; filename="${Buffer.from(name).toString("latin1")}"` } }, "fallback"), name);
});

test('verified shorthand seasons are accepted without confusing episode numbers or other seasons', async () => {
  const { BlogCollector } = await import('../src/blogs.js');
  const { PublicHttpClient } = await import('../src/http.js');
  const aliases=[{korean:'별나라 탐험 ~먼 행성에서 길을 찾는다~',aliases:['별나라 탐험']}];
  const collector=new BlogCollector(new PublicHttpClient(),{maxZipBytes:10000,maxZipEntries:10,aliases}) as any;
  const creator={title:aliases[0].korean+' 3기',season:3,episodeOffset:0,website:'https://example-creator-a.blogspot.com/'};
  assert.equal(collector.episodeMatch('별나라 탐험3 3화 자막',creator,3),true);
  assert.equal(collector.episodeMatch('별나라 탐험2 3화 자막',creator,3),false);
  assert.equal(collector.episodeMatch('별나라 탐험 3화 자막',creator,3),false);
  assert.equal(collector.episodeMatch('별나라 탐험3 13화 자막',creator,3),false);
  assert.ok(collector.searchUrls(creator,3).some((url:string)=>new URL(url).searchParams.get('q')==='별나라 탐험'));
});

test('public Drive folders accept only subtitle files from the exact folder without executing script data', async () => {
  const {publicDriveFiles,googleDriveFolderId}=await import('../src/blogs.js');
  const folder='folder_123456789';
  const payload=JSON.stringify([[['file_123456789',[folder],'작품 03.smi'],['other_123456789',['different_folder'],'작품 03.ass'],['video_123456789',[folder],'video.mp4']]]);
  const escaped=[...payload].map(c=>c==='"'?'\\x22':c==='['?'\\x5b':c===']'?'\\x5d':c).join('');
  assert.deepEqual(publicDriveFiles(`window['_DRIVE_ivd'] = '${escaped}';`,folder),[{url:'https://drive.google.com/file/d/file_123456789/view',label:'작품 03.smi'}]);
  assert.deepEqual(publicDriveFiles("window['_DRIVE_ivd'] = 'not-json';",folder),[]);
  assert.equal(googleDriveFolderId(`https://drive.google.com/drive/folders/${folder}`),folder);
  assert.equal(googleDriveFolderId(`https://drive.google.com.evil.test/drive/folders/${folder}`),undefined);
  assert.equal(extractAttachmentLinks(`<div class="post-body"><a href="https://drive.google.com/drive/folders/${folder}">작품 자막</a></div>`,'https://example.org').length,1);
});

test('Synthetic Blogger series pages require matching season and numbered attachments', async () => {
  const {BlogCollector} = await import('../src/blogs.js');
  const {PublicHttpClient} = await import('../src/http.js');
  const http = new PublicHttpClient(), calls: string[] = [];
  http.get = async url => {
    calls.push(url);
    const body = url.includes('/search?') ? '<a href="/2023/series.html">별빛 학교 2기 자막</a><a href="/2023/wrong.html">별빛 학교 3기 자막</a>' : url.endsWith('.html') ? '<h1>별빛 학교 2기 자막</h1><div class="post-body"><a href="https://public.example/01.srt">1화</a><a href="https://public.example/02.srt">2화</a></div>' : '1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n';
    return {url,status:200,headers:{},body:Buffer.from(body)};
  };
  const collector = new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  const c = {id:'c',name:'Example Creator B',website:'https://example-creator-b.blogspot.com/',source:'archive' as const,title:'별빛 학교 2기',season:2,episodeOffset:24,isCurrentEpisode:false,confidence:.85};
  const result = await collector.collect(c,1,new AbortController().signal);
  assert.equal(result?.matchedEpisode,1); assert.match(result?.content ?? '',/안녕하세요/);
  assert.ok(!calls.some(url=>url.includes('wrong') || url.endsWith('02.srt')));
});

test('named arcs cannot masquerade as season one; absolute bare numbers are not shorthand seasons', async () => {
  const {BlogCollector} = await import('../src/blogs.js');
  const {PublicHttpClient} = await import('../src/http.js');
  const aliases = (await import('./fixtures/synthetic.js')).aliases;
  const collector = new BlogCollector(new PublicHttpClient(),{maxZipBytes:10000,maxZipEntries:10,aliases}) as any;
  const c = {title:'별빛 학교',season:1,episodeOffset:0};
  assert.equal(collector.episodeMatch('별빛 학교 별의 여행 전편 1화 자막',c,1),false);
  assert.equal(collector.episodeMatch('별빛 학교 별의 여행 전편 1화 자막',{...c,title:'별빛 학교 3기',season:3,episodeOffset:47},1),true);
  const s2={...c,title:'별빛 학교 2기',season:2,episodeOffset:24};
  assert.equal(collector.episodeMatch('별빛 학교 25',s2,1),true);
  assert.equal(collector.episodeMatch('별빛 학교 2기 25화',s2,1),true);
  assert.equal(collector.episodeMatch('별빛 학교 3기 25화',s2,1),false);
});

import { readFileSync } from 'node:fs';
import { BlogCollector } from '../src/blogs.js';
import { PublicHttpClient } from '../src/http.js';
import type { SubtitleCreator } from '../src/types.js';
const legacyCreator: SubtitleCreator = {id:'legacy',name:'Example maker',website:'https://example-catalog.tistory.com/',source:'archive',
  title:'가상 작품 1기',season:1,episodeOffset:0,aliases:['Fixture Adventure'],isCurrentEpisode:false,confidence:.85};
const batchZip = readFileSync(new URL('fixtures/legacy-series.zip',import.meta.url));
const response = (url: string, body: string | Buffer) => ({url,status:200,headers:{},body:typeof body === 'string' ? Buffer.from(body) : body});

test('final-episode posts without a first-season label yield only the requested numbered ZIP entry', async () => {
  const http = new PublicHttpClient(), calls: string[] = [];
  http.get=async url => {
    calls.push(url);
    if(url.includes('/search/')) return response(url,'<a href="/later">가상 작품 2기 25화 자막</a><a href="/film">가상 작품 극장판 25화 자막</a><a href="/final">가상 작품 25화 자막<span class="cnt">37</span></a>');
    if(url.endsWith('/final')) return response(url,'<h1>가상 작품 25화 자막</h1><div class="post-body"><a href="https://public.example/batch.zip">가상 작품 1~25화 통합 자막.zip</a></div>');
    assert.equal(url,'https://public.example/batch.zip');return response(url,batchZip);
  };
  const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  const first=await collector.collect(legacyCreator,1,new AbortController().signal);
  assert.equal(first?.filename,'가상 작품 - 01.smi');assert.equal(first?.matchedEpisode,1);
  assert.match(first?.content ?? '',/첫 화/);assert.doesNotMatch(first?.content ?? '',/마지막 화|다음 시즌/);
  assert.ok(!calls.some(url=>url.endsWith('/later')||url.endsWith('/film')));
  assert.equal(await collector.collect(legacyCreator,9,new AbortController().signal),null,'missing episode never falls back to final/unnumbered file');
});

test('a season-specific archive category finds older posts buried under newer seasons', async () => {
  const http=new PublicHttpClient(), calls: string[]=[];
  http.get=async url=> {
    calls.push(url);
    if(url.includes('/search/')) return response(url,'<a href="/latest">가상 작품 3기 1화 자막</a><a href="/category/old">가상 작품<span class="c_cnt">(27)</span></a><a href="/category/later">가상 작품 2기 (25)</a><a href="https://evil.example/category/old">가상 작품</a>');
    if(url.endsWith('/category/old')) return response(url,'<a href="/final">가상 작품 완결 자막</a>');
    if(url.endsWith('/final')) return response(url,'<h1>가상 작품 자막</h1><div class="post-body"><a href="https://public.example/batch.zip">1~25화 통합 자막.zip</a></div>');
    assert.equal(url,'https://public.example/batch.zip');return response(url,batchZip);
  };
  const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  assert.equal((await collector.collect(legacyCreator,2,new AbortController().signal))?.matchedEpisode,2);
  assert.ok(calls.some(url=>url.endsWith('/category/old')));
  assert.ok(!calls.some(url=>url.includes('evil')||url.endsWith('/latest')||url.endsWith('/category/later')));
});

test('first-season archive search can check the oldest index page without crawling intermediate pages', async () => {
  const http=new PublicHttpClient(), calls: string[]=[];
  http.get=async url=> {
    calls.push(url);
    if(url.includes('page=10')) return response(url,'<a href="/first">가상 작품 1화 자막</a>');
    if(url.includes('/search/')) return response(url,`<a href="/search/${encodeURIComponent('가상 작품')}?page=2">2</a><a href="/search/${encodeURIComponent('가상 작품')}?page=10">10</a>`);
    if(url.endsWith('/first')) return response(url,'<h1>가상 작품 1화 자막</h1><div class="post-body"><a href="https://public.example/01.srt">1화.srt</a></div>');
    assert.equal(url,'https://public.example/01.srt');return response(url,'1\n00:00:01,000 --> 00:00:02,000\n첫 화\n');
  };
  const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  assert.equal((await collector.collect(legacyCreator,1,new AbortController().signal))?.matchedEpisode,1);
  assert.ok(!calls.some(url=>url.includes('page=2')));assert.ok(calls.length<=7, 'four title queries, one oldest index, one article and its file; no intermediate-page crawl');
});

test('compact spelling and verified English aliases widen discovery while seasons and editions remain separate', async () => {
  const http=new PublicHttpClient(), queries: string[]=[], calls:string[]=[];
  http.get=async url=> {
    calls.push(url);
    if(url.includes('/search/')) {
      const q=decodeURIComponent(new URL(url).pathname.slice('/search/'.length));queries.push(q);
      return response(url,q==='Fixture Adventure' ? '<a href="/first">Fixture Adventure 1화 자막</a><a href="/ova">Fixture Adventure OVA 25화 자막</a>' : '');
    }
    if(url.endsWith('/first')) return response(url,'<h1>Fixture Adventure 1화 자막</h1><div class="post-body"><a href="https://public.example/01.srt">1화.srt</a></div>');
    assert.equal(url,'https://public.example/01.srt');return response(url,'1\n00:00:01,000 --> 00:00:02,000\n첫 화\n');
  };
  const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  assert.equal((await collector.collect(legacyCreator,1,new AbortController().signal))?.matchedEpisode,1);
  assert.ok(queries.includes('가상 작품'));assert.ok(queries.includes('가상작품'));assert.ok(queries.includes('Fixture Adventure'));
  assert.ok(queries.every(q=>!q.includes('1기')));assert.ok(!calls.some(url=>url.endsWith('/ova')));
  const internal=collector as any;
  assert.equal(internal.batchPage('가상 작품 25화 자막',{...legacyCreator,season:2}),false);
  assert.equal(internal.batchPage('가상 작품 극장판 25화 자막',legacyCreator),false);
  assert.equal(internal.batchPage('가상 작품 외전 25화 자막',legacyCreator),false);
  assert.equal(internal.batchPage('가상 작품 2기 25화 자막',legacyCreator),false);
  assert.equal(internal.batchPage('가상 작품 2기 25화 자막',{...legacyCreator,title:'가상 작품 2기',season:2}),true);
});

test('article identity keeps exact short titles, known arcs, episode labels and completion tags without erasing other editions',async()=>{
  const collector=new BlogCollector(new PublicHttpClient(),{maxZipBytes:10000,maxZipEntries:10,aliases:[]}) as any;
  const c={...legacyCreator,season:2,title:'가상 작품 2기',aliases:['짧음','가상 작품 2기 「다음 이야기」']};
  for(const title of ['가상 작품 2기 제3화 자막','가상 작품 2기 第3話 字幕','짧음 2기 13화 (24화) (完)','가상 작품 2기 3화 자막 (완)','가상 작품 2기 「다음 이야기」 3화 자막'])assert.equal(collector.titleMatches(title,c),true,title);
  for(const title of ['가상 작품 외전 3화 자막','가상 작품 - 2 Movie','가상 작품 0 1화 자막','가상 작품 전편 자막'])assert.equal(collector.titleMatches(title,c),false,title);
  assert.equal(collector.titleMatches('86 1화 자막',{...legacyCreator,title:'86',aliases:[]}),true);
  assert.equal(collector.postSeason('가상 작품 II 1화 자막',legacyCreator),2);
});


test('complete-season post with dual numbering and 完 retains the established absolute-episode subtitle',async()=>{
  const http=new PublicHttpClient();
  const creator:SubtitleCreator={...legacyCreator,source:'anissia',website:'https://example-catalog.tistory.com/last',
    title:'구름 정원 2기',aliases:['Example TV','구름정원극'],season:2,episodeOffset:11};
  http.get=async url=>url.endsWith('/last')
    ?response(url,'<h1>구름정원극 2기 13화 (24화) (完)</h1><div class="post-body"><a href="https://public.example/all.zip">구름 2기 1-13화.zip\n10MB</a></div>')
    :response(url,readFileSync(new URL('fixtures/absolute.zip',import.meta.url)));
  const result=await new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]}).collect(creator,3,new AbortController().signal);
  assert.equal(result?.matchedEpisode,14);
  assert.equal(result?.filename,'Example TV - 14.ass');
  assert.ok(result!.confidence >= .5);
});

test('release tags and a work-in-progress suffix do not discard an otherwise matching subtitle file',async()=>{
  const collector=new BlogCollector(new PublicHttpClient(),{maxZipBytes:10000,maxZipEntries:10,aliases:[]}) as any;
  const c={...legacyCreator,title:'구름 정원 2기',season:2,aliases:['Example TV','구름정원극']};
  for(const name of ['[FixtureGroup] Example TV - 14.ass','[FixtureGroup] Example TV - 14 [1080p] (AAC).ass','구름정원극2 3화 미완성.ass'])
    assert.equal(collector.fileIdentity(name,c),true,name);
  for(const name of ['Different Work - 14.ass','Example TV Movie - 14.ass','다른작품 3화.ass'])
    assert.equal(collector.fileIdentity(name,c),false,name);
});

test('numeric series title is not an episode; opaque Drive bundle requires the requested numbered file', async () => {
  const http = new PublicHttpClient();
  const creator = {...legacyCreator, title:'로봇탐험대 100', aliases:['Robot Explorers 100']};
  const collector = new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]}) as any;
  assert.equal(collector.titleMatches('로봇 탐험대 100',creator),true);
  assert.equal(collector.seriesPage('로봇 탐험대 100',creator),true);
  assert.equal(collector.episodeMatch('로봇 탐험대 100',creator,100),false);
  assert.equal(collector.episodeMatch('로봇 탐험대 100 1화 자막',creator,1),true);
  assert.equal(collector.titleMatches('로봇 탐험대 100 2기 OVA',creator),false);
  const drive='https://drive.google.com/file/d/abcdefghijklmnop/view';
  http.get=async url=>response(url,batchZip);
  // The series article establishes the work; filenames only select numbered episodes.
  assert.equal((await collector.fromPage({url:'https://example-catalog.blogspot.com/series',html:`<h1>로봇 탐험대 100</h1><div class="post-body"><a href="${drive}">DL</a></div>`},creator,1,new AbortController().signal))?.matchedEpisode,1);
  assert.equal(await collector.fromPage({url:'https://example-catalog.blogspot.com/series',html:`<h1>로봇 탐험대 100</h1><div class="post-body"><a href="${drive}">DL</a></div>`},creator,100,new AbortController().signal),null);
  const valid = new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]}) as any;
  assert.equal((await valid.fromPage({url:'https://example-catalog.blogspot.com/series',html:`<h1>가상 작품</h1><div class="post-body"><a href="${drive}">DL</a></div>`},legacyCreator,1,new AbortController().signal))?.matchedEpisode,1);
});
