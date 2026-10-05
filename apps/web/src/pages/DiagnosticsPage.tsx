import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ButtonLink, EmptyState, Skeleton } from '../components/ui';

type Metric = { id: string; label: string; used: number | null; limit: number; unit: 'bytes' | 'count' | 'hours' | 'gb-hours' };
type Report = {
  limitsCheckedAt: string;
  vercel: { dashboard: string; metrics: Metric[] };
  upstash: { status: string; checkedAt: string | null; dashboard: string; metrics: Metric[] };
  byedpi: { enabled: boolean; strategy: string };
  runtime: { startedAt: string; sampledAt: string; cpuMs: number; rssBytes: number; active: number;
    routes: Record<string, { requests: number; errors: number; responseBytes: number; totalMs: number; maxMs: number }>;
    recent: { at: string; route: string; status: number }[] };
};
const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
function format(value: number, unit: Metric['unit']) {
  if (unit === 'bytes') return value >= 1e9 ? `${number(value / 1e9)} GB` : value >= 1e6 ? `${number(value / 1e6)} MB` : `${number(value / 1000)} KB`;
  return `${number(value)} ${unit === 'hours' ? '시간' : unit === 'gb-hours' ? 'GB-hours' : '회'}`;
}
function QuotaRows({ metrics }: { metrics: Metric[] }) {
  return <div className="settings-card">{metrics.map(metric => {
    const ratio = metric.used === null ? null : metric.used / metric.limit;
    return <div className="setting" key={metric.id}><div><b>{metric.label}</b><small>무료 한도 {format(metric.limit, metric.unit)}{metric.id === 'storage' ? '' : ' / 월'}</small>
      {metric.used !== null && <small>남은 양 {format(Math.max(0, metric.limit - metric.used), metric.unit)}</small>}
    </div><span className={ratio !== null && ratio >= 0.8 ? 'settings-error' : 'setting-value'}>{ratio === null ? '사용량 확인 필요' : `${format(metric.used!, metric.unit)} · ${number(ratio * 100)}%${ratio >= 1 ? ' · 한도 도달' : ratio >= 0.8 ? ' · 주의' : ''}`}</span></div>;
  })}</div>;
}
const routeNames: Record<string, string> = { http: '소스 조회', image: '표지', images: '표지 URL 발급', sync: '동기화', tmdb: 'TMDB', translate: '번역', subtitles: '자막 검색', auth: '인증', config: '설정', health: '상태 확인', diagnostics: '진단', other: '기타' };
export function DiagnosticsPage() {
  // Global app invalidation must not poll management APIs just because this page is open.
  const query = useQuery({ queryKey: ['lite-diagnostics'], queryFn: () => api<Report>('/lite/diagnostics'), enabled: false, retry: false, refetchOnWindowFocus: false, gcTime: 0 });
  const { refetch } = query;
  useEffect(() => { void refetch(); }, [refetch]);
  const report = query.data;
  return <div className="page-pad narrow settings-page">
    <header className="page-head page-head-row"><h1>진단 · 할당량</h1><div className="page-head-actions"><ButtonLink to="/settings">설정</ButtonLink><Button icon={<RefreshCw size={18} />} disabled={query.isFetching} onClick={() => void refetch()}>{query.isFetching ? '확인 중…' : '새로고침'}</Button></div></header>
    <p className="settings-hint">관리자 전용입니다. 자동으로 반복 조회하지 않으며, 실제 한도 초과 여부는 서비스의 공식 사용량 화면이 기준입니다.</p>
    {query.isError && <EmptyState title="진단 정보를 불러오지 못했습니다" body="로그인 상태와 서버 연결을 확인한 뒤 다시 시도해 주세요." action={<Button onClick={() => void refetch()}>다시 시도</Button>} />}
    {!report && query.isFetching && <Skeleton className="settings-sk" />}
    {report && <>
      <p className="settings-hint">마지막 진단 조회: {new Date(report.runtime.sampledAt).toLocaleString('ko-KR')}</p>
      <section className="settings-group"><div className="page-head-row"><h2>Vercel Hobby</h2><a className="btn btn-secondary btn-m" href={report.vercel.dashboard} target="_blank" rel="noreferrer">Vercel Usage 열기</a></div>
        <p className="settings-hint">월 사용량은 이 앱에서 자동으로 확인하지 않습니다. 공식 Usage 화면에서 팀 전체의 CPU·메모리·전송량을 확인하세요.</p>
        <QuotaRows metrics={report.vercel.metrics} />
      </section>
      <section className="settings-group"><div className="page-head-row"><h2>Upstash Redis Free</h2><a className="btn btn-secondary btn-m" href={report.upstash.dashboard} target="_blank" rel="noreferrer">Upstash 콘솔 열기</a></div>
        <p className="settings-hint">{report.upstash.status === 'not-configured' ? '관리 API 연결 전입니다. 배포 환경변수에 UPSTASH_MANAGEMENT_EMAIL, UPSTASH_MANAGEMENT_API_KEY, UPSTASH_DATABASE_ID를 설정하면 실제 사용량을 읽습니다.' : report.upstash.status === 'unavailable' ? '관리 API를 읽지 못했습니다. 권한·연결 상태를 확인하세요. 사용량을 0으로 간주하지 않습니다.' : report.upstash.status === 'partial' ? '일부 항목이 제공되지 않아 확인이 필요합니다.' : '관리 API가 제공한 데이터베이스 전체 사용량입니다.'} 최대 5분간 조회 결과를 재사용합니다.</p>
        {report.upstash.checkedAt && <p className="settings-hint">조회 시각 {new Date(report.upstash.checkedAt).toLocaleString('ko-KR')} · 서비스 집계가 늦게 반영될 수 있습니다.</p>}
        <p className="settings-hint">Upstash에서 직접 만든 계정의 관리 API를 지원합니다. Vercel 연동으로 만든 계정은 공식 콘솔에서 확인하세요.</p>
        <QuotaRows metrics={report.upstash.metrics} />
      </section>
      <section className="settings-group"><h2>CPU 시간을 읽는 방법</h2><div className="settings-card">
        <div className="setting"><div><b>시청 시간이 아닌 서버 연산 시간</b><small>확장 실행과 영상 재생은 주로 사용자 기기에서 처리합니다. 서버가 원본·Redis·번역 응답을 기다리는 시간은 CPU 시간과 다르지만 메모리 할당 시간에는 영향을 줍니다.</small></div></div>
        <div className="setting"><div><b>사용량 예시</b><small>가정: 요청당 CPU 100ms라면 월 10만 요청은 약 2.78시간입니다. 실제 요청당 CPU는 작업마다 달라지며, 이 예시는 무료 사용을 보장하는 측정치가 아닙니다.</small></div></div>
      </div></section>
      <section className="settings-group"><h2>현재 서버 인스턴스 · 참고 측정</h2>
        <p className="settings-hint">{new Date(report.runtime.startedAt).toLocaleString('ko-KR')}부터 관측했습니다. 서버 재시작 시 초기화되고 새로고침이 다른 인스턴스로 연결될 수 있습니다. 월 누적 사용량이 아니며, Node CPU에는 ByeDPI 자식 프로세스와 플랫폼 오버헤드가 포함되지 않습니다.</p>
        <div className="settings-card">
          <div className="setting"><div><b>Node CPU 누적</b><small>동시에 처리한 요청의 CPU를 중복 합산하지 않습니다.</small></div><span>{number(report.runtime.cpuMs / 1000)}초</span></div>
          <div className="setting"><div><b>현재 프로세스 메모리</b><small>RSS 관측값입니다. Vercel에서 할당한 2GB나 월 GB-hours와 다릅니다.</small></div><span>{format(report.runtime.rssBytes, 'bytes')}</span></div>
          <div className="setting"><div><b>ByeDPI</b><small>소스 목록·표지·영상 링크 조회에 사용합니다.</small></div><span>{report.byedpi.enabled ? `켜짐 · ${report.byedpi.strategy}` : '꺼짐'}</span></div>
          {Object.entries(report.runtime.routes).map(([route, value]) => <div className="setting" key={route}><div><b>{routeNames[route] ?? route}</b><small>{number(value.requests)}회 · 오류 {number(value.errors)}회 · 응답 본문 {format(value.responseBytes, 'bytes')}</small><small>평균 응답 {number(value.totalMs / Math.max(1, value.requests))}ms · 최대 {number(value.maxMs)}ms (대기 포함)</small></div></div>)}
        </div>
        <p className="settings-hint">응답 본문 크기는 요청 헤더·CDN 압축·정적 파일을 제외한 참고값입니다. 진단을 위한 Redis 저장은 추가하지 않았습니다.</p>
      </section>
      <section className="settings-group"><h2>최근 오류</h2><div className="settings-card">{report.runtime.recent.length ? report.runtime.recent.map((error, index) => <div className="setting" key={index}><div><b>{routeNames[error.route] ?? error.route} · HTTP {error.status}</b><small>{new Date(error.at).toLocaleString('ko-KR')}</small></div></div>) : <div className="setting"><div><b>관측된 오류가 없습니다</b><small>현재 인스턴스에서 기록한 최근 최대 20건입니다. URL·쿠키·API 키·요청 본문은 기록하지 않습니다.</small></div></div>}</div></section>
      <p className="settings-hint">무료 한도 확인 기준: {report.limitsCheckedAt}. 요금제와 공식 콘솔의 값을 우선하세요.</p>
    </>}
  </div>;
}
