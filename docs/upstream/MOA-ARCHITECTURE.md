# 구조

MOA는 로컬 미디어와 사용자가 설치한 확장을 하나의 카탈로그와 플레이어로 연결한다.

| 구성 | 역할 |
| --- | --- |
| `apps/web` | React UI, 기기별 설정, HLS/native 재생, ASS/VTT 자막, 리모컨 탐색 |
| `apps/server` | Fastify API, SQLite, 미디어 스캔, FFmpeg 세션, 메타데이터·이미지 캐시 |
| `packages/shared` | 클라이언트와 서버의 API 타입 |
| `packages/extensions` | Mangayomi 형식 JS 호환 실행, HTTP 제한·프록시 |
| `services/aniyomi-worker` | 선택 Aniyomi APK JVM 실행기와 Chromium 브리지 |
| `packages/subtitles-ko`, `packages/skip-markers` | 자막 검색·변환, 외부 마커 조회와 로컬 반복 구간 분석 |
| `deploy/auth`, `deploy/gateway` | 계정·세션 인증, 신뢰하는 계정 헤더를 앱에 전달 |

미디어는 읽기 전용 `/media` 아래에 마운트한다. 앱 DB, 설치한 확장, 자막, 번역과 캐시는 `/data`에 저장한다. 인증 DB와 APK worker 데이터는 별도 저장소다. 시청 기록·설정은 프로필 단위이고 카탈로그·메타데이터 캐시는 공유한다.

로컬 재생은 브라우저 capability에 따라 직접 재생, remux 또는 transcode를 선택한다. 원격 재생은 서버가 발급한 세션 URL로 중계한다. 임의 외부 URL을 받는 공개 프록시를 제공하지 않는다. 세션 자산 URL은 접근 토큰이므로 공개하지 않는다.

확장은 신뢰 경계 밖의 실행 코드다. JS에는 프로세스/QuickJS 격리와 네트워크 제한이 있고 APK에는 별도 컨테이너·자원 제한이 있다. APK가 일반 JVM 코드를 실행한다는 점은 변하지 않는다. 전체 Android 앱이나 모든 확장 ABI의 호환성을 보장하지 않는다.

TMDB, AniList, AniSkip, Anissia, Jimaku와 선택 Gemini 번역은 외부 API를 사용할 수 있다. 요청한 제목·식별자·자막이 외부로 전송될 수 있다. [자막과 스킵](SUBTITLES-AND-SKIP.md), [확장](EXTENSIONS.md), [보안](../SECURITY.md)을 참고한다.
