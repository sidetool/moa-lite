import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright-core';
const root=resolve(import.meta.dirname,'../../..');
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Subtitle import verification</title>');return;}
  const path=resolve(root,'apps/web/dist','.'+new URL(req.url!,'http://localhost').pathname);
  if(!path.startsWith(resolve(root,'apps/web/dist')+'/')){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',extname(path)==='.wasm'?'application/wasm':'text/javascript');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'");res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??chromium.executablePath(),headless:true,args:['--no-sandbox']});
try{
  const page=await browser.newPage();const urls:string[]=[];page.on('request',r=>urls.push(r.url()));
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
  for(const filename of ['sample.smi','cp949.zip','lite-korean.7z','lite-encrypted.7z','unsafe.zip']){
    const bytes=Array.from(await readFile(resolve(root,'packages/subtitles-ko/test/fixtures',filename)));
    const result=await page.evaluate(({filename,bytes})=>new Promise<any>((yes,no)=>{
      const worker=new Worker('/runtime/subtitle-import-worker.js');
      const timer=setTimeout(()=>{worker.terminate();no(new Error('timeout'));},15000);
      worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();yes(data);};
      worker.onerror=e=>{clearTimeout(timer);worker.terminate();no(new Error(e.message));};
      worker.postMessage({filename,bytes:new Uint8Array(bytes)});
    }),{filename,bytes});
    if(filename==='lite-encrypted.7z')assert(result.error);
    else{
      assert(!result.error,result.error);assert(result.files.length>0);
      assert(result.files.every((file:any)=>!file.filename.includes('..')));
      if(filename==='lite-korean.7z')assert.deepEqual(result.files.map((f:any)=>f.filename).sort(),['구름 정원 1화.srt','구름 정원 2화.srt']);
      if(filename==='cp949.zip')assert.equal(result.files[0].filename,'예제 03.ass');
    }
    console.log('PASS browser import under production CSP: '+filename);
  }
  assert(urls.every(url=>!new URL(url).pathname.startsWith('/api/')));
}finally{await browser.close();await new Promise<void>(yes=>server.close(()=>yes()));}
