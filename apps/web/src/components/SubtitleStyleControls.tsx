import type { Settings } from '@moa/shared';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../lib/format';
import { Select } from './ui';

type Background = NonNullable<Settings['subtitleBackground']>;
type Size = Settings['subtitleSize'];
export interface SubtitleLook { scale: number; background: Background; outline: number | null; shadow: number | null; height: number; padding: number }

const PRESETS: Array<[Size, string, number]> = [['small', '작게', 80], ['medium', '보통', 100], ['large', '크게', 130], ['xlarge', '더 크게', 165]];
const BACKGROUNDS: Array<[Background, string]> = [['original', '기본'], ['none', '없음'], ['soft', '옅게'], ['solid', '진하게']];
const DEFAULT: SubtitleLook = { scale: 100, background: 'original', outline: null, shadow: null, height: 0, padding: 6 };
// Matches the player's VTT overlay font sizes when no explicit scale is saved.
const PRESET_FACTOR: Record<Size, number> = { small: .034, medium: .046, large: .058, xlarge: .074 };

const lookOf = (s: Settings): SubtitleLook => ({
  scale: s.subtitleScale ?? PRESETS.find(([size]) => size === s.subtitleSize)?.[2] ?? 100,
  background: s.subtitleBackground ?? 'original',
  outline: s.subtitleOutline ?? null,
  shadow: s.subtitleShadow ?? null,
  height: s.subtitleHeight ?? 0,
  padding: s.subtitlePadding ?? 6
});
const patchOf = (look: Partial<SubtitleLook>): Partial<Settings> => {
  const patch: Partial<Settings> = {};
  if ('scale' in look) {
    patch.subtitleScale = look.scale;
    // Keep the coarse size in step so clients that only read it stay close.
    patch.subtitleSize = PRESETS.reduce((best, item) => Math.abs(item[2] - look.scale!) < Math.abs(best[2] - look.scale!) ? item : best)[0];
  }
  if ('background' in look) patch.subtitleBackground = look.background;
  if ('outline' in look) patch.subtitleOutline = look.outline;
  if ('shadow' in look) patch.subtitleShadow = look.shadow;
  if ('height' in look) patch.subtitleHeight = look.height;
  if ('padding' in look) patch.subtitlePadding = look.padding;
  return patch;
};

// Fullscreen video size on this device, so pixel outlines and padding keep their real proportion.
const stageWidth = () => Math.min(1920, Math.max(640, Math.max(screen.width, screen.height) || 1280));

/**
 * A still frame rendered with the player overlay's rules on a fullscreen-sized stage, scaled to fit.
 * The scene runs from bright to dark so outline and background contrast show at a glance.
 */
export function SubtitlePreview({ look, size }: { look: SubtitleLook; size?: Size }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [width] = useState(stageWidth);
  const height = width * 9 / 16;
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setScale(element.clientWidth / width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  const fontSize = height * (size && look.scale === PRESETS.find(([value]) => value === size)?.[2] ? PRESET_FACTOR[size] : .046 * look.scale / 100);
  const text: React.CSSProperties = {
    padding: `${look.padding / 2}px ${look.padding}px`,
    background: look.background === 'solid' ? '#000' : look.background === 'none' ? 'none' : 'rgba(0, 0, 0, .5)',
    textShadow: look.shadow !== null ? (look.shadow ? `0 ${look.shadow}px ${look.shadow * 1.5}px #000` : 'none') : look.background === 'none' ? '0 1px 3px #000' : 'none',
    WebkitTextStroke: look.outline ? `${look.outline}px #000` : undefined
  };
  return (
    <div className="subtitle-preview" ref={frame} aria-hidden="true">
      <div className="subtitle-preview-stage" style={{ width, height, transform: `scale(${scale})`, visibility: scale ? undefined : 'hidden' }}>
        <div className="subtitle-preview-cue" style={{ bottom: `calc(${look.height}% + ${Math.round(height / 30)}px)`, fontSize }}>
          <span style={text}>오늘은 여기까지 하자.{'\n'}내일 다시 만나러 올게.</span>
        </div>
      </div>
    </div>
  );
}

/** Slider for quick changes, with the value beside it editable for an exact number. */
function Range({ label, value, min, max, step, unit, empty, disabled, onChange }: { label: string; value: number | null; min: number; max: number; step: number; unit: string; empty?: string; disabled?: boolean; onChange: (value: number) => void }) {
  const text = value === null ? '' : String(value);
  const [draft, setDraftState] = useState(text);
  // Mirrors the draft synchronously, so Escape and unmount read the latest text.
  const latest = useRef(text);
  const setDraft = (next: string) => { latest.current = next; setDraftState(next); };
  useEffect(() => { setDraft(text); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const typed = latest.current;
    if (typed === text) return;
    const next = Number(typed.replace(',', '.'));
    if (typed.trim() === '' || !Number.isFinite(next)) { setDraft(text); return; }
    const clamped = Math.min(max, Math.max(min, Math.round(next * 10) / 10));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  // Closing the panel while typing removes the field without a blur; keep what was typed.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  const position = value ?? min;
  const slide = (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next * 10) / 10)));
  return (
    <div className="sub-style-range">
      <input type="range" aria-label={label} min={min} max={max} step="any" value={position} disabled={disabled}
        style={{ '--fill': `${(position - min) / (max - min) * 100}%` } as React.CSSProperties} onChange={event => slide(Math.round(Number(event.target.value) / step) * step)}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); slide(position + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step)); } }} />
      <label className={cx('sub-style-value', disabled && 'is-disabled')}>
        <input type="number" inputMode="decimal" aria-label={label} min={min} max={max} step={step} value={draft} placeholder={empty} disabled={disabled}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { setDraft(text); event.currentTarget.blur(); } }} />
        <span>{value !== null || draft !== '' ? unit : ''}</span>
      </label>
    </div>
  );
}

export function SubtitleStyleControls({ settings, save, variant = 'page', format }: { settings: Settings; save: (patch: Partial<Settings>) => void; variant?: 'page' | 'player'; format?: 'ass' | 'vtt' }) {
  const [interval, setInterval] = useState('1');
  const look = lookOf(settings);
  const change = (next: Partial<SubtitleLook>) => save(patchOf(next));
  const changed = (key: keyof SubtitleLook) => look[key] !== DEFAULT[key];
  const anyChanged = (Object.keys(DEFAULT) as Array<keyof SubtitleLook>).some(changed);
  const step = Number(interval);
  const boxed = look.background === 'soft' || look.background === 'solid';

  // The reset sits beside the label so the controls keep the full width.
  const row = (key: keyof SubtitleLook, label: string, control: React.ReactNode) => (
    <div className={cx('sub-style-row', `is-${key}`)}>
      <span className="sub-style-label">
        {label}
        <button type="button" className="sub-style-reset" aria-label={`${label} 기본값으로`} title="기본값으로" tabIndex={changed(key) ? 0 : -1} aria-hidden={!changed(key)}
          onClick={() => change({ [key]: DEFAULT[key] })}><RotateCcw size={13} /></button>
      </span>
      <div className="sub-style-control">{control}</div>
    </div>
  );

  return (
    <div className={cx('sub-style', `is-${variant}`)}>
      {/* In the player the video itself shows each change. */}
      {variant === 'page' && <div className="sub-style-preview">
        <SubtitlePreview look={look} size={settings.subtitleScale == null ? settings.subtitleSize : undefined} />
        {anyChanged && <button type="button" className="sub-style-reset-all" onClick={() => change(DEFAULT)}>모두 기본값</button>}
      </div>}
      <div className="sub-style-toolbar"><span>조절 간격</span><Select aria-label="슬라이더 간격" value={interval} onChange={setInterval} options={[{ value: '1', label: '1% · 0.1px' }, { value: '5', label: '5% · 0.5px' }, { value: '10', label: '10% · 1px' }]} /></div>
      <div className="sub-style-rows">
        {row('scale', '크기', <Range label="자막 크기" value={look.scale} min={50} max={250} step={step} unit="%" onChange={scale => change({ scale })} />)}
        {row('background', '배경', <div className="seg" role="radiogroup" aria-label="자막 배경">
          {BACKGROUNDS.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={look.background === value} className={cx(look.background === value && 'is-active')} onClick={() => change({ background: value })}>{label}</button>)}
        </div>)}
      </div>
      <details className="sub-style-details"><summary>상세 조절<ChevronDown size={16} /></summary><div className="sub-style-rows">
        {row('padding', '배경 여백', <Range label="자막 배경 여백" value={look.padding} min={0} max={20} step={step / 10} unit="px" disabled={!boxed} onChange={padding => change({ padding })} />)}
        {row('outline', '윤곽선', <Range label="자막 윤곽선" value={look.outline} min={0} max={6} step={step / 10} unit="px" empty="원본" onChange={outline => change({ outline })} />)}
        {row('shadow', '그림자', <Range label="자막 그림자" value={look.shadow} min={0} max={10} step={step / 10} unit="px" empty="원본" onChange={shadow => change({ shadow })} />)}
        {row('height', '위치', <Range label="자막 높이" value={look.height} min={0} max={40} step={step} unit="%" disabled={format === 'ass'} onChange={height => change({ height })} />)}
      </div></details>
      {variant === 'player' && anyChanged && <button type="button" className="sub-style-reset-all is-inline" onClick={() => change(DEFAULT)}>모양 모두 기본값</button>}
      <small className="sub-style-note">ASS 자막의 위치는 원본을 따릅니다.</small>
    </div>
  );
}
