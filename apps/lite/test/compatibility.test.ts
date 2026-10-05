import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { sourceHttp } from '../server/network.js';
import { compatibilityHttp } from '../../../packages/extensions/src/http.js';
import { requestSpec } from '../connector/policy.js';
import { boundedFetch } from '../connector/fetch.js';
import { followSourceRedirects } from '../connector/redirects.js';
import { inlineSubtitle, remoteMediaType } from '../../../apps/server/src/remote-media.js';

test('both Lite transports retain upstream methods, redirects, headers and request options', async () => {
  const server = createServer(async (req,res) => {
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/end','X-Token':'redirect-token'});res.end();return;}
    if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();return;}
    let body='';for await(const part of req)body+=part;
    res.writeHead(200,{'Content-Type':'text/plain','X-Token':'upstream-token','X-Method':req.method!});res.end(body||'ok');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  const relay=(input:any)=>sourceHttp({...input,url:origin+new URL(input.url).pathname},AbortSignal.timeout(3000),(request,signal,_origins,max)=>compatibilityHttp(request,signal,[origin],max));
  const connector=(input:any)=>followSourceRedirects(requestSpec(input),(spec:any)=>boundedFetch({...spec,url:origin+new URL(spec.url).pathname},crypto.randomUUID()));
  try {
    for(const transport of [relay,connector]) {
      for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) {
        const body=['GET','HEAD'].includes(method)?undefined:'한글 body';
        const response=await transport({url:'https://fixture.example.org/end',method,body,headers:{'X-Test':'value'}});
        assert.equal(response.statusCode,200,method+': '+Buffer.from(response.bytes,'base64'));assert.equal(response.headers['x-method'],method);assert.equal(response.headers['x-token'],'upstream-token');
        if(body)assert.equal(Buffer.from(response.bytes,'base64').toString(),body);
        assert.equal(response.request.maxRedirects,4);
      }
      const followed=await transport({url:'https://fixture.example.org/redirect'});assert.equal(followed.statusCode,200);
      const stopped=await transport({url:'https://fixture.example.org/redirect',options:{followRedirects:false}});
      assert.equal(stopped.statusCode,302);assert.equal(stopped.isRedirect,true);assert.equal(stopped.headers.location,'/end');
      await assert.rejects(transport({url:'https://fixture.example.org/loop',options:{maxRedirects:1}}),/source_redirect_limit/);
    }
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test('redirects validate destination, strip credentials and preserve upstream cross-origin POST restriction',async()=>{
  const calls:any[]=[];
  const hop=async(spec:any)=>{calls.push(spec);return calls.length===1?{statusCode:302,headers:{location:'https://other.example.org/end'},bytes:'',size:0}:{statusCode:200,headers:{},bytes:'',size:0};};
  await followSourceRedirects(requestSpec({url:'https://fixture.example.org/',headers:{Authorization:'secret',Cookie:'secret'}}),hop);
  assert.equal(calls[1].headers.authorization,undefined);assert.equal(calls[1].special.cookie,undefined);
  calls.length=0;
  await assert.rejects(followSourceRedirects(requestSpec({url:'https://fixture.example.org/',method:'POST',body:'x'}),hop),/source_redirect_denied/);
  await assert.rejects(followSourceRedirects(requestSpec({url:'https://fixture.example.org/'}),async()=>({statusCode:302,headers:{location:'https://127.0.0.1/'}})),/source_url_denied/);
});
test('upstream inline ASS/VTT/SRT and opaque HLS classification are shared by Lite',()=>{
  assert.equal(remoteMediaType('edl://https://example.org/video.mp4'),'application/vnd.apple.mpegurl');
  assert.equal(remoteMediaType('https://example.org/play?token=x'),'application/vnd.apple.mpegurl');
  assert.equal(remoteMediaType('https://example.org/video.mp4?token=x'),'video/mp4');
  for(const file of ['WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello','1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nNext']) {
    assert.match(inlineSubtitle(file).content,/WEBVTT/);assert.match(inlineSubtitle(file).content,/Hello/);
    assert.equal(inlineSubtitle('data:text/plain;base64,'+Buffer.from(file).toString('base64')).content,inlineSubtitle(file).content);
  }
  assert.equal(inlineSubtitle('[Script Info]\nScriptType: v4.00+\n[Events]\n').format,'ass');
  assert.throws(()=>inlineSubtitle('<html>denied</html>'));
});
