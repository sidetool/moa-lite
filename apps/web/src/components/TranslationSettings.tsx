import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { KeyRound, Trash2 } from 'lucide-react';
import { ApiError } from '../lib/api';
import { cx } from '../lib/format';
import {
  BATCH_SIZE, patchTranslationConfig, translationErrorMessage, translationKeys, translationModels, TRANSLATION_MAX_KEYS, useTranslationConfig,
  type TranslationConfig, type TranslationConfigPatch
} from '../api/translation';
import { Button, ConfirmDialog, Select, IconButton, Skeleton } from './ui';

const apiMessage = (error: unknown, fallback: string) => error instanceof ApiError && error.code.startsWith('translation-') ? translationErrorMessage(error.code) : fallback;
const clampBatch = (value: number) => Math.min(BATCH_SIZE.max, Math.max(BATCH_SIZE.min, Math.round(value) || BATCH_SIZE.default));

/** Admin-only Gemini keys, model and batch size. Keys are write-only: the server returns masked labels. */
export function TranslationSettings() {
  const client = useQueryClient();
  const config = useTranslationConfig();
  const { hash } = useLocation();
  const section = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState('');
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (hash === '#translation' && config.data) section.current?.scrollIntoView({ block: 'start' });
  }, [hash, Boolean(config.data)]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = useMutation({
    mutationFn: translationModels,
    onSuccess: data => { setModels(data.models); setMessage({ text: `키 확인 완료 · 사용할 수 있는 모델 ${data.models.length}개` }); },
    onError: error => setMessage({ text: apiMessage(error, '모델 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'), error: true })
  });
  const save = useMutation({
    mutationFn: (patch: TranslationConfigPatch) => patchTranslationConfig(patch),
    onSuccess: (data, patch) => {
      client.setQueryData<TranslationConfig>(translationKeys.config, data);
      if (patch.addKeys) { setDraft(''); setMessage({ text: `키 ${patch.addKeys.length}개를 저장했어요. 확인하는 중…` }); loadModels.mutate(); }
      else if (patch.removeKeyIds) { setMessage({ text: data.keys.length ? '키를 지웠어요.' : '키를 모두 지웠어요. 번역을 사용할 수 없어요.' }); if (!data.keys.length) setModels(null); }
      else if (patch.batchSize !== undefined) { setBatch(null); setMessage({ text: `묶음당 ${data.batchSize}줄로 저장했어요.` }); }
      else setMessage(null);
    },
    onError: (error, patch) => {
      if (patch.batchSize !== undefined) setBatch(null);
      setMessage({ text: apiMessage(error, '저장하지 못했어요. 다시 시도해 주세요.'), error: true });
    }
  });

  const c = config.data;
  const busy = save.isPending || loadModels.isPending;
  const keys = c?.keys ?? [];
  const lines = [...new Set(draft.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  const room = TRANSLATION_MAX_KEYS - keys.length;
  const tooMany = lines.length > room;
  const options = [...new Set([...(c ? [c.model] : []), ...(models ?? [])])];
  const commitBatch = () => {
    if (batch === null || !c) return;
    const value = clampBatch(Number(batch));
    if (value === c.batchSize) setBatch(null); else save.mutate({ batchSize: value });
  };

  return <section className="settings-group" id="translation" ref={section}>
    <h2>자막 번역</h2>
    {removeKey && <ConfirmDialog title="번역 키 삭제" confirmLabel="삭제" busy={save.isPending} onClose={() => setRemoveKey(null)} onConfirm={() => save.mutate({removeKeyIds:[removeKey]}, {onSuccess:()=>setRemoveKey(null)})}>저장한 번역 키를 지울까요? 마지막 키를 지우면 번역을 사용할 수 없어요.</ConfirmDialog>}
    <div className="settings-card">
      {config.isPending ? <Skeleton className="folder-sk" /> : config.isError || !c ? <p className="settings-error translation-error" role="alert">번역 설정을 불러오지 못했어요. <button className="text-btn" onClick={() => void config.refetch()}>다시 시도</button></p> : <>
        <div className="setting">
          <div><b>AI 자막 번역</b><small>외국어 자막을 Gemini로 한국어로 번역해요. 재생 중 자막 메뉴에서 직접 요청할 때만 번역하며, 요청마다 API 사용료가 발생할 수 있어요.</small></div>
          <button role="switch" aria-checked={c.enabled} aria-label="AI 자막 번역" disabled={!c.configured || busy} className={cx('switch', c.enabled && 'is-on')} onClick={() => save.mutate({ enabled: !c.enabled })}><i /></button>
        </div>

        <div className="translation-keys">
          <div className="translation-keys-head">
            <div><b>Gemini API 키</b><small>등록한 순서대로 쓰고, 한도나 오류로 막히면 다음 키로 넘어가요. 저장한 키는 다시 보여 주지 않아요.</small></div>
            <span className={cx('status-pill', c.configured && 'is-ok')}>{keys.length ? `${keys.length}개` : '없음'}</span>
          </div>
          {keys.length > 0 && <ol className="translation-key-list" aria-label="등록된 키">
            {keys.map((key, i) => <li key={key.id}>
              <span className="translation-key-order">{i + 1}</span>
              <KeyRound size={16} aria-hidden="true" />
              <code>{key.label}</code>
              <IconButton label={`${i + 1}번 키 지우기`} disabled={busy} onClick={() => setRemoveKey(key.id)}><Trash2 size={16} /></IconButton>
            </li>)}
          </ol>}
          {room > 0 ? <form className="translation-key-add" onSubmit={e => { e.preventDefault(); if (lines.length && !tooMany) save.mutate({ addKeys: lines }); }}>
            <textarea aria-label="추가할 Gemini API 키" name="gemini-api-keys" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} rows={Math.min(4, Math.max(1, lines.length + (draft.endsWith('\n') ? 1 : 0)))}
              placeholder={keys.length ? '키 추가 (여러 개는 줄마다 하나씩)' : 'Google AI Studio에서 발급한 키 (여러 개는 줄마다 하나씩)'}
              value={draft} onChange={e => { setDraft(e.target.value); setMessage(null); }} />
            <div className="network-actions">
              <small className={cx('translation-key-count', tooMany && 'is-over')}>{tooMany ? `최대 ${TRANSLATION_MAX_KEYS}개까지 · ${room}개 더 추가할 수 있어요` : lines.length ? `${lines.length}개 입력됨` : `최대 ${TRANSLATION_MAX_KEYS}개`}</small>
              <Button type="submit" variant="primary" disabled={!lines.length || tooMany || busy}>{save.isPending && save.variables?.addKeys ? '저장 중…' : '키 저장'}</Button>
            </div>
          </form> : <p className="settings-hint translation-key-full">키는 최대 {TRANSLATION_MAX_KEYS}개까지 등록할 수 있어요. 새 키를 넣으려면 하나를 지워 주세요.</p>}
        </div>

        <div className="setting">
          <div><b>번역 모델</b><small>{c.configured ? '키로 사용할 수 있는 Gemini 모델을 불러와 바꿀 수 있어요.' : '키를 저장하면 모델을 고를 수 있어요.'}</small></div>
          <div className="translation-model">
            <Select className="setting-select" aria-label="번역 모델" value={c.model} disabled={!c.configured || busy} onChange={model => save.mutate({ model })} options={options.map(model => ({value: model, label: model}))} />
            <Button type="button" disabled={!c.configured || busy} onClick={() => { setMessage(null); loadModels.mutate(); }}>{loadModels.isPending ? '확인 중…' : models ? '새로고침' : '모델 불러오기'}</Button>
          </div>
        </div>
        <div className="setting">
          <div><b>묶음당 자막 수</b><small>한 번에 보내는 자막 줄 수 ({BATCH_SIZE.min}–{BATCH_SIZE.max}). 크게 하면 요청 수가 줄고, 작게 하면 실패해도 다시 보내는 양이 적어요.</small></div>
          <label className="translation-batch">
            <input aria-label="묶음당 자막 수" inputMode="numeric" disabled={busy} value={batch ?? String(c.batchSize)}
              onChange={e => setBatch(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={commitBatch}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitBatch(); } else if (e.key === 'Escape') setBatch(null); }} />
            <span>줄</span>
          </label>
        </div>
        <p className="settings-hint translation-message">요청 간격과 실패 시 다시 시도 횟수는 <Link className="text-btn" to="/settings#subtitle-advanced">자막 고급설정</Link>에서 바꿀 수 있어요.</p>
        {message && <p className={cx('translation-message', message.error ? 'settings-error' : 'settings-hint')} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      </>}
    </div>
  </section>;
}
