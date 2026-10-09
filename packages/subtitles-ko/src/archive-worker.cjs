const { parentPort, workerData } = require('node:worker_threads');
const { once } = require('node:events');
const { openArchive } = require('./archive-decoder.cjs');
(async () => {
  const { input, maxBytes, maxEntries, decoderModule } = workerData;
  const archive = await openArchive(require(decoderModule), input, { maxBytes, maxEntries });
  const selected = once(parentPort, 'message');
  parentPort.postMessage({ files: archive.files });
  const [index] = await selected;
  if (!Number.isInteger(index)) throw new Error('Invalid archive member');
  parentPort.postMessage({ contents: archive.read(index) });
})().catch(() => parentPort.postMessage({ error: 'Archive decoding failed or exceeds limits' }));
