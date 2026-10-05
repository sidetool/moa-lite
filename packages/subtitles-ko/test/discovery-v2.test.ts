import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAttachmentLinks, BlogCollector } from '../src/blogs.js';
import { parseCreatorDirectory, directoryCreators } from '../src/directory.js';
import { PublicHttpClient } from '../src/http.js';
import { extractSubtitleBuffer } from '../src/archive.js';
import { readFile } from 'node:fs/promises';
import { createOfflineSubtitleClient } from './fixtures/synthetic.js';

test('completion markers do not hide a matching subtitle or authorize another season or edition', async () => {
 for (const [title, accepted] of [
  ['구름 정원 3화 (終) 자막',true], ['구름 정원 3화 [終]',true],
  ['구름 정원 2기 3화 (終) 자막',false], ['구름 정원 극장판 3화 (終) 자막',false],
 ] as const) {
  const http=new PublicHttpClient(), calls:string[]=[];
  http.get=async url=>{
   calls.push(url);
   const body=url.endsWith('/03.srt')?'1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n':
    `<h1>${title}</h1><div class="post-body"><a href="https://files.example/03.srt">03.srt</a></div>`;
   return {url,status:200,headers:{},body:Buffer.from(body)};
  };
  const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
  const result=await collector.collect({id:'x',name:'작성자',website:'https://example-maker.tistory.com/3',source:'anissia',title:'구름 정원',season:1,episodeOffset:0,isCurrentEpisode:true,confidence:.9},3,AbortSignal.timeout(3000),false,true);
  assert.equal(Boolean(result),accepted,title);
  assert.equal(calls.length,accepted?2:1);
 }
});

test('Anissia article under a searched archive is still fetched without repeating archive searches', async () => {
 for (const matching of [true,false]) {
  const client=createOfflineSubtitleClient({enableCsora:false,enableMelody:false});
  const internal=client as unknown as {collector:{http:PublicHttpClient};metadata:{creators:()=>Promise<any[]>}};
  const article='https://example-creator-a.blogspot.com/2026/03/known.html';
  internal.metadata.creators=async()=>[{id:'known',name:'Example Creator A',website:article,source:'anissia',title:'구름 정원',season:1,episodeOffset:0,isCurrentEpisode:true,confidence:.9}];
  const calls:string[]=[];
  internal.collector.http.get=async url=>{
   calls.push(url);
   const body=url===article?`<h1>구름 정원 ${matching?'3':'4'}화 자막</h1><div class="post-body"><a href="https://files.example/03.srt">03.srt</a></div>`:
    url.endsWith('/03.srt')?'1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n':'<html></html>';
   return {url,status:200,headers:{},body:Buffer.from(body)};
  };
  const results=await client.searchSubtitles({title:'구름 정원',season:1,episode:3,timeoutMs:3000});
  assert.equal(results.length,matching?1:0);
  assert.equal(calls.filter(url=>url===article).length,1);
  const searches=calls.filter(url=>url.includes('/search?'));
  assert.equal(searches.length,new Set(searches).size,'known article must not launch duplicate archive searches');
 }
});

test('button and script attachments are found without scripts running, private URLs and captcha buttons excluded', () => {
 const html='<div class="post-body"><button data-file-url="https://files.example/get/1">1화 자막</button><a href="https://files.example/1.7z">1화 묶음</a><button data-download="http://127.0.0.1/1.srt">1화</button></div><script>window.test="https://files.example/1.srt"</script>';
 assert.equal(extractAttachmentLinks(html,'https://blog.example/1').length,3);
 assert.equal(extractAttachmentLinks(html+'<div class="g-recaptcha"></div>','https://blog.example/1').length,2);
});
test('public directory records preserve provenance, and an alias without season cannot authorize the wrong season', () => {
 const rows=parseCreatorDirectory('<div class="tt_article_useless_p_margin"><p>구름 정원 2기 (Cloud Garden) ● <a href="https://example-maker.tistory.com/12">제작자</a></p><p>다른 글 <a href="https://example.com/">광고</a></p></div>','https://directory.example/1');
 assert.equal(rows.length,1);assert.equal(rows[0].reference,'https://directory.example/1');
 const resolved={title:'구름 정원',baseTitle:'구름 정원',aliases:['Cloud Garden'],season:1,episodeOffset:0,source:'input' as const,confidence:.9};
 assert.equal(directoryCreators(resolved,rows).length,0);
 assert.equal(directoryCreators({...resolved,season:2},rows).length,1);
});
test('a later search page finds the right episode and does not accept another season',async()=>{
 const http=new PublicHttpClient(), calls:string[]=[];
 http.get=async(url)=>{
  calls.push(url);
  let text='';
  if(url.includes('page=2'))text='<a href="/wrong">구름 정원 2기 3화</a><a href="/good">구름 정원 3화 자막</a>';
  else if(url.includes('/search/'))text='<a href="?page=2">다음</a>';
  else if(url.endsWith('/good'))text='<h1>구름 정원 3화 자막</h1><div class="post-body"><button data-file-url="https://files.example/03.srt">3화 자막</button></div>';
  else if(url.endsWith('03.srt'))text='1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n';
  return {url,status:200,headers:{},body:Buffer.from(text)};
 };
 const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
 const result=await collector.collect({id:'x',name:'작성자',website:'https://example-maker.tistory.com/',source:'archive',title:'구름 정원',season:1,episodeOffset:0,isCurrentEpisode:false,confidence:.9},3,AbortSignal.timeout(3000));
 assert.ok(result?.content.includes('안녕하세요'));assert.ok(!calls.some(url=>url.endsWith('/wrong')));assert.ok(calls.length<=24);
});
test('WASM 7z/TAR decoding selects episodes without installed binaries and enforces limits',async()=>{
 for (const ext of ['7z','tar']) {
  const buffer=await readFile(new URL(`fixtures/lite-episodes.${ext}`,import.meta.url));
  const result=await extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3});
  assert.equal(result?.matchedEpisode,3);assert.ok(result?.content.includes('테스트 3화'));
  assert.equal(await extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:9}),null);
  assert.equal(await extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3,acceptFilename:()=>false}),null);
  await assert.rejects(extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3,maxEntries:1}),/limit/);
  await assert.rejects(extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3,maxZipBytes:5}),/limit/);
  await assert.rejects(extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3,signal:AbortSignal.abort()}));
  const abort=new AbortController();
  const pending=extractSubtitleBuffer(buffer,`batch.${ext}`,{episode:3,signal:abort.signal});
  setTimeout(()=>abort.abort(),1);await assert.rejects(pending,/aborted/);
 }
 const encrypted=await readFile(new URL('fixtures/lite-encrypted.7z',import.meta.url));
 assert.equal(await extractSubtitleBuffer(encrypted,'batch.7z',{episode:3}).catch(()=>null),null);
});
test('RSS fallback checks title, season and episode before downloading a post',async()=>{
 const http=new PublicHttpClient(),calls:string[]=[];
 http.get=async(raw:any)=>{
  const url=String(raw);calls.push(url);let text='<html>no matches</html>';
  if(url.endsWith('/rss'))text='<rss><channel><item><title>구름 정원 2기 3화 자막</title><link>https://example-maker.tistory.com/wrong</link></item><item><title>구름 정원 3화 자막</title><link>https://example-maker.tistory.com/good</link></item></channel></rss>';
  if(url.endsWith('/good'))text='<h1>구름 정원 3화 자막</h1><div class="post-body"><a href="https://files.example/03.srt">3화 자막</a></div>';
  if(url.endsWith('03.srt'))text='1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n';
  return {url,status:200,headers:{},body:Buffer.from(text)};
 };
 const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
 const result=await collector.collect({id:'x',name:'작성자',website:'https://example-maker.tistory.com/',source:'archive',title:'구름 정원',season:1,episodeOffset:0,isCurrentEpisode:false,confidence:.9},3,AbortSignal.timeout(3000));
 assert.ok(result?.content.includes('안녕하세요'));assert.ok(!calls.some(url=>url.endsWith('/wrong')));assert.ok(calls.length<=24);
});
