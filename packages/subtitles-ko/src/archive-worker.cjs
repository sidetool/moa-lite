// Server-only WASM decoder. No archive entries are written to the filesystem.
const { parentPort, workerData } = require('node:worker_threads');
const { ArchiveReader, libarchiveWasm } = require(workerData.decoderModule);
const { once } = require('node:events');
(async () => {
  const { input, maxBytes, maxEntries } = workerData;
  const module = await libarchiveWasm();
  const bytes = new Int8Array(input);
  let reader = new ArchiveReader(module, bytes);
  const files = [];
  let total = 0;
  try {
    for (const entry of reader.entries()) {
      const size = entry.getSize(), name = entry.getPathname();
      if (files.length >= maxEntries) throw new Error('Archive exceeds entry limit');
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > maxBytes) throw new Error('Archive exceeds expansion limit');
      if (entry.isEncrypted()) throw new Error('Encrypted subtitles are unsupported');
      files.push({ name, size, regular: entry.getFiletype() === 'File' && !entry.getHardlinkTarget() && !entry.getSymlinkTarget() });
    }
  } finally { reader.free(); }
  const selected = once(parentPort, 'message');
  parentPort.postMessage({ files });
  const [index] = await selected;
  if (!Number.isInteger(index) || index < 0 || index >= files.length || !files[index].regular) throw new Error('Invalid archive member');
  reader = new ArchiveReader(module, bytes);
  try {
    let current = 0;
    for (const entry of reader.entries()) {
      if (current++ !== index) continue;
      const contents = entry.readData();
      if (!contents || contents.length !== files[index].size) throw new Error('Archive member size mismatch');
      parentPort.postMessage({ contents });
      return;
    }
    throw new Error('Archive member missing');
  } finally { reader.free(); }
})().catch(() => parentPort.postMessage({ error: 'Archive decoding failed or exceeds limits' }));
