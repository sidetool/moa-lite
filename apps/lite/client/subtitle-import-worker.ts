import { openArchive } from '../../../packages/subtitles-ko/src/archive-decoder.cjs';
import { safeZipPath } from '../../../packages/subtitles-ko/src/archive-path.js';
import { convertSubtitle, decodeSubtitleBuffer } from '../../../packages/subtitles-ko/src/convert.js';
import { importZip } from './subtitle-zip.js';

const subtitleName = /\.(?:srt|vtt|vvt|ass|ssa|smi|sami)$/i;
onmessage = async ({ data }: MessageEvent<{ filename: string; bytes: Uint8Array }>) => {
  try {
    const { filename, bytes } = data;
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('자막 파일은 10MB 이하로 선택해 주세요.');
    const convert = (name: string, input: Uint8Array) => {
      if (input.byteLength > 4 * 1024 * 1024) throw new Error('압축 안의 자막은 파일당 4MB 이하만 지원해요.');
      return { filename: name.split(/[\\/]/).at(-1)!, ...convertSubtitle(decodeSubtitleBuffer(input)) };
    };
    if (subtitleName.test(filename)) { postMessage({ files: [convert(filename, bytes)] }); return; }
    if (!/\.(?:zip|7z|rar)$/i.test(filename)) throw new Error('지원하지 않는 자막 파일이에요.');
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) { postMessage({ files: importZip(bytes).map(file => convert(file.name, file.content)) }); return; }
    (globalThis as any).importScripts('/runtime/7zz.umd.js');
    const archive = await openArchive((globalThis as any).SevenZip, bytes, { maxBytes: 16 * 1024 * 1024, maxEntries: 300 }, { locateFile: (name: string) => '/runtime/' + name });
    const entries = archive.files.map((file, index) => ({ ...file, index })).filter(file => file.regular && safeZipPath(file.name) && subtitleName.test(file.name));
    if (!entries.length) throw new Error('압축 파일에 지원하는 자막이 없어요.');
    if (entries.length > 32) throw new Error('압축 파일의 자막은 32개까지 가져올 수 있어요.');
    postMessage({ files: entries.map(file => convert(file.name, archive.read(file.index))) });
  } catch (error) {
    postMessage({ error: /[가-힣]/.test(String(error)) ? (error as Error).message : '자막을 읽지 못했어요. 파일 형식·암호·압축 크기를 확인해 주세요.' });
  }
};
