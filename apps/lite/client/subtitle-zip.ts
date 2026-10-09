import { unzipSync } from 'fflate';
import { safeZipPath } from '../../../packages/subtitles-ko/src/archive-path.js';
const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = byte & 1 ? 0xedb88320 ^ (byte >>> 1) : byte >>> 1;
  return byte >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read original ZIP name bytes before the decoder's Latin-1 fallback loses the encoding. */
export function importZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65558) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Invalid ZIP');
  const count = view.getUint16(end + 10, true);
  if (count > 300) throw new Error('Archive exceeds entry limit');
  let offset = view.getUint32(end + 16, true), total = 0;
  const names = new Map<string, { name: string; size: number; crc: number; regular: boolean }>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP');
    const flags = view.getUint16(offset + 8, true), size = view.getUint32(offset + 24, true);
    const compressed = view.getUint32(offset + 20, true), length = view.getUint16(offset + 28, true);
    if (flags & 1 || size === 0xffffffff || (total += size) > 16 * 1024 * 1024 || size / Math.max(1, compressed) > 250) throw new Error('Archive encrypted or exceeds limit');
    const raw = bytes.subarray(offset + 46, offset + 46 + length);
    if (raw.length !== length) throw new Error('Invalid ZIP name');
    const key = flags & 2048 ? new TextDecoder('utf-8', {fatal: true}).decode(raw) : Array.from(raw, byte => String.fromCharCode(byte)).join('');
    let name: string;
    try { name = new TextDecoder('utf-8', {fatal: true}).decode(raw); }
    catch { name = new TextDecoder('euc-kr', {fatal: true}).decode(raw); }
    const mode = view.getUint32(offset + 38, true) >>> 16 & 0xf000;
    if (names.has(key)) throw new Error('Duplicate ZIP name');
    names.set(key, { name, size, crc: view.getUint32(offset + 16, true), regular: (!mode || mode === 0x8000) && safeZipPath(name) && /\.(?:srt|vtt|vvt|ass|ssa|smi|sami)$/i.test(name) });
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  const selected = [...names.values()].filter(file => file.regular);
  if (!selected.length || selected.length > 32 || selected.some(file => file.size > 4 * 1024 * 1024)) throw new Error('Archive empty or exceeds limits');
  const files = unzipSync(bytes, { filter: file => names.get(file.name)?.regular === true });
  return Object.entries(files).map(([key, content]) => {
    const file = names.get(key)!;
    if (content.length !== file.size || crc32(content) !== file.crc) throw new Error('ZIP size or checksum mismatch');
    return { name: file.name, content };
  });
}
