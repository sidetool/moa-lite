import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard } from 'lucide-react';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { Button, ConfirmDialog } from './ui';

interface TmdbConfig { configured: boolean; source: 'environment' | 'database' | 'none'; credentialType: 'token' | 'apiKey' | null; hasSavedCredential: boolean }
type TmdbPatch = { token: string } | { apiKey: string } | { clear: true };

const tmdbKey = ['tmdb-config'] as const;
// A v3 API key is 32 hex characters; anything else is treated as a v4 read access token.
const patchFor = (value: string): TmdbPatch => /^[0-9a-f]{32}$/i.test(value) ? { apiKey: value.toLowerCase() } : { token: value };

/** Admin-only TMDB credential. Write-only: the server reports where the key comes from, never the key. */
export function TmdbSettings() {
  const client = useQueryClient();
  const config = useQuery({ queryKey: tmdbKey, queryFn: () => api<TmdbConfig>('/admin/tmdb/config'), staleTime: 60_000 });
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: TmdbPatch) => api<TmdbConfig>('/admin/tmdb/config', { method: 'PATCH', body }),
    onSuccess: (data, body) => {
      client.setQueryData(tmdbKey, data);
      void client.invalidateQueries({ queryKey: ['metadata-status'] });
      setDraft('');
      setDeleting(false);
      setMessage({ text: 'clear' in body ? '저장한 키를 지웠어요.' : '키를 저장했어요. 새로 여는 작품부터 정보가 붙어요.' });
    },
    onError: () => setMessage({ text: '키 형식을 확인해 주세요. TMDB의 API 읽기 액세스 토큰이나 API 키를 넣으면 돼요.', error: true })
  });

  const c = config.data;
  const value = draft.trim();
  const fromEnv = c?.source === 'environment';
  const status = config.isPending ? '확인 중' : !c ? '알 수 없음' : c.configured ? '사용 중' : '꺼짐';

  return <div className="tmdb-setting">
    <div className="setting">
      <span className="setting-icon"><Clapperboard size={20} /></span>
      <div><b>작품 정보 (TMDB)</b><small>포스터·로고·줄거리·출연진·회차 정보를 TMDB에서 가져와요. 잘못 연결된 작품은 상세 화면 아래에서 고칠 수 있어요.</small></div>
      <span className={cx('status-pill', c?.configured && 'is-ok')}>{status}</span>
    </div>
    {config.isError && <p className="settings-error" role="alert">TMDB 설정을 불러오지 못했어요. <button className="text-btn" onClick={() => void config.refetch()}>다시 시도</button></p>}
    {c && <div className="tmdb-key">
      {fromEnv
        ? <p className="settings-hint">서버의 환경 변수(<code>.env</code>)에 있는 키를 쓰고 있어요. 바꾸려면 서버 설정에서 고쳐 주세요.</p>
        : <form className="tmdb-key-form" onSubmit={e => { e.preventDefault(); if (value) save.mutate(patchFor(value)); }}>
          <label htmlFor="tmdb-key">{c.hasSavedCredential ? '새 키로 바꾸기' : 'TMDB 키'}</label>
          <div className="tmdb-key-row">
            <input id="tmdb-key" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              placeholder={c.hasSavedCredential ? `저장됨 · ${c.credentialType === 'apiKey' ? 'API 키' : '읽기 액세스 토큰'}` : 'API 읽기 액세스 토큰 또는 API 키'}
              value={draft} onChange={e => { setDraft(e.target.value); setMessage(null); }} />
            <Button type="submit" variant="primary" disabled={!value || save.isPending}>{save.isPending && !('clear' in (save.variables ?? {})) ? '저장 중…' : '저장'}</Button>
          </div>
          <small className="settings-hint">TMDB 계정의 <a className="text-btn" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">설정 → API</a>에서 무료로 받을 수 있어요. 저장한 키는 다시 보여 주지 않아요.</small>
          {c.hasSavedCredential && <button type="button" className="text-btn tmdb-clear" disabled={save.isPending} onClick={() => { setMessage(null); setDeleting(true); }}>저장한 키 지우기</button>}
        </form>}
      {message && <p className={message.error ? 'settings-error' : 'settings-hint'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </div>}
    {deleting && <ConfirmDialog title="TMDB 키 삭제" confirmLabel="삭제" busy={save.isPending} onClose={() => setDeleting(false)} onConfirm={() => save.mutate({ clear: true })}>저장한 TMDB 키를 지울까요? 작품 정보를 더 가져오지 않아요.{message?.error && <p className="settings-error" role="alert">{message.text}</p>}</ConfirmDialog>}
  </div>;
}
