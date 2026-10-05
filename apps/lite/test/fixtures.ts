export const repository = 'https://fixture.example.org/index.json';
export const registry = [{ id: 123, name: 'Fixture Anime', lang: 'ko', version: '1.0', itemType: 1, sourceCodeLanguage: 1, baseUrl: 'https://fixture.example.org', sourceCodeUrl: 'https://fixture.example.org/source.js' }];
export const subtitle = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n안녕하세요\n';
export const assSubtitle = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Pretendard,30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:07.00,Default,,0,0,0,,한국어 ASS 검증
`;
export const source = `class DefaultExtension extends MProvider {
  getSourcePreferences(){return [{key:'label',editTextPreference:{title:'Label',value:'Default'}}];}
  getFilterList(){return [{type_name:'SelectFilter',name:'장르',values:['모두','드라마'],state:0}];}
  async getPopular(){const r=await new Client().get('https://fixture.example.org/list');const doc=new Document(r.body);return {list:[{name:doc.selectFirst('h1').text,link:'/one',imageUrl:'https://fixture.example.org/poster.png'},{name:'Fixture Series Season 2',link:'/two'}],hasNextPage:false};}
  async getLatestUpdates(){return this.getPopular();}
  async search(query){if(query==='slow')await new Client().get('https://fixture.example.org/slow');return query==='Fixture'?this.getPopular():{list:[],hasNextPage:false};}
  async getDetail(url){return {name:url==='/two'?'Fixture Series Season 2':'Fixture Series',link:url,description:'원본 MOA 화면 검증',chapters:[{name:'1화',url:url+'/ep1'},{name:'2화',url:url+'/ep2'}]};}
  async getVideoList(){return [{url:'https://media.fixture.example.org/video.mp4',quality:'720p',headers:{Referer:'https://fixture.example.org/'},subtitles:[{file:'https://fixture.example.org/ko.vtt',label:'한국어'},{file:'https://fixture.example.org/style.ass',label:'한국어 ASS'}]},{url:'https://media.fixture.example.org/master.m3u8',quality:'1080p HLS',headers:{Referer:'https://fixture.example.org/'}}];}
}`;
export async function fixtureTransport(input: any, signal: AbortSignal) {
  signal.throwIfAborted();
  let value = '', contentType = 'text/plain';
  if (input.url === repository) { value = JSON.stringify(registry); contentType = 'application/json'; }
  else if (input.url.endsWith('/source.js')) value = source;
  else if (input.url.endsWith('/list')) { value = '<h1>Fixture Series</h1>'; contentType = 'text/html'; }
  else if (input.url.endsWith('/slow')) { await new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); }
  else if (input.url.endsWith('/ko.vtt')) { value = subtitle; contentType = 'text/vtt'; }
  else if (input.url.endsWith('/style.ass')) value = assSubtitle;
  else if (input.url.includes('graphql.anilist.co')) { value = '{"data":{"Page":{"media":[]}}}'; contentType = 'application/json'; }
  else throw new Error('unexpected-fixture-request');
  const bytes = Buffer.from(value);
  return { statusCode: 200, contentType, headers: {}, bytes: bytes.toString('base64'), size: bytes.length, isRedirect: false, request: { url: input.url, method: input.method ?? 'GET', headers: input.headers ?? {}, contentLength: 0, followRedirects: true, maxRedirects: 5 } };
}
