import { createSubtitleClient, type SubtitleClientOptions, type SubtitleClient, type SubtitleQuery } from '@moa/subtitles-ko';
import type { OnlineSubtitleIssue } from '@moa/shared';

type Factory = (options: SubtitleClientOptions) => Pick<SubtitleClient, 'searchSubtitles'>;
/** Request-local diagnostics: source URLs and raw errors never reach the browser. */
export async function searchOnlineSubtitles(query: SubtitleQuery, signal: AbortSignal, factory: Factory = createSubtitleClient) {
  const issues: OnlineSubtitleIssue[] = [];
  let partial = false;
  const client = factory({ maxRequests: 64, maxResponseBytes: 2 * 1024 * 1024, maxZipBytes: 4 * 1024 * 1024, onDiagnostic(d) {
    if (['timeout', 'error', 'aborted'].includes(d.code)) partial = true;
    const kind: OnlineSubtitleIssue['kind'] = /HTTP (401|403)\b/.test(d.message ?? '') ? 'access-denied'
      : d.code === 'timeout' || d.code === 'aborted' ? 'timeout' : d.code === 'not-found' ? 'not-found' : 'fetch-failed';
    const creatorName = d.creatorName?.slice(0,100);
    if (issues.length < 16 && !issues.some(issue => issue.kind === kind && issue.creatorName === creatorName))
      issues.push({ kind, ...(creatorName ? { creatorName } : {}) });
  } });
  const candidates = await client.searchSubtitles({ ...query, timeoutMs: 20000, signal });
  return { candidates: candidates.filter(c => Buffer.byteLength(c.content) <= 1024 * 1024).slice(0,3), partial, issues };
}
