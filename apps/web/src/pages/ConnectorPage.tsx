import { useEffect, useState } from 'react';
import { Check, Copy, Download, Info } from 'lucide-react';
import { Button, ButtonLink } from '../components/ui';
import { cx } from '../lib/format';

type Status = { installed: boolean; version?: string; hostPermission?: boolean };
type Browser = 'chromium' | 'android' | 'firefox';

const lite = () => import('../../../lite/client/index');
const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const defaultBrowser: Browser = /Firefox\//.test(navigator.userAgent) ? 'firefox' : /Android/i.test(navigator.userAgent) ? 'android' : 'chromium';

function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };
  return <Button type="button" icon={done ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copy()}>{done ? '복사됨' : label}</Button>;
}

/** Shared connector status for settings rows and this page. Re-checks while the page is open and not yet connected. */
export function useConnectorStatus(poll = false) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true, unsubscribe = () => {};
    void lite().then(client => {
      if (!alive) return;
      unsubscribe = client.onConnectorStatusChange(next => setStatus(next));
      void client.getConnectorStatus().then(next => { if (alive) setStatus(next); });
    });
    return () => { alive = false; unsubscribe(); };
  }, []);
  const waiting = poll && !status?.installed;
  useEffect(() => {
    if (!waiting) return;
    // postMessage handshake only; no network request.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void lite().then(client => client.getConnectorStatus()); }, 3000);
    return () => clearInterval(timer);
  }, [waiting]);
  return status;
}

export function connectorSummary(status: Status | null) {
  if (!status) return '확인하는 중…';
  if (!status.installed) return '설치하면 막히는 소스를 내 브라우저로 연결해요';
  if (status.hostPermission === false) return '사이트 접근 권한이 필요해요';
  return '연결됨';
}

function StatusCard({ status }: { status: Status | null }) {
  const state = !status ? 'starting' : !status.installed ? 'idle' : status.hostPermission === false ? 'error' : 'connected';
  const title = state === 'connected' ? '연결됨' : state === 'error' ? '사이트 접근 권한이 필요해요' : state === 'starting' ? '확인하는 중…' : '아직 연결되지 않았어요';
  return <section className={cx('remote-status', state === 'connected' && 'is-connected', state === 'error' && 'is-error')} aria-live="polite">
    <header className="remote-status-head">
      <span className={cx('remote-dot', state === 'connected' && 'is-connected', state === 'error' && 'is-error', state === 'starting' && 'is-starting')} aria-hidden="true" />
      <div>
        <b>{title}</b>
        <small>{state === 'connected' ? `이 브라우저 · 확장 ${status?.version ?? ''}`.trim()
          : state === 'error' ? '확장 아이콘을 누르고 권한 허용을 눌러 주세요.'
          : state === 'idle' ? '설치를 마치면 이 화면이 자동으로 바뀌어요.' : '잠시만 기다려 주세요.'}</small>
      </div>
    </header>
  </section>;
}

function Steps({ browser }: { browser: Browser }) {
  const zip = `/install/moa-lite-connector-${browser === 'firefox' ? 'firefox' : 'chromium'}.zip`;
  const download = <a className="btn btn-primary btn-m" href={zip} download><Download size={16} /><span>확장 받기</span></a>;
  const connect = <li>설치하면 열리는 창에서 <b>이 탭 주소로 연결</b>을 누르거나, 아래 앱 주소를 붙여 넣어요. 끝나면 이 화면이 <b>연결됨</b>으로 바뀌어요.</li>;
  if (browser === 'android') return <ol className="remote-steps">
    <li>확장 파일을 받아요. 압축은 풀지 않아도 돼요. {download}</li>
    <li>브라우저 메뉴에서 <b>확장 프로그램</b>을 열고 <b>개발자 모드</b>를 켜요.</li>
    <li><b>+ (from .zip/.crx/.user.js)</b>를 누르고 받은 ZIP 파일을 골라요.</li>
    {connect}
  </ol>;
  if (browser === 'firefox') return <ol className="remote-steps">
    <li>확장 파일을 받아 압축을 풀어요. {download}</li>
    <li>주소창에 <code>about:debugging#/runtime/this-firefox</code>를 열어요. <CopyButton text="about:debugging#/runtime/this-firefox" /></li>
    <li><b>임시 부가 기능 로드</b>를 누르고 압축을 푼 폴더의 <code>manifest.json</code>을 골라요.</li>
    {connect}
  </ol>;
  return <ol className="remote-steps">
    <li>확장 파일을 받아 압축을 풀어요. {download}</li>
    <li>주소창에 <code>chrome://extensions</code>를 열고 오른쪽 위 <b>개발자 모드</b>를 켜요. Edge는 <code>edge://extensions</code>예요. <CopyButton text="chrome://extensions" /></li>
    <li><b>압축해제된 확장 프로그램을 로드</b>를 누르고 압축을 푼 폴더를 골라요. 사이트 접근 권한 안내가 나오면 허용해요.</li>
    {connect}
  </ol>;
}

export function ConnectorPage() {
  const status = useConnectorStatus(true);
  const [browser, setBrowser] = useState<Browser>(defaultBrowser);
  const origin = location.origin;
  const connected = !!status?.installed && status.hostPermission !== false;
  return <div className="page-pad narrow settings-page remote-page">
    <header className="page-head page-head-row"><h1>연결 확장</h1><div className="page-head-actions"><ButtonLink to="/settings">설정</ButtonLink></div></header>
    <p className="remote-lead">브라우저에 설치하면 영상 소스 조회와 재생을 내 브라우저로 연결해요. 서버에서 막히는 소스가 줄어들고, 한 번 설치하면 자동으로 적용돼요. 선택 사항이에요.</p>

    {mobile && !connected && <div className="remote-note" style={{ marginBottom: 20 }}><b>확장을 지원하는 브라우저가 필요해요</b><p>휴대폰 기본 Chrome·Safari는 확장을 설치할 수 없어요. Kiwi처럼 확장을 지원하는 Android 브라우저라면 아래 <b>모바일</b> 안내대로 설치할 수 있어요. 확장 없이도 앱은 그대로 쓸 수 있어요.</p></div>}
    <>
      <StatusCard status={status} />

      <section className="settings-group">
        <h2>{connected ? '다른 브라우저에 설치' : '설치하기'}</h2>
        <div className="remote-modes" role="radiogroup" aria-label="브라우저">
          {([['chromium', 'Chrome · Edge', 'PC Chromium 계열 브라우저'], ['android', '모바일 (Kiwi 등)', '확장을 지원하는 Android 브라우저'], ['firefox', 'Firefox', 'PC 임시 설치 · 다시 켜면 다시 로드']] as const).map(([value, title, via]) =>
            <button key={value} type="button" role="radio" aria-checked={browser === value} className={cx('remote-mode', browser === value && 'is-selected')} onClick={() => setBrowser(value)}>
              <span className="remote-mode-head"><b>{title}</b>{value === defaultBrowser && <em>이 브라우저</em>}</span>
              <small className="remote-mode-via">{via}</small>
            </button>)}
        </div>
        <div className="remote-form">
          <Steps browser={browser} />
          <div className="remote-url">
            <small>이 앱 주소</small>
            <span className="remote-url-text">{origin.replace(/^https?:\/\//, '')}</span>
            <div className="remote-url-actions"><CopyButton text={origin} label="주소 복사" /></div>
            <p>주소를 바꾸려면 확장 아이콘을 누르고 <b>주소 변경</b>을 눌러요. 확장을 다시 설치할 필요는 없어요.</p>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>알아 두기</h2>
        <div className="remote-note"><p><Info size={14} /> 확장은 위 앱 주소에서 온 요청만 처리해요. 다른 웹사이트는 확장을 쓸 수 없어요.</p>
          <p>로그인 쿠키는 기본으로 보내지 않아요. 로그인이 필요한 소스는 그 사이트를 연 채로 확장 아이콘을 눌러 <b>로그인 쿠키 사용</b>을 켜 주세요.</p>
          <p>영상은 원본에서 직접 받아요. 원본 사이트의 차단, WebView나 변환이 필요한 소스까지 풀리지는 않아요.</p></div>
      </section>
    </>
  </div>;
}
