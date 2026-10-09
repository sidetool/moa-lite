import { Select } from './ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { Settings } from '@moa/shared';
import { cx } from '../lib/format';
import {
  patchTranslationConfig, REQUEST_INTERVAL_MS, RETRY_COUNT, translationErrorMessage, translationKeys, translationModeOf, useTranslationConfig,
  type TranslationConfig, type TranslationConfigPatch
} from '../api/translation';
import { ApiError } from '../lib/api';

type Priority = Settings['translationSourcePriority'];
const PRIORITY: Array<[Priority, string, string]> = [
  ['site', '사이트 자막 먼저', '영상에 영어·일본어 자막이 있으면 그 자막을 번역하고, 없을 때만 Jimaku에서 찾아요.'],
  ['jimaku', 'Jimaku 먼저', 'Jimaku에서 이 회차의 일본어 자막을 먼저 찾고, 없으면 영상의 자막을 번역해요.']
];
const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))}초`;

/**
 * Collapsed by default: how automatic search and translation pick their original (per profile),
 * and, for admins, the server-wide request pacing and retries.
 */
export function SubtitleAdvancedSettings({ settings: s, admin, save }: { settings: Settings; admin: boolean; save: (patch: Partial<Settings>) => void }) {
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === '#subtitle-advanced');
  const region = useId();
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash !== '#subtitle-advanced') return;
    setOpen(true);
    requestAnimationFrame(() => anchor.current?.scrollIntoView({ block: 'start' }));
  }, [hash]);

  const config = useTranslationConfig().data;
  const mode = translationModeOf(s);
  const translating = Boolean(config?.configured && config.enabled);
  const summary = [
    PRIORITY.find(([value]) => value === s.translationSourcePriority)?.[1],
    s.skipSubtitleSearchWithSiteTrack ? '사이트 자막 있으면 검색 안 함' : '항상 자동 검색',
    s.skipTranslationWithoutSubtitles ? '자막 없는 영상 번역 안 함' : '자막 없는 영상도 번역',
    admin && config ? `요청 간격 ${seconds(config.requestIntervalMs)} · 재시도 ${config.retryCount}회` : null
  ].filter(Boolean).join(' · ');

  return (
    <div className="subtitle-advanced" id="subtitle-advanced" ref={anchor}>
      <button type="button" className="setting setting-disclosure" aria-expanded={open} aria-controls={region} onClick={() => setOpen(value => !value)}>
        <span className="setting-icon"><SlidersHorizontal size={20} /></span>
        <div><b>자막 고급설정</b><small>{summary}</small></div>
        <ChevronDown size={18} className={cx('disclosure-chevron', open && 'is-open')} aria-hidden="true" />
      </button>
      {open && (
        <div id={region} className="settings-advanced" role="region" aria-label="자막 고급설정">
          <div className="setting setting-stack">
            <div>
              <b>번역할 원문 순서</b>
              <small>{PRIORITY.find(([value]) => value === s.translationSourcePriority)?.[2]}</small>
              {translating && mode === 'manual' && <small className="is-muted">‘한국어 자막이 없을 때’가 번역할지 묻기·자동 번역일 때 쓰여요.</small>}
            </div>
            <div className="segmented" role="radiogroup" aria-label="번역할 원문 순서">
              {PRIORITY.map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={s.translationSourcePriority === value} className={cx(s.translationSourcePriority === value && 'is-active')}
                  onClick={() => { if (s.translationSourcePriority !== value) save({ translationSourcePriority: value }); }}>{label}</button>
              ))}
            </div>
          </div>
          <div className="setting">
            <div>
              <b>사이트 자막이 있으면 자동 검색 안 함</b>
              <small>영상에 한국어 자막이나 언어를 알 수 없는 자막이 있으면 자동 찾기와 번역 제안을 건너뛰어요. 영어·일본어처럼 언어가 표시된 자막만 있으면 그대로 진행해요. 자막 메뉴에서 직접 찾고 번역하는 건 언제든 할 수 있어요.</small>
            </div>
            <button role="switch" aria-checked={s.skipSubtitleSearchWithSiteTrack} aria-label="사이트 자막이 있으면 자동 검색 안 함" className={cx('switch', s.skipSubtitleSearchWithSiteTrack && 'is-on')}
              onClick={() => save({ skipSubtitleSearchWithSiteTrack: !s.skipSubtitleSearchWithSiteTrack })}><i /></button>
          </div>
          <div className="setting">
            <div>
              <b>자막이 없는 영상은 자동 번역 안 함</b>
              <small>영상에 자막이 하나도 없으면 화면에 자막이 입혀져 있을 수 있어서, 번역 제안과 Jimaku 자동 검색·자동 번역을 건너뛰어요. 한국어 자막 자동 찾기는 따로 동작하고, 자막 메뉴에서 직접 찾고 번역하는 건 언제든 할 수 있어요.</small>
            </div>
            <button role="switch" aria-checked={s.skipTranslationWithoutSubtitles} aria-label="자막이 없는 영상은 자동 번역 안 함" className={cx('switch', s.skipTranslationWithoutSubtitles && 'is-on')}
              onClick={() => save({ skipTranslationWithoutSubtitles: !s.skipTranslationWithoutSubtitles })}><i /></button>
          </div>
          {admin && <RequestControls />}
        </div>
      )}
    </div>
  );
}

/** Admin only: server-wide pacing between Gemini requests and retries per batch. */
function RequestControls() {
  const client = useQueryClient();
  const config = useTranslationConfig();
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (patch: TranslationConfigPatch) => patchTranslationConfig(patch),
    onSuccess: (data, patch) => {
      client.setQueryData<TranslationConfig>(translationKeys.config, data);
      setIntervalDraft(null);
      setMessage({ text: patch.retryCount !== undefined ? `재시도 ${data.retryCount}회로 저장했어요.` : `요청 간격을 ${seconds(data.requestIntervalMs)}로 저장했어요.` });
    },
    onError: error => {
      setIntervalDraft(null);
      setMessage({ text: error instanceof ApiError && error.code.startsWith('translation-') ? translationErrorMessage(error.code) : '저장하지 못했어요. 다시 시도해 주세요.', error: true });
    }
  });
  const c = config.data;
  if (config.isPending) return null;
  if (!c) return <p className="settings-error settings-advanced-note" role="alert">번역 요청 설정을 불러오지 못했어요.</p>;
  const commitInterval = () => {
    if (intervalDraft === null) return;
    const value = Number(intervalDraft.replace(',', '.'));
    const ms = Number.isFinite(value) ? Math.min(REQUEST_INTERVAL_MS.max, Math.max(REQUEST_INTERVAL_MS.min, Math.round(value * 1000))) : c.requestIntervalMs;
    if (ms === c.requestIntervalMs) setIntervalDraft(null); else save.mutate({ requestIntervalMs: ms });
  };
  const tries = c.retryCount + 1;
  return <>
    <p className="settings-advanced-label">관리자 · 모든 프로필의 AI 번역에 적용돼요</p>
    <div className="setting">
      <div>
        <b>번역 요청 간격</b>
        <small>번역 요청이 끝난 뒤 다음 요청까지 기다리는 시간이에요 (0–60초, 기본 {REQUEST_INTERVAL_MS.default / 1000}초). 키를 바꿔 다시 보낼 때도 지키고, 첫 요청과 저장된 번역은 기다리지 않아요. 사용 한도 초과가 잦으면 늘려 주세요.</small>
      </div>
      <label className="translation-batch">
        <input aria-label="번역 요청 간격(초)" inputMode="decimal" disabled={save.isPending} value={intervalDraft ?? String(c.requestIntervalMs / 1000)}
          onChange={e => setIntervalDraft(e.target.value.replace(/[^\d.,]/g, '').slice(0, 5))} onBlur={commitInterval}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitInterval(); } else if (e.key === 'Escape') setIntervalDraft(null); }} />
        <span>초</span>
      </label>
    </div>
    <div className="setting">
      <div>
        <b>실패 시 다시 시도</b>
        <small>한 묶음의 요청이 실패했을 때 더 시도하는 횟수예요. 다음 키로 바꿔 보내는 것도 포함돼요. {c.retryCount ? `지금은 한 묶음에 최대 ${tries}번 요청해요.` : '지금은 실패하면 바로 멈춰요.'}</small>
      </div>
      <Select className="setting-select" aria-label="실패 시 다시 시도" value={String(c.retryCount)} disabled={save.isPending} onChange={value => save.mutate({ retryCount: Number(value) })}
        options={Array.from({ length: RETRY_COUNT.max - RETRY_COUNT.min + 1 }, (_, i) => RETRY_COUNT.min + i).map(n => ({ value: String(n), label: n === 0 ? '안 함' : `${n}회${n === RETRY_COUNT.default ? ' (기본)' : ''}` }))} />
    </div>
    {message && <p className={cx('settings-advanced-note', message.error ? 'settings-error' : 'settings-hint')} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </>;
}
