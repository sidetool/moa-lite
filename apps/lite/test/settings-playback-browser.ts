import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const root=resolve(import.meta.dirname,'../../..');
const bundle=await build({stdin:{resolveDir:resolve(root,'apps/web'),loader:'tsx',contents:`
 import {useEffect,useState} from 'react';
 import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {useSettings,useSaveSettings} from './src/api/queries';
 import {createRoot} from 'react-dom/client';
 import {SubtitleStyleControls} from './src/components/SubtitleStyleControls';
 import {devicePrefs,useDevicePrefs,loadDevicePrefs,saveDevicePrefs} from './src/lib/device-prefs';
 import {subtitleOffsetForEpisode,rememberSubtitleOffset} from './src/player/subtitle-preference';
 import {materializeInline,releaseAllInline} from '../lite/client/inline-playback';
 import Hls from 'hls.js';
 localStorage.setItem('moa-lite.account','a');localStorage.setItem('moa.profile','p');
 localStorage.setItem('moa.subtitleAppearance',JSON.stringify({size:'large',background:'soft'}));
 await loadDevicePrefs({subtitleSize:'medium'},new AbortController().signal);
 const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity}}});client.setQueryData(['settings'],{subtitleSize:'medium'});
 function Screen(){const settings=useSettings().data;const save=useSaveSettings();window.initialSave??=save;const [updates,setUpdates]=useState(0);useEffect(()=>setUpdates(n=>n+1),[settings]);return <><output id='updates'>{updates}</output><SubtitleStyleControls settings={settings} save={save}/></>;}
 createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><Screen/></QueryClientProvider>);
 window.harness={prefs:devicePrefs,save:saveDevicePrefs,offset:subtitleOffsetForEpisode,remember:rememberSubtitleOffset,
 profile:async(account,id)=>{localStorage.setItem('moa-lite.account',account);localStorage.setItem('moa.profile',id);await loadDevicePrefs({subtitleSize:'medium'},new AbortController().signal);window.dispatchEvent(new Event('moa:device-prefs'));},
 play:async url=>{const session={sessionId:'fixture',url,mime:'video/mp4'};materializeInline(session);const hls=new Hls();window.hls=hls;window.session=session;
 hls.on(Hls.Events.ERROR,(_e,d)=>{if(d.fatal)window.playbackError=d.details});hls.loadSource(session.url);hls.attachMedia(document.querySelector('video'));},
 release:()=>{window.hls.destroy();releaseAllInline();}};
 `},bundle:true,write:false,format:'esm',target:'es2022',jsx:'automatic',define:{'import.meta.env.VITE_MOA_LITE':'"0"','import.meta.env.VITE_MOCK':'"0"'}});
const css=(await Promise.all(['base','components','player'].map(name=>readFile(resolve(root,`apps/web/src/styles/${name}.css`),'utf8')))).join('\n');
const requests:string[]=[];
const server=createServer((req,res)=>{requests.push(req.url!);res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:req.url==='/style.css'?css:'<link rel="stylesheet" href="/style.css"><div id="app" style="max-width:550px"></div><video muted></video><script type="module" src="/app.js"></script>');});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??chromium.executablePath(),headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}}); const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);await page.waitForFunction(()=>!!(window as any).harness);
 assert.equal(await page.evaluate(()=>(window as any).harness.prefs().subtitleSize),'large');
 assert.equal(await page.locator('#updates').textContent(),'1','settings object stays stable across unrelated rerenders');
 await page.getByRole('spinbutton',{name:'자막 크기',exact:true}).fill('175');await page.getByRole('spinbutton',{name:'자막 크기',exact:true}).press('Enter');
 assert.equal(await page.evaluate(()=>(window as any).harness.prefs().subtitleScale),175);
 await page.getByRole('radio',{name:'진하게',exact:true}).click();await page.getByText('상세 조절',{exact:true}).click();
 await page.getByRole('spinbutton',{name:'자막 윤곽선',exact:true}).fill('2.5');await page.getByRole('spinbutton',{name:'자막 윤곽선',exact:true}).press('Enter');
 assert.equal(await page.locator('.subtitle-preview-cue span').evaluate(el=>getComputedStyle(el).webkitTextStrokeWidth),'2.5px');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(async()=>{(window as any).harness.remember('e1',1.5);await (window as any).harness.profile('a','other');});
 assert.equal(await page.evaluate(()=>(window as any).harness.prefs().subtitleScale),null);
 assert.equal(await page.evaluate(()=>(window as any).harness.offset('e1')),0);
 await page.evaluate(()=>(window as any).harness.profile('a','p'));
 assert.equal(await page.evaluate(()=>(window as any).harness.prefs().subtitleScale),175);
 assert.equal(await page.evaluate(()=>(window as any).harness.offset('e1')),1.5);
 assert.equal(await page.evaluate(()=>(window as any).harness.offset('e2')),0);
 await page.evaluate(()=>(window as any).harness.profile('b','p'));
 await page.evaluate(()=>(window as any).initialSave({subtitleScale:200}));
 assert.equal(await page.evaluate(()=>(window as any).harness.prefs().subtitleScale),null);
 assert.equal(await page.evaluate(()=>(window as any).harness.offset('e1')),0);
 console.log('PASS original subtitle sliders/preview on mobile, legacy migration, profile/account isolation and episode-only timing');
 const key=Buffer.alloc(16,7),iv=Buffer.alloc(16,0);
 const seen:string[]=[];
 await page.route('https://media.example.org/**',async route=>{const path=new URL(route.request().url()).pathname;seen.push(path);const bytes=await readFile(resolve(root,'apps/lite/test/assets',path.slice(1)));const cipher=createCipheriv('aes-128-cbc',key,iv);await route.fulfill({body:Buffer.concat([cipher.update(bytes),cipher.final()]),contentType:'video/mp2t',headers:{'Access-Control-Allow-Origin':'*'}});});
 const body=(await readFile(resolve(root,'apps/lite/test/assets/high.m3u8'),'utf8')).replace('#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,'+key.toString('base64')+'",IV=0x'+iv.toString('hex')).replace(/^(high-\d+\.ts)$/gm,'https://media.example.org/$1');
 await page.evaluate(url=>(window as any).harness.play(url),'data:application/vnd.apple.mpegurl;base64,'+Buffer.from(body).toString('base64'));
 await page.waitForFunction(()=>document.querySelector('video')!.readyState>=2 || !!(window as any).playbackError);
 assert.equal(await page.evaluate(()=>(window as any).playbackError),undefined);
 await page.evaluate(()=>document.querySelector('video')!.play());await page.waitForFunction(()=>document.querySelector('video')!.currentTime>1);
 await page.evaluate(()=>{document.querySelector('video')!.currentTime=5;});await page.waitForFunction(()=>document.querySelector('video')!.currentTime>5);
 assert(seen.length>=2);assert(!requests.some(url=>url.startsWith('/api/')));
 await page.evaluate(()=>(window as any).harness.release());assert.deepEqual(errors,[]);
 console.log('PASS encrypted inline HLS plays/seeks with Blob keys and direct segments, without any server API request');
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
