import { writeFile } from 'node:fs/promises';
import { PublicHttpClient } from '../src/http.js';
import { parseCreatorDirectory, type DirectoryEntry } from '../src/directory.js';
const references = [70,110,121,122,124,125,128,129,130].map(id => `https://mgsstory.tistory.com/${id}`);
const http = new PublicHttpClient(8000), entries: DirectoryEntry[] = [];
// Explicit maintenance command; searches never crawl the directory pages.
for (const reference of references) {
  const response = await http.get(reference, {signal: AbortSignal.timeout(10000), maxBytes: 2_000_000});
  const found = parseCreatorDirectory(response.body.toString('utf8'), reference);
  if (!found.length) throw new Error(`No entries: ${reference}; keeping previous directory`);
  entries.push(...found);
}
const unique = [...new Map(entries.map(entry => [`${entry.title}|${entry.website}`, entry])).values()];
await writeFile(new URL('../src/creator-directory.json', import.meta.url), JSON.stringify({ updated: new Date().toISOString().slice(0,10), references, entries: unique }, null, 2) + '\n');
console.log(JSON.stringify({ entries: unique.length, creators: new Set(unique.map(e => e.name)).size }));
