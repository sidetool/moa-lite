import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataClient } from '../src/metadata.js';
import { BlogCollector } from '../src/blogs.js';
import { PublicHttpClient } from '../src/http.js';
import type { SubtitleCreator } from '../src/types.js';

test('Anissia queries remove punctuation but identity and season selection remain strict',async()=>{
 const http=new PublicHttpClient(),calls:string[]=[];
 http.get=async url=>{
  const q=new URL(url).searchParams.get('q')!;calls.push(q);
  return {url,status:200,headers:{},body:Buffer.from(JSON.stringify({code:'ok',data:{last:true,content:q==='구름 정원' ? [
   {animeNo:1,subject:'구름 정원?!',originalSubject:''},
   {animeNo:2,subject:'구름 정원?! 2기',originalSubject:''},
   {animeNo:3,subject:'구름 정원 극장판',originalSubject:''},
  ]:[]}}))};
 };
 const metadata=new MetadataClient(http,[],false),signal=AbortSignal.timeout(2000);
 assert.equal((await metadata.lookup(['구름 정원?!'],1,signal))?.animeNo,1);
 assert.equal((await metadata.lookup(['구름 정원?!'],2,signal))?.animeNo,2);
 assert.equal(await metadata.lookup(['구름 정원?!'],3,signal),undefined);
 assert.deepEqual(calls,['구름 정원','구름 정원','구름 정원']);
});

test('punctuation variants share the existing query budget and ambiguous identities stay rejected',async()=>{
 const http=new PublicHttpClient(),calls:string[]=[];
 http.get=async url=>{calls.push(url);return {url,status:200,headers:{},body:Buffer.from(JSON.stringify({code:'ok',data:{last:true,content:[
  {animeNo:1,subject:'구름?!',originalSubject:''},{animeNo:2,subject:'구름!',originalSubject:''},
 ]}}))};};
 const metadata=new MetadataClient(http,[],false);
 assert.equal(await metadata.lookup(['구름?!','구름!','구름'],1,AbortSignal.timeout(2000)),undefined);
 assert.equal(calls.length,1);
});

const creator:SubtitleCreator={id:'test',name:'작성자',website:'https://maker.example/3',source:'anissia',title:'구름 정원',aliases:['Cloud Garden Secret Life'],season:1,episodeOffset:0,isCurrentEpisode:true,confidence:.95};
async function collect(title:string,filename:string,aliases=creator.aliases,source=creator.source){
 const http=new PublicHttpClient();
 http.get=async url=>({url,status:200,headers:{},body:Buffer.from(url==='https://files.example/'+encodeURIComponent(filename)
  ? '1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n'
  : `<h1>${title}</h1><div class="post-body"><a href="https://files.example/${encodeURIComponent(filename)}">${filename}</a></div>`)});
 const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
 return collector.collect({...creator,aliases,source},3,AbortSignal.timeout(2000),false,true);
}
test('a verified article establishes identity without filename aliases or a confidence penalty',async()=>{
 for(const title of ['구름 정원 3화','구름 정원']) {
  for(const name of ['Cloud Garden 03.srt','Cloud 03.srt','CGSL 03.srt','제작자약칭 03.srt']) {
   const candidate=await collect(title,name,[]);
   assert.equal(candidate?.matchedEpisode,3,`${title}: ${name}`);
   assert.equal(candidate?.confidence,.95,`${title}: ${name}`);
  }
 }
});
test('article trust never overrides conflicting post identity, episode or explicit file season',async()=>{
 for(const [title,name] of [
  ['다른 작품 3화','CGSL 03.srt'],['구름 정원 4화','CGSL 03.srt'],
  ['구름 정원 2기 3화','CGSL 03.srt'],['구름 정원 극장판 3화','CGSL 03.srt'],
  ['구름 정원 3화','CGSL 04.srt'],['구름 정원 3화','CGSL S2E03.srt'],
 ])assert.equal(await collect(title,name),null,`${title}: ${name}`);
});
test('direct Anissia files inherit work identity but still check episode and season',async()=>{
 const http=new PublicHttpClient();
 http.get=async url=>({url,status:200,headers:{},body:Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n')});
 const collector=new BlogCollector(http,{maxZipBytes:10000,maxZipEntries:10,aliases:[]});
 for(const [name,accepted] of [['CGSL 03.srt',true],['CGSL 04.srt',false],['CGSL S2E03.srt',false]] as const){
  const result=await collector.collect({...creator,aliases:[],website:'https://files.example/'+encodeURIComponent(name)},3,AbortSignal.timeout(2000),false,true);
  assert.equal(Boolean(result),accepted,name);
  if(result)assert.equal(result.confidence,.95);
 }
});
