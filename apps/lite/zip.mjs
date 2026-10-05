// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile, writeFile } from 'node:fs/promises';
// Small, uncompressed ZIP writer for flat connector packages; no Python/system tools required.
const table = Array.from({length:256}, (_,n) => {for(let i=0;i<8;i++) n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc(bytes) { let value=0xffffffff;for(const byte of bytes)value=(value>>>8)^table[(value^byte)&255];return (value^0xffffffff)>>>0; }
export async function zipDirectory(directory, output) {
  const locals=[], centrals=[];let offset=0;
  for(const name of (await readdir(directory)).sort()) {
    const filename=Buffer.from(name),bytes=await readFile(`${directory}/${name}`),checksum=crc(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);
    local.writeUInt32LE(checksum,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);
    central.writeUInt32LE(checksum,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,filename,bytes);centrals.push(central,filename);offset+=local.length+filename.length+bytes.length;
  }
  const directoryBytes=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(centrals.length/2,8);end.writeUInt16LE(centrals.length/2,10);end.writeUInt32LE(directoryBytes.length,12);end.writeUInt32LE(offset,16);
  await writeFile(output,Buffer.concat([...locals,directoryBytes,end]));
}
