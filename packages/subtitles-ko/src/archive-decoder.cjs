// Shared by the Node and browser workers. Keep Unicode paths intact and stream
// selected members to stdout; archive paths are never written to a filesystem.
exports.openArchive = async function (SevenZip, input, limits, moduleOptions = {}) {
  if (input.byteLength > limits.maxBytes) throw new Error('Archive exceeds input limit');
  let output = new Uint8Array(256 * 1024), length = 0;
  const decoder = await SevenZip({ ...moduleOptions,
    stdin: () => null,
    stdout: byte => {
      if (length >= output.length) throw new Error('Archive exceeds output limit');
      output[length++] = byte;
    }, stderr: () => {},
  });
  decoder.FS.writeFile('/input', input);
  const run = (args, cap) => {
    output = new Uint8Array(cap); length = 0;
    const code = decoder.callMain(args);
    if (code !== 0) throw new Error('Archive decoding failed or encrypted');
    return output.slice(0, length);
  };
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(run(['l', '-slt', '-sccUTF-8', '-pMOA_NO_PASSWORD', '--', '/input'], 256 * 1024));
  const sections = listing.split(/^----------\r?$/m);
  if (sections.length !== 2) throw new Error('Invalid archive listing');
  let total = 0;
  const files = sections[1].replace(/^[\r\n]+|[\r\n]+$/g, '').split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const record = Object.fromEntries(block.split(/\r?\n/).map(line => {
      const at = line.indexOf(' = ');
      if (at < 0) throw new Error('Invalid archive member');
      return [line.slice(0, at), line.slice(at + 3)];
    }));
    const name = record.Path, size = Number(record.Size);
    if (!name || !Number.isSafeInteger(size) || size < 0 || (total += size) > limits.maxBytes) throw new Error('Archive exceeds expansion limit');
    if (record.Encrypted === '+') throw new Error('Encrypted subtitles are unsupported');
    return { name, size, regular: record.Folder !== '+' && !record['Symbolic Link'] && !record['Hard Link'] && !/^[DL]/.test(record.Attributes || '') };
  });
  if (files.length > limits.maxEntries || new Set(files.map(file => file.name)).size !== files.length) throw new Error('Archive exceeds entry limit or has duplicate names');
  return { files, read(index) {
    const file = files[index];
    if (!file?.regular) throw new Error('Invalid archive member');
    const bytes = run(['x', '-so', '-spd', '-mmt=1', '-pMOA_NO_PASSWORD', '--', '/input', file.name], file.size + 1);
    if (bytes.length !== file.size) throw new Error('Archive member size mismatch');
    return bytes;
  } };
};
