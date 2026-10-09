import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {importZip} from '../client/subtitle-zip.js';
const fixture=(name:string)=>readFileSync(new URL('../../../packages/subtitles-ko/test/fixtures/'+name,import.meta.url));
test('local ZIP import preserves Korean legacy names and rejects unsafe members',()=>{
  assert.equal(importZip(fixture('cp949.zip'))[0].name,'예제 03.ass');
  const safe=importZip(fixture('unsafe.zip'));
  assert.deepEqual(safe.map(file=>file.name),['safe 03.ass']);
});
test('local ZIP import rejects malformed and oversized archives before decompression',()=>{
  for(const name of ['bomb.zip','forged.zip']) assert.throws(()=>importZip(fixture(name)));
  assert.throws(()=>importZip(new Uint8Array(10)));
  assert.throws(()=>importZip(new Uint8Array(100000)));
});
