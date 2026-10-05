import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir,cp,mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type BrowserContext } from 'playwright-core';
const root=resolve(import.meta.dirname,'../../..'), dir=resolve(root,'.state/connector-browser');
await mkdir(dir,{recursive:true});
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key.pem','-out',dir+'/cert.pem','-days','1','-subj','/CN=fixture.example.org'],{stdio:'ignore'});
const reader=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Connector verification</title>');});
const seen:any[]=[];
const source=httpsServer({key:await readFile(dir+'/key.pem'),cert:await readFile(dir+'/cert.pem')},async(req,res)=>{
  let body='';for await(const part of req)body+=part;seen.push({path:req.url,method:req.method,headers:req.headers,body});
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/end','X-Token':'redirect-token'});res.end();return;}
  if(req.url==='/denied'){res.writeHead(302,{Location:'https://denied.example.org/'});res.end();return;}
  res.writeHead(200,{'Content-Type':'text/plain','X-Token':'upstream-token','Set-Cookie':'fixture=1; Secure; SameSite=None'});res.end(body||'ok');
});
let browser: BrowserContext | undefined;
try {
await new Promise<void>(r=>reader.listen(0,'127.0.0.1',r));await new Promise<void>(r=>source.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+(reader.address() as any).port, sourcePort=(source.address() as any).port;
const extension=dir+'/extension';await mkdir(extension,{recursive:true});
const manifest=JSON.parse(await readFile(resolve(root,'.state/extension/chromium/manifest.json'),'utf8'));
manifest.host_permissions=[origin+'/*','https://fixture.example.org/*'];
await writeFile(extension+'/manifest.json',JSON.stringify(manifest));
for(const name of ['background','content','popup'])await build({entryPoints:[resolve(root,'apps/lite/connector/'+name+'.js')],outfile:extension+'/'+name+'.js',bundle:true,platform:'browser',format:'iife'});
await cp(resolve(root,'apps/lite/connector/popup.html'),extension+'/popup.html');
await cp(resolve(root,'apps/lite/connector/popup.html'),extension+'/setup.html');
browser=await chromium.launchPersistentContext(await mkdtemp(dir+'/profile-'),{executablePath:process.env.CHROMIUM_PATH??chromium.executablePath(),headless:true,timeout:30000,ignoreDefaultArgs:['--disable-extensions'],args:['--no-sandbox','--no-proxy-server','--ignore-certificate-errors',`--host-resolver-rules=MAP fixture.example.org:443 127.0.0.1:${sourcePort}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  browser.setDefaultTimeout(10000);
  const page=await browser.newPage();
  await page.addInitScript('globalThis.__name = (value) => value'); // tsx keepNames helper for serialized callbacks
  await page.goto(origin);
  const call=async(type:string,args:any={})=>page.evaluate(({type,args})=>new Promise<any>((resolve,reject)=>{
    const id=crypto.randomUUID(),timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(new Error('connector-test-timeout'));},5000);
    const listener=(event:MessageEvent)=>{if(event.data?.channel!=='moa-lite-connector-response-v1'||event.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',listener);resolve(event.data);};
    window.addEventListener('message',listener);window.postMessage({channel:'moa-lite-connector-request-v1',id,type,...args},location.origin);
  }),{type,args});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(async origin => { await (globalThis as any).chrome.storage.local.set({ appOrigin: origin }); }, origin);
  await page.waitForTimeout(500);
  const hello = (await call('hello')).value; assert.equal(hello.origin, origin); assert.equal(hello.version, '0.1.0');
  assert.equal(hello.hostPermission, false);
  const {value:{token}}=await call('begin',{action:'videos'});
  const request=async(path:string,extra:any={})=>call('http',{token,request:{url:'https://fixture.example.org'+path,...extra}});
  const redirected=await request('/redirect');assert.equal(redirected.error,undefined,JSON.stringify(redirected));assert.equal(redirected.value.statusCode,200);assert.equal(redirected.value.headers['x-token'],'upstream-token');assert.match(redirected.value.headers['set-cookie'],/fixture=1/);
  const stopped=await request('/redirect',{options:{followRedirects:false}});assert.equal(stopped.value.statusCode,302);assert.equal(stopped.value.headers.location,'/end');assert.equal(stopped.value.isRedirect,true);
  for(const method of ['PUT','PATCH','DELETE']){const response=await request('/end',{method,body:'한글',headers:{'X-Custom':'custom','User-Agent':'fixture-agent',Referer:'https://fixture.example.org/'}});assert.equal(response.value?.statusCode,200,JSON.stringify(response));assert.equal(seen.at(-1).headers['user-agent'],'fixture-agent');assert.equal(seen.at(-1).body,'한글');}
  const denied=await request('/denied');assert.equal(denied.error,'host_permission_missing');
  assert(seen.every(row => !row.headers.cookie));
  const authTab = await browser.newPage(); await authTab.goto('https://fixture.example.org/end');
  await worker.evaluate(async()=>{const api=(globalThis as any).chrome;const tabs=await api.tabs.query({url:'https://fixture.example.org/*'});await api.storage.local.set({loginOrigins:['https://fixture.example.org'],authTabs:{'https://fixture.example.org':tabs[0].id}});});
  const authenticated = await request('/redirect');assert.equal(authenticated.error,undefined,JSON.stringify(authenticated));assert.equal(authenticated.value.statusCode,200);assert.equal(authenticated.value.headers['x-token'],'upstream-token');
  assert.match(seen.at(-1).headers.cookie, /fixture=1/);
  await worker.evaluate(async () => { await (globalThis as any).chrome.storage.local.set({ loginOrigins: [] }); });
  const anonymous = await request('/end'); assert.equal(anonymous.error, undefined); assert.equal(seen.at(-1).headers.cookie, undefined);
  await call('end',{token});
  await worker.evaluate(async () => { await (globalThis as any).chrome.storage.local.set({ appOrigin: 'https://next.example.org' }); });
  await page.waitForTimeout(200);
  const revoked = await call('hello').catch(() => ({})); assert.equal(revoked.value, undefined);
  await worker.evaluate(async origin => { await (globalThis as any).chrome.storage.local.set({ appOrigin: origin }); }, origin);
  await page.waitForTimeout(200); assert.equal((await call('hello')).value.origin, origin);
  console.log('PASS installed Chromium connector: real HTTPS redirects, manual Location, response headers, PUT/PATCH/DELETE, custom/UA headers redirect host permissions and authenticated source tabs');
} finally {
  try { await browser?.close(); }
  finally {
    reader.closeAllConnections(); source.closeAllConnections();
    await Promise.all([new Promise<void>(r=>reader.close(()=>r())),new Promise<void>(r=>source.close(()=>r()))]);
  }
}
