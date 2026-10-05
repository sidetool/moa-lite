import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { subtitleDocument, batches } from '../src/translation/subtitle.js';
import { Gemini } from '../src/translation/gemini.js';
import { Translations } from '../src/translation/service.js';
import { Catalog } from '../src/catalog.js';
import { Store } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ApiFailure } from '../src/util.js';
const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\nworld\n\n00:00:04.000 --> 00:00:06.000\nGoodbye\n';
const secret = 'test-key-not-a-real-key';
const authKey = 'AQ.Ab' + 'x'.repeat(48); // Synthetic 53-character authorization key.
const standardKey = 'AIza' + 'y'.repeat(35);
const success = (lines: any[]) =>
  Response.json({
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [{ text: JSON.stringify({ lines: lines.map((l) => ({ id: l.id, text: `번역 ${l.id}` })) }) }],
        },
      },
    ],
  });
const fake: typeof fetch = async (_url, init) =>
  success(JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text).lines);
async function wait(service: Translations, id: string, profile = 'p') {
  for (let n = 0; n < 200; n++) {
    const job = service.get(id, profile);
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job timeout');
}
async function fixture(transport: typeof fetch = fake) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moa-translation-')),
    db = new Store(dir);
  db.run(
    'INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,?,?,?)',
    'p',
    'P',
    'red',
    0,
    '2026',
    'local',
  );
  db.run(
    'INSERT INTO profiles(id,name,color,kids,created_at,account_id) VALUES(?,?,?,?,?,?)',
    'q',
    'Q',
    'blue',
    0,
    '2026',
    'other',
  );
  db.run('INSERT INTO media VALUES(?,?,?,?,?,?)', 'm', null, 'A movie', 'movie', '{}', '2026');
  db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'e', 'm', 1, 1, 'Movie', 100, null);
  const create = () => new Translations(db, new Catalog(db), dir, new Gemini(transport));
  const service = create();
  service.configure({ apiKey: secret, enabled: true, requestIntervalMs: 0, retryCount: 0 });
  return {
    dir,
    db,
    service,
    create,
    async close() {
      await service.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const input = { content: vtt, format: 'vtt', sourceLabel: 'English', sourceLanguage: 'en' };

test('VTT/SRT translation preserves cue timing and multiline text, escapes model markup', () => {
  const doc = subtitleDocument(vtt, 'vtt');
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].text, 'Hello\nworld');
  const output = doc.render({ '0': '안녕\n세상 <test>', '1': '잘 가' });
  assert.match(output, /00:00:01.000 --> 00:00:03.000/);
  assert.match(output, /안녕\n세상 &lt;test&gt;/);
  const srt = subtitleDocument('1\n00:00:01,000 --> 00:00:02,000\nHello\n', 'srt');
  assert.equal(srt.format, 'vtt');
  assert.match(srt.render({ '0': '안녕' }), /00:00:01.000 --> 00:00:02.000/);
  assert.throws(() => doc.render({ '0': 'partial' }), /translation-incomplete/);
  assert.throws(() => subtitleDocument('not a subtitle', 'vtt'), /translation-invalid-subtitle/);
});
test('ASS keeps time, styles and vector drawings, removes injected override commands', () => {
  const ass =
    '[Script Info]\nTitle: Test\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Hello\\Nworld\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10';
  const doc = subtitleDocument(ass, 'ass');
  assert.equal(doc.lines.length, 1);
  const output = doc.render({ '0': '안녕\n세상{\\p1}' });
  assert.match(output, /0:00:01.00,0:00:03.00,Default,,0,0,0,,\{\\an8\}안녕\\N세상p1/);
  assert.ok(output.includes('{\\p1}m 0 0 l 10 10'));
  assert.ok(output.includes('Style: Default,Arial'));
});
test('batch limits and input bounds', () => {
  assert.deepEqual(
    batches(Array.from({ length: 241 }, (_, id) => ({ id, text: 'hi' }))).map((x) => x.length),
    [120, 120, 1],
  );
  assert.throws(() => subtitleDocument('x'.repeat(1024 * 1024 + 1), 'vtt'), /translation-subtitle-too-large/);
});
test('Gemini uses fixed URL, header secret and strict complete cue IDs', async () => {
  let seen = false;
  const client = new Gemini(async (url, init) => {
    assert.equal(
      String(url),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    );
    assert.equal((init!.headers as any)['x-goog-api-key'], secret);
    assert.ok(!String(init!.body).includes(secret));
    seen = true;
    return success([{ id: 4 }, { id: 9 }]);
  });
  assert.deepEqual(
    await client.translate(
      secret,
      'gemini-flash-latest',
      [
        { id: 4, text: 'Hello' },
        { id: 9, text: 'Bye' },
      ],
      { title: 'Movie', sourceLanguage: 'en' },
      new AbortController().signal,
    ),
    { '4': '번역 4', '9': '번역 9' },
  );
  assert.ok(seen);
  for (const lines of [[{ id: 4 }], [{ id: 4 }, { id: 4 }], [{ id: 4 }, { id: 10 }]]) {
    await assert.rejects(
      new Gemini(async () => success(lines)).translate(
        secret,
        'gemini-flash-latest',
        [
          { id: 4, text: 'A' },
          { id: 9, text: 'B' },
        ],
        { title: '', sourceLanguage: '' },
        new AbortController().signal,
      ),
      /translation-incomplete/,
    );
  }
  await assert.rejects(
    new Gemini(async () => new Response(secret, { status: 429 })).models(secret, new AbortController().signal),
    (error) => error instanceof ApiFailure && error.error === 'translation-quota' && !error.message.includes(secret),
  );
});
test('Gemini auth and legacy keys survive configuration, restart and header-only requests', async () => {
  const used: string[] = [];
  const f = await fixture(async (url, init) => {
    const key = new Headers(init?.headers).get('x-goog-api-key')!;
    used.push(key);
    assert.ok(!String(url).includes(key));
    assert.ok(!String(init?.body).includes(key));
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    if (!init?.body) return Response.json({ models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }] });
    return fake(url, init);
  });
  try {
    const config = f.service.configure({ clearKey: true, addKeys: ['  ' + authKey + '\t', standardKey, authKey] });
    assert.equal(config.keys.length, 2);
    for (const key of [authKey, standardKey]) assert.ok(!JSON.stringify(config).includes(key));
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'translation-secret.json'), 'utf8')).apiKeys, [authKey, standardKey]);
    assert.equal((await stat(path.join(f.dir, 'translation-secret.json'))).mode & 0o777, 0o600);
    for (const key of ['short', 'x'.repeat(257), 'AQ.Ab' + 'x '.repeat(24), authKey + '\r\nX-Test: invalid', authKey + '한글']) {
      assert.throws(() => f.service.configure({ addKeys: [key] }), /translation-key-invalid/);
    }
    await f.service.close();
    const restored = f.create();
    try {
      assert.equal(restored.config().keys.length, 2);
      assert.equal(restored.config().enabled, true);
      assert.deepEqual(await restored.models(), { models: ['gemini-flash-latest'] });
      assert.equal((await wait(restored, restored.start('e', 'p', input).id)).state, 'completed');
      restored.configure({ apiKey: standardKey });
      await restored.models();
    } finally { await restored.close(); }
    // The original single-key disk format must also accept AQ. keys after restart.
    const saved = JSON.parse(await readFile(path.join(f.dir, 'translation-secret.json'), 'utf8'));
    delete saved.apiKeys;
    await writeFile(path.join(f.dir, 'translation-secret.json'), JSON.stringify({ ...saved, apiKey: authKey }));
    const single = f.create();
    try { assert.equal(single.config().configured, true); await single.models(); }
    finally { await single.close(); }
    assert.deepEqual(used, [authKey, authKey, standardKey, authKey]);
  } finally { await f.close(); }
});

test('shared work, cancellation isolation, durable cache and secret redaction', async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async (url, init) => {
    calls++;
    await gate;
    return fake(url, init);
  });
  try {
    const a = f.service.start('e', 'p', input),
      b = f.service.start('e', 'q', input);
    assert.notEqual(a.id, b.id);
    assert.equal(calls, 1);
    assert.throws(() => f.service.get(a.id, 'q'), /translation-job-not-found/);
    f.service.cancel(a.id, 'p');
    release();
    const complete = await wait(f.service, b.id, 'q');
    assert.equal(complete.state, 'completed');
    assert.equal(f.service.get(a.id, 'p').state, 'cancelled');
    assert.equal(calls, 1);
    const hit = f.service.start('e', 'p', input);
    assert.equal(hit.cached, true);
    assert.equal(calls, 1);
    assert.equal(f.service.config().configured, true);
    assert.ok(!JSON.stringify(f.service.config()).includes(secret));
    assert.equal((await stat(path.join(f.dir, 'translation-secret.json'))).mode & 0o777, 0o600);
    await f.service.close();
    const restarted = f.create();
    try {
      assert.equal(restarted.start('e', 'p', input).cached, true);
      assert.equal(restarted.tracks('e', 'p')[0].source, 'translation');
      assert.equal(calls, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    release();
    await f.close();
  }
});
test('partial batch checkpoint survives failure and process restart', async () => {
  let calls = 0;
  const f = await fixture(async (url, init) => {
    calls++;
    if (calls === 2) throw new Error('provider unavailable');
    return fake(url, init);
  });
  try {
    const content =
      'WEBVTT\n\n' + Array.from({ length: 121 }, (_, i) => `00:00:01.000 --> 00:00:02.000\nLine ${i}`).join('\n\n');
    const first = await wait(f.service, f.service.start('e', 'p', { ...input, content }).id);
    assert.equal(first.state, 'failed');
    assert.equal(first.done, 25);
    assert.ok(first.track);
    assert.equal(first.partial, true);
    await f.service.close();
    const restarted = f.create();
    try {
      const next = await wait(restarted, restarted.start('e', 'p', { ...input, content }).id);
      assert.equal(next.state, 'completed');
      assert.equal(calls, 4);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});
test('disabling translation cancels queued/running work; disabled mode never calls Gemini', async () => {
  const f = await fixture(
    async (_url, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
  );
  try {
    const a = f.service.start('e', 'p', input);
    f.service.configure({ enabled: false });
    assert.equal(f.service.get(a.id, 'p').state, 'cancelled');
    assert.throws(() => f.service.start('e', 'p', input), /translation-disabled/);
  } finally {
    await f.close();
  }
});
test('routes enforce admin key writes, profile jobs, account assets and persist playback tracks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moa-translation-api-'));
  const env = await buildApp({ dataDir: dir, mediaRoot: dir, webDir: path.join(dir, 'web') }, false, {
    translationFetch: fake,
    aniSkip: {
      async lookup() {
        return { match: null, intervals: [], markers: null };
      },
    },
  });
  try {
    const p = (await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'P' } })).json();
    const headers = { 'x-moa-profile': p.id };
    assert.equal((await env.app.inject({url:'/api/settings',headers})).json().translationMode,'manual');
    const defaults = (await env.app.inject({url:'/api/settings',headers})).json();
    assert.equal(defaults.translationSourcePriority, 'site');
    assert.equal(defaults.skipSubtitleSearchWithSiteTrack, true);
    assert.equal(defaults.skipTranslationWithoutSubtitles, true);
    // Existing profiles store partial JSON; a missing new field inherits the protected default.
    env.db.run('UPDATE settings SET value=? WHERE id=?', JSON.stringify({translationMode:'auto'}), p.id);
    assert.equal((await env.app.inject({url:'/api/settings',headers})).json().skipTranslationWithoutSubtitles,true);
    for (const value of [false,true]) {
      const saved=await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{skipTranslationWithoutSubtitles:value}});
      assert.equal(saved.statusCode,200);
      assert.equal((await env.app.inject({url:'/api/settings',headers})).json().skipTranslationWithoutSubtitles,value);
    }
    assert.equal((await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{skipTranslationWithoutSubtitles:[]}})).statusCode,400);
    const advanced = await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{translationSourcePriority:'jimaku',skipSubtitleSearchWithSiteTrack:false}});
    assert.equal(advanced.statusCode,200);
    assert.equal(advanced.json().translationSourcePriority,'jimaku');
    assert.equal(advanced.json().skipSubtitleSearchWithSiteTrack,false);
    assert.equal((await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{translationSourcePriority:'unknown'}})).statusCode,400);

    for (const translationMode of ['ask','auto','manual']) {
      const settings=await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{translationMode}});
      assert.equal(settings.statusCode,200); assert.equal(settings.json().translationMode,translationMode);
    }
    assert.equal((await env.app.inject({method:'PATCH',url:'/api/settings',headers,payload:{translationMode:'invalid'}})).statusCode,400);

    env.db.run('INSERT INTO media VALUES(?,?,?,?,?,?)', 'm', null, 'Movie', 'movie', '{}', '2026');
    env.db.run('INSERT INTO episodes VALUES(?,?,?,?,?,?,?)', 'e', 'm', 1, 1, 'Movie', 100, null);
    const file = path.join(dir, 'test.mp4');
    await writeFile(file, 'test');
    env.db.run(
      'INSERT INTO files VALUES(?,?,?,?,?,?,?)',
      'e',
      file,
      4,
      0,
      '',
      JSON.stringify({
        duration: 100,
        container: 'mp4',
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
      }),
      '[]',
    );
    assert.equal(
      (
        await env.app.inject({
          method: 'PATCH',
          url: '/api/admin/translation/config',
          headers: { 'x-moa-account': 'member', 'x-moa-role': 'member' },
          payload: { apiKey: secret },
        })
      ).statusCode,
      403,
    );
    const config = await env.app.inject({
      method: 'PATCH',
      url: '/api/admin/translation/config',
      payload: { apiKey: authKey, enabled: true },
    });
    assert.equal(config.statusCode, 200);
    assert.ok(!config.body.includes(authKey));
    const limits = await env.app.inject({method:'PATCH',url:'/api/admin/translation/config',payload:{requestIntervalMs:0,retryCount:3}});
    assert.equal(limits.statusCode,200);assert.equal(limits.json().retryCount,3);
    for (const payload of [{requestIntervalMs:-1},{requestIntervalMs:60001},{retryCount:6},{retryCount:1.5}]) {
      assert.equal((await env.app.inject({method:'PATCH',url:'/api/admin/translation/config',payload})).statusCode,400);
    }

    assert.equal(
      (await env.app.inject({ method: 'POST', url: '/api/episodes/e/subtitles/translate', payload: input })).statusCode,
      401,
    );
    const child = (
      await env.app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Child', kids: true } })
    ).json();
    assert.equal(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/episodes/e/subtitles/translate',
          headers: { 'x-moa-profile': child.id },
          payload: input,
        })
      ).statusCode,
      403,
    );
    const response = await env.app.inject({
      method: 'POST',
      url: '/api/episodes/e/subtitles/translate',
      headers,
      payload: input,
    });
    assert.equal(response.statusCode, 200, response.body);
    const job = await wait(env.translations, response.json().id, p.id);
    assert.equal(job.state, 'completed');
    assert.equal((await env.app.inject({method:'POST',url:`/api/translations/${job.id}/priority`,headers,payload:{startAt:5}})).statusCode,204);
    assert.equal((await env.app.inject({method:'POST',url:`/api/translations/${job.id}/priority`,headers,payload:{startAt:-1}})).statusCode,400);

    assert.equal((await env.app.inject(job.track!.url)).statusCode, 200);
    assert.equal(
      (await env.app.inject({ url: job.track!.url, headers: { 'x-moa-account': 'other', 'x-moa-role': 'member' } }))
        .statusCode,
      403,
    );
    const session = (
      await env.app.inject({
        method: 'POST',
        url: '/api/playback',
        headers,
        payload: { episodeId: 'e', capabilities: { h264: true, hevc: false, av1: false } },
      })
    ).json();
    assert.equal(session.subtitles[0].source, 'translation');
    assert.equal((await env.app.inject(session.subtitles[0].url)).statusCode, 200);
    env.db.run('DELETE FROM episodes WHERE id=?', 'e');
    assert.equal((await env.app.inject(job.track!.url)).statusCode, 404);
  } finally {
    await env.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('configurable batch size and key-chain failover reuse the successful key', async () => {
  const used: string[] = [],
    sizes: number[] = [];
  const f = await fixture(async (url, init) => {
    const key = (init!.headers as any)['x-goog-api-key'];
    used.push(key);
    if (key === secret) return new Response('', { status: 429 });
    sizes.push(JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text).lines.length);
    return fake(url, init);
  });
  try {
    f.service.configure({ addKeys: ['second-key-works-fine'], batchSize: 10, retryCount: 2 });
    const content =
      'WEBVTT\n\n' + Array.from({ length: 21 }, (_, i) => `00:00:01.000 --> 00:00:02.000\nLine ${i}`).join('\n\n');
    assert.equal((await wait(f.service, f.service.start('e', 'p', { ...input, content }).id)).state, 'completed');
    assert.deepEqual(sizes, [10, 10, 1]);
    assert.deepEqual(used, [secret, 'second-key-works-fine', 'second-key-works-fine', 'second-key-works-fine']);
    assert.equal(f.service.config().keys.length, 2);
    assert.ok(!JSON.stringify(f.service.config()).includes('second-key-works-fine'));
    f.service.configure({ removeKeyIds: [f.service.config().keys[0].id] });
    assert.equal(f.service.config().keys.length, 1);
    assert.throws(() => f.service.configure({ batchSize: 0 }), /translation-batch-invalid/);
    assert.throws(
      () => f.service.configure({ addKeys: Array.from({ length: 9 }, (_, i) => `valid-long-key-number-${i}`) }),
      /translation-too-many-keys/,
    );
  } finally {
    await f.close();
  }
});


test('Gemini classifies Google invalid-key 400 without exposing provider error details', async () => {
  const client = new Gemini(async () => Response.json({error:{message:secret,details:[{reason:'API_KEY_INVALID'}]}},{status:400}));
  await assert.rejects(client.models(secret,new AbortController().signal), (error: any) => error.error === 'translation-key-invalid' && !error.message.includes(secret));
  await assert.rejects(new Gemini(async()=>Response.json({models:'bad'})).models(secret,new AbortController().signal), /translation-invalid-response/);
});

const timedContent = (count: number) => 'WEBVTT\n\n' + Array.from({length: count}, (_,i) => {
  const clock = (n:number) => `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}.000`;
  return `${clock(i*4)} --> ${clock(i*4+3)}\nLine ${i}`;
}).join('\n\n');
async function until(check: () => boolean) {
  for (let i=0;i<200;i++) { if (check()) return; await new Promise(r=>setTimeout(r,5)); }
  throw new Error('condition timeout');
}
test('live batches start near playback, expose only translated cues, prioritize seek and then fill earlier gaps', async () => {
  const received: number[][] = [], releases: (()=>void)[] = [];
  const f = await fixture(async (url,init) => {
    const lines = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text).lines;
    assert.deepEqual(Object.keys(lines[0]).sort(), ['id','text']);
    received.push(lines.map((l:any)=>l.id));
    await new Promise<void>(resolve=>releases.push(resolve));
    return fake(url,init);
  });
  try {
    const started=f.service.start('e','p',{...input,content:timedContent(100),startAt:200});
    assert.deepEqual(received[0], Array.from({length:25},(_,i)=>50+i));
    f.service.priority(started.id,'p',0);
    assert.throws(()=>f.service.priority(started.id,'q',0), /translation-job-not-found/);
    releases.shift()!();
    await until(()=>received.length===2);
    const partial=f.service.get(started.id,'p');
    assert.equal(partial.state,'running');
    assert.equal(partial.done,25);
    assert.equal(partial.partial,true);
    assert.equal(partial.revision,1);
    assert.match(partial.track!.url,/revision=1/);
    assert.equal(partial.translatedRanges[0].start,200);
    const token=partial.track!.url.split('/')[3];
    const content=f.service.asset(token,'translation.vtt','p')!.content!;
    assert.equal((content.match(/-->/g)||[]).length,25);
    assert.match(content,/번역 50/);
    assert.ok(!content.includes('Line '));
    assert.deepEqual(received[1],Array.from({length:25},(_,i)=>i));
    assert.equal(f.service.tracks('e','p').length,0);
    // A cancelled subscriber keeps its rendered partial result without cancelling another viewer.
    const other=f.service.start('e','q',{...input,content:timedContent(100),startAt:300});
    f.service.cancel(started.id,'p');
    while (['queued','running'].includes(f.service.get(other.id,'q').state)) {
      releases.shift()?.(); await new Promise(r=>setTimeout(r,5));
    }
    const complete=f.service.get(other.id,'q');
    assert.equal(complete.state,'completed'); assert.equal(complete.partial,false); assert.equal(complete.done,100);
    assert.equal(new Set(received.flat()).size,100);
    assert.equal(received.flat().length,100);
    assert.equal(f.service.get(started.id,'p').state,'cancelled');
    assert.equal(f.service.tracks('e','q').length,1);
  } finally { releases.forEach(r=>r()); await f.close(); }
});

test('partial rendering preserves ASS timing and coverage excludes overlapping missing dialogue', async()=>{
  const {translatedRanges}=await import('../src/translation/subtitle.js');
  const doc=subtitleDocument('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB','vtt');
  assert.deepEqual(translatedRanges(doc.lines,{'0':'가'}),[{start:1,end:3},{start:4,end:5}]);
  const ass=subtitleDocument('[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:01:02.50,0:01:05.00,Default,Hello\nDialogue: 0,0:01:06.00,0:01:08.00,Default,Bye','ass');
  assert.equal(ass.lines[0].start,62.5);
  const partial=ass.render({'0':'안녕'},true);
  assert.match(partial,/0:01:02.50,0:01:05.00,Default,안녕/);
  assert.ok(!partial.includes('Bye'));
  assert.equal((partial.match(/Dialogue:/g)||[]).length,1);
});

test('legacy full cache migrates without translating again', async()=>{
  let calls=0;
  const f=await fixture(async(url,init)=>{calls++;return fake(url,init)});
  try {
    await wait(f.service,f.service.start('e','p',input).id);
    await f.service.close();
    f.db.db.exec('ALTER TABLE translation_cache DROP COLUMN complete; ALTER TABLE translation_cache DROP COLUMN revision; ALTER TABLE translation_cache DROP COLUMN ranges;');
    const restarted=f.create();
    try {
      const job=restarted.start('e','p',input);
      assert.equal(job.cached,true); assert.equal(job.state,'completed'); assert.equal(job.partial,false); assert.ok(job.track);
      assert.equal(calls,1);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('request controls validate, persist and migrate old config defaults', async () => {
  const f = await fixture();
  try {
    f.service.configure({ requestIntervalMs: 1750, retryCount: 4 });
    const reopened = f.create();
    assert.equal(reopened.config().requestIntervalMs, 1750);
    assert.equal(reopened.config().retryCount, 4);
    await reopened.close();
    for (const update of [{ requestIntervalMs: -1 }, { requestIntervalMs: 60001 }, { requestIntervalMs: 1.5 }, { retryCount: -1 }, { retryCount: 6 }]) {
      assert.throws(() => f.service.configure(update), /translation-config-invalid/);
    }
    await writeFile(path.join(f.dir, 'translation-secret.json'), JSON.stringify({ apiKeys: [secret], model: 'gemini-flash-latest', enabled: true, batchSize: 120 }));
    const legacy = f.create();
    assert.equal(legacy.config().requestIntervalMs, 1000);
    assert.equal(legacy.config().retryCount, 2);
    await legacy.close();
  } finally { await f.close(); }
});

test('translation request spacing covers retries, batches and subsequent jobs', async () => {
  const starts: number[] = [], finishes: number[] = [];
  const f = await fixture(async (url, init) => {
    starts.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 10));
    finishes.push(Date.now());
    return starts.length === 1 ? new Response('', { status: 503 }) : fake(url, init);
  });
  try {
    f.service.configure({ requestIntervalMs: 40, retryCount: 1, batchSize: 10 });
    const content = 'WEBVTT\n\n' + Array.from({ length: 11 }, (_, i) => `00:00:01.000 --> 00:00:02.000\nLine ${i}`).join('\n\n');
    assert.equal((await wait(f.service, f.service.start('e', 'p', { ...input, content }).id)).state, 'completed');
    assert.equal((await wait(f.service, f.service.start('e', 'p', input).id)).state, 'completed');
    assert.equal(starts.length, 4);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - finishes[i - 1] >= 35, 'gap applies after request completion');
  } finally { await f.close(); }
});

test('retry count bounds transient failures and key failover; permanent errors are not retried', async () => {
  for (const [status, retries, expected] of [[503, 0, 1], [503, 2, 3], [401, 1, 2], [400, 5, 1], [404, 5, 1]]) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return new Response('', { status }); });
    try {
      f.service.configure({ retryCount: retries, addKeys: ['second-valid-key-test', 'third-valid-key-test'] });
      const job = await wait(f.service, f.service.start('e', 'p', input).id);
      assert.equal(job.state, 'failed');
      assert.equal(calls, expected, `status ${status}, retries ${retries}`);
    } finally { await f.close(); }
  }
});

test('cancel interrupts pacing and quota waits without sending another request', async () => {
  for (const quota of [false, true]) {
    let calls = 0;
    const f = await fixture(async (url, init) => { calls++; return quota ? new Response('', { status: 429 }) : fake(url, init); });
    try {
      f.service.configure({ requestIntervalMs: 60000, retryCount: 2, batchSize: 10 });
      const content = 'WEBVTT\n\n' + Array.from({ length: 11 }, (_, i) => `00:00:01.000 --> 00:00:02.000\nLine ${i}`).join('\n\n');
      const job = f.service.start('e', 'p', { ...input, content });
      while (!calls) await new Promise(r => setTimeout(r, 1));
      await new Promise(r => setTimeout(r, 15));
      f.service.cancel(job.id, 'p');
      assert.equal((await wait(f.service, job.id)).state, 'cancelled');
      await f.service.close();
      assert.equal(calls, 1);
    } finally { await f.close(); }
  }
});

test('removing a key during an active request does not break the following batch', async () => {
  const used: string[] = [];
  const f = await fixture(async (url, init) => {
    used.push(new Headers(init?.headers).get('x-goog-api-key')!);
    if (used.length === 1) f.service.configure({ removeKeyIds: [f.service.config().keys[0].id] });
    return fake(url, init);
  });
  try {
    f.service.configure({ addKeys: ['second-key-stays-active'], batchSize: 10 });
    const content = 'WEBVTT\n\n' + Array.from({ length: 11 }, (_, i) => `00:00:01.000 --> 00:00:02.000\nLine ${i}`).join('\n\n');
    assert.equal((await wait(f.service, f.service.start('e', 'p', { ...input, content }).id)).state, 'completed');
    assert.deepEqual(used, [secret, 'second-key-stays-active']);
  } finally { await f.close(); }
});
