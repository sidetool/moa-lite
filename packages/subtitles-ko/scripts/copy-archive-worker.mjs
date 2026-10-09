import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/archive-worker.cjs', import.meta.url), new URL('../dist/archive-worker.cjs', import.meta.url));

await copyFile(new URL('../src/archive-decoder.cjs', import.meta.url), new URL('../dist/archive-decoder.cjs', import.meta.url));
