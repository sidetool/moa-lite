import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractSubtitleBuffer, safeZipPath } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));

test('WASM preserves Korean 7z filenames and selects the requested 화', async () => {
  const result = await extractSubtitleBuffer(fixture('lite-korean.7z'), 'batch.7z', { episode: 1, season: 1 });
  assert.equal(result?.filename, '구름 정원 1화.srt');
  assert.match(result!.content, /한글 자막 1화/);
  assert.equal(await extractSubtitleBuffer(fixture('lite-korean.7z'), 'batch.7z', { episode: 3 }), null);
});

test("multi-file ZIP selects the requested episode and preserves ASS", async () => {
  const result = await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, season: 2 });
  assert.equal(result?.filename, "작품 S02E03.ass");
  assert.equal(result?.format, "ass");
  assert.ok(result?.content.includes("반가워요"));
  assert.equal(result?.matchedEpisode, 3);
  assert.equal(await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 9, season: 2 }), null);
});

test("absolute episode mapping and CP949 ZIP filenames", async () => {
  const absolute = await extractSubtitleBuffer(fixture("absolute.zip"), "batch.zip", { episode: 3, alternateEpisode: 14, season: 2 });
  assert.equal(absolute?.matchedEpisode, 14);
  const legacy = await extractSubtitleBuffer(fixture("cp949.zip"), "batch.zip", { episode: 3 });
  assert.equal(legacy?.filename, "예제 03.ass");
  assert.equal(await extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 1, alternateEpisode: 3, season: 2 }), null);
});

test("path traversal and symlinks are ignored; archives never write to disk", async () => {
  for (const name of ["../03.ass", "/03.ass", "C:\\03.ass", "a/../../03.ass", "a\\..\\03.ass", "bad\0.ass"]) assert.equal(safeZipPath(name), false);
  const result = await extractSubtitleBuffer(fixture("unsafe.zip"), "batch.zip", { episode: 3 });
  assert.equal(result?.filename, "safe 03.ass");
});

test("ZIP size, count, bomb and forged size protections", async () => {
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, maxZipBytes: 10 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, maxEntries: 1 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("bomb.zip"), "batch.zip", { episode: 3 }), /limit/);
  await assert.rejects(extractSubtitleBuffer(fixture("forged.zip"), "batch.zip", { episode: 3, maxZipBytes: 4096 }));
});

test("unnumbered singleton needs a confirmed post, contradictory singleton is rejected", async () => {
  const raw = fixture("sample.ass");
  assert.equal(await extractSubtitleBuffer(raw, "other 13.ass", { episode: 3, allowUnnumbered: true }), null);
  assert.equal(await extractSubtitleBuffer(raw, "download", { episode: 3 }), null);
  assert.equal((await extractSubtitleBuffer(raw, "download", { episode: 3, allowUnnumbered: true }))?.format, "ass");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractSubtitleBuffer(fixture("episodes.zip"), "batch.zip", { episode: 3, signal: controller.signal }));
});

test('a range-named subtitle cannot masquerade as one episode', async () => {
  assert.equal(await extractSubtitleBuffer(fixture('sample.ass'),'작품 1~25.ass',{episode:1,allowUnnumbered:true}),null);
});
