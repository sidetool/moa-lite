import type { SubtitleTrack } from '@moa/shared';
import { currentProfileId } from '../lib/api';

export const SUBTITLE_FILES = '.srt,.vtt,.vvt,.ass,.ssa,.smi,.sami,.zip,.7z,.rar';
/** Local import: bytes never go through a Vercel function or cloud sync. */
export async function importSubtitleFile(file: File, signal: AbortSignal): Promise<SubtitleTrack[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error('자막 파일은 10MB 이하로 선택해 주세요.');
  if (!SUBTITLE_FILES.split(',').some(ext => file.name.toLowerCase().endsWith(ext))) throw new Error('SRT·VTT·ASS·SMI·ZIP·7z·RAR 파일을 선택해 주세요.');
  const profile = currentProfileId();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const worker = new Worker('/runtime/subtitle-import-worker.js');
  try {
    const files = await new Promise<{filename: string; content: string; format: 'ass' | 'vtt'}[]>((resolve, reject) => {
      const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('자막 처리 시간이 초과됐어요. 압축을 풀고 자막 파일을 선택해 주세요.')), 15000);
      const finish = (error?: Error, value?: any) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      worker.onmessage = ({data}) => finish(data.error ? new Error(data.error) : undefined, data.files);
      worker.onerror = () => finish(new Error('자막 파일을 읽지 못했어요.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      worker.postMessage({ filename: file.name, bytes }, [bytes.buffer]);
    });
    signal.throwIfAborted();
    if (currentProfileId() !== profile) throw new DOMException('프로필이 변경되었어요.', 'AbortError');
    return files.map(file => ({ id: 'upload-' + crypto.randomUUID(), label: file.filename, format: file.format, source: 'upload',
      url: URL.createObjectURL(new Blob([file.content], { type: file.format === 'ass' ? 'text/x-ssa' : 'text/vtt' })) }));
  } finally { worker.terminate(); }
}
