# moa-lite 배포·업데이트 안내

moa-lite는 Vite 정적 파일과 `api/index.ts` 단일 Node.js 24 함수로 이루어져 Vercel Hobby에 배포합니다. 계정과 시청 기록은 Upstash Redis Free에 저장합니다. 루트의 Docker Compose 파일과 `docs/`의 다른 문서는 MOA 원본 이력의 자료이며 moa-lite 배포에는 쓰지 않습니다.

> 처음 배포한다면 **[배포 가이드](https://sidetool.github.io/moa-lite/)**를 따라 하는 것이 가장 쉽습니다. 이 문서는 가이드의 각 단계와 직접 설정·업데이트·운영 방법을 자세히 설명합니다.

## 원클릭 배포

1. [배포 가이드](https://sidetool.github.io/moa-lite/)에서 **두 값 만들기**로 `SETUP_CODE`와 `APP_SECRET`을 만들고 **파일로 보관**합니다. 값은 브라우저 안에서만 만들어집니다.
2. **Vercel 배포 시작**(또는 README의 **Deploy** 버튼)을 누르고 GitHub로 로그인한 뒤 저장소 이름을 정합니다.
3. **Upstash** 저장 공간을 **Free** 요금제로 만듭니다. 지역은 서울이 없으면 도쿄를 고릅니다. Vercel이 `KV_REST_API_URL`·`KV_REST_API_TOKEN`을 자동으로 넣어 줍니다.
4. `APP_SECRET`과 `SETUP_CODE`를 붙여 넣고, 미리 채워진 `ENABLE_EXPERIMENTAL_COREPACK=1`은 그대로 둔 채 **Deploy**를 누릅니다.
5. 배포가 끝나면 [처음 설정](#처음-설정)으로 넘어갑니다.

이미 Upstash 저장 공간을 만든 적 있는 계정에서는 요금제 목록에 Free 없이 **Pay as you go**나 **Fixed**만 보일 수 있습니다. Pay as you go는 Free의 무료 사용량이 따로 남지 않고 처음부터 사용량만큼 요금이 붙으니 고르지 말고, 창을 닫은 뒤 아래 Fork 방식으로 배포하세요.

원클릭 배포는 원본을 Fork가 아닌 **복사본**으로 만듭니다. 처음에는 간편하지만 GitHub의 Sync fork 버튼이 없어 [업데이트](#새-버전-받기)할 때 명령어로 병합해야 합니다.

## Fork로 배포하기

Free 요금제가 보이지 않을 때, 또는 업데이트를 버튼 하나로 받고 싶을 때 씁니다.

| 단계 | 할 일 | 입력·복사하는 값 |
| --- | --- | --- |
| A 저장 공간 | [Upstash 콘솔](https://console.upstash.com/redis)에서 **Create Database**를 누르고 요금제를 **Free**로 만듭니다. 지역은 서울이 없으면 도쿄를 고릅니다. **REST API** 항목에서 주소와 토큰을 복사합니다. | `UPSTASH_REDIS_REST_URL`(`https://`로 시작)<br>`UPSTASH_REDIS_REST_TOKEN` |
| B Fork | [moa-lite Fork하기](https://github.com/sidetool/moa-lite/fork)에서 **Create fork**를 누릅니다. | — |
| C 배포 | [Vercel](https://vercel.com/new)에서 B의 저장소를 **Import**하고, **Application Preset**을 **Other**로 바꿉니다. **Environment Variables**에 다섯 값을 넣은 뒤 **Deploy**를 누릅니다. Root Directory와 빌드 설정은 그대로 둡니다. | `APP_SECRET`, `SETUP_CODE`<br>`ENABLE_EXPERIMENTAL_COREPACK=1`<br>A의 주소와 토큰 |

Vercel이 저장소 안의 `apps/server`·`apps/web`·Dockerfile을 감지해 프리셋을 **Services**로 고르고 “Multiple applications detected”, “needs a vercel.json”을 표시할 수 있습니다. moa-lite는 루트 `vercel.json` 하나로 배포하므로 **Other**로 바꾸고, 목록의 **Import single project**는 누르지 않습니다.

배포 가이드의 **환경변수 한꺼번에 복사**를 누르면 다섯 값을 Vercel의 첫 **Key** 칸에 한 번에 붙여 넣을 수 있습니다.

## 환경변수

가이드를 쓰지 않고 직접 값을 만들 때는 각각 아래 명령으로 생성합니다.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-'))"
```

| 환경변수 | 필수 | 내용 |
| --- | --- | --- |
| `APP_SECRET` | 필수 | 32자 이상의 난수. 로그인 서명과 저장된 TMDB·Gemini 키 암호화에 씁니다. **배포 후 바꾸지 마세요.** |
| `SETUP_CODE` | 필수 | `AB12-CD34-EF56-7890`처럼 영문·숫자 4자리씩 네 묶음. 관리자 계정이 없을 때만 씁니다. 예시 값을 그대로 쓰지 마세요. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 필수 | Upstash REST 주소와 토큰. Vercel 저장 공간 연결이 넣어 주는 `KV_REST_API_URL` / `KV_REST_API_TOKEN`도 읽습니다. |
| `ENABLE_EXPERIMENTAL_COREPACK` | 권장 | `1`. Vercel이 `package.json`의 pnpm 10.12.1을 쓰게 합니다. [안내](https://vercel.com/docs/package-managers) |
| `APP_URL` | 선택 | 앱 origin(경로·끝 슬래시 없음). 비우면 Vercel의 Production 주소를 씁니다. 개인 도메인을 연결했다면 넣습니다. |
| `AUTH_NAMESPACE` | 선택 | Redis 키 접두사. 기본 `moa-lite`. 같은 Redis를 여러 배포가 나눠 쓸 때만 바꿉니다. |
| `CONNECTOR_READER_ORIGINS` | 선택 | 연결 확장이 허용할 앱 origin 목록(쉼표 구분). 빌드할 때 반영됩니다. |
| `BYEDPI_ENABLED` / `BYEDPI_STRATEGY` | 선택 | 기본 `1` / `tlsrec`. [내장 ByeDPI](#내장-byedpi-기본-켜짐) 참고 |
| `UPSTASH_MANAGEMENT_*`, `UPSTASH_DATABASE_ID` | 선택 | 진단 메뉴의 실제 Upstash 사용량 조회. [진단 메뉴](#진단-메뉴와-실제-할당량-확인) 참고 |

`vercel.json`에 설치·빌드·함수·라우팅 설정이 들어 있으므로 Vercel의 Application/Framework Preset은 **Other**로 두고(Services로 자동 선택되면 바꿉니다) 빌드 설정은 그대로 둡니다. 함수 지역은 서울(`icn1`), 최대 실행 시간은 120초, Fluid compute를 씁니다.

환경변수를 바꾼 뒤에는 **Redeploy**해야 적용됩니다. 비밀값에 `VITE_` 접두사를 붙이지 마세요(브라우저에 노출됩니다). Preview 배포에 운영 Redis를 연결하면 운영 계정을 함께 쓰므로 별도 Redis나 다른 `AUTH_NAMESPACE`·`APP_SECRET`·`SETUP_CODE`를 씁니다.

## 처음 설정

1. 배포된 주소를 엽니다. **관리자 계정 만들기** 화면이 나오지 않으면 주소 뒤에 `/__moa/setup`을 붙입니다.
2. `SETUP_CODE`와 원하는 아이디·비밀번호를 입력합니다.
3. 프로필을 만들고 **영상 소스**에서 Mangayomi JS 저장소를 추가·설치합니다. 기본 저장소는 비어 있습니다.
4. 작품 정보와 자막 번역을 쓰려면 **설정**에서 TMDB·Gemini 키를 넣습니다. 키는 `APP_SECRET`으로 암호화해 Redis에 저장하고 브라우저에는 원문을 내려주지 않습니다. Gemini 호출 비용과 한도는 입력한 키의 계정에 적용됩니다. 번역은 앱이 열려 있는 동안 브라우저가 진행하고, 다시 열면 그 기기의 체크포인트부터 이어갑니다.
5. 다른 사람은 **계정과 초대**에서 초대합니다.

### 앱이 열리지 않을 때

`https://내-앱/api/health`를 엽니다. `"ok": true`면 구성은 정상입니다. 필수 값이 빠졌거나 형식이 틀리면 503 응답의 `missing`에 이름이 나옵니다. 이 엔드포인트는 구성만 확인하며 Redis 실제 연결은 처음 설정·로그인 요청에서 확인됩니다. 값을 고친 뒤에는 Redeploy합니다.

설정 코드를 잃어버렸다면 Vercel **Settings → Environment Variables**에서 `SETUP_CODE`를 확인합니다.

## 새 버전 받기

업데이트는 **내 저장소에 최신 코드 가져오기 → 그 코드가 운영 배포됐는지 확인 → 브라우저 새로고침** 순서입니다. Vercel의 **Redeploy**만 누르면 선택한 기존 배포의 코드를 다시 빌드할 뿐 원본의 새 커밋을 가져오지 않습니다.

`APP_SECRET`, `AUTH_NAMESPACE`, Upstash 데이터베이스를 그대로 두면 계정과 기록이 이어집니다.

### 1. 내 저장소의 main 업데이트

- **Fork로 배포했다면**: 내 GitHub 저장소에서 브랜치를 **main**으로 선택하고 **Sync fork → Update branch**를 누릅니다.
- **원클릭으로 만든 복사본이라면**: Sync fork가 없습니다. 아래 명령으로 원본 변경을 병합합니다. 처음에는 커밋 이력이 달라 `--allow-unrelated-histories`가 필요하고, 같은 파일을 양쪽에서 추가한 것으로 처리되어 충돌할 수 있습니다.

```sh
git clone --branch main https://github.com/내-계정/내-저장소.git
cd 내-저장소
git remote add upstream https://github.com/sidetool/moa-lite.git
git fetch upstream
git merge --no-edit --allow-unrelated-histories upstream/main
```

`git status`로 병합 결과를 확인한 뒤 `git push origin main`을 실행합니다. 충돌이 있으면 파일을 고치고 `git add`와 `git commit`으로 병합을 마칩니다. 취소하려면 `git merge --abort`를 씁니다. 이미 upstream을 등록한 폴더에서는 `git fetch upstream`부터 실행합니다.

### 2. 운영 배포 확인

Vercel에 연결된 저장소와 **Production Branch**가 방금 업데이트한 `main`인지 확인합니다. 새 배포의 **소스 브랜치·커밋**, **Ready**, **Production** 여부를 확인합니다. Preview로만 배포됐다면 운영 주소에는 적용되지 않습니다.

#### Deployment Blocked: 커밋 작성자 권한으로 막힌 경우

배포 상세에 `The deployment was blocked because the commit author did not have contributing access`가 보이면, Vercel Hobby의 비공개 저장소에서 커밋 작성자가 프로젝트 소유 계정과 연결되지 않은 경우입니다. 원본 코드를 가져와도 작성자는 원본 개발자로 남습니다. [Vercel 공식 안내](https://vercel.com/docs/deployments/troubleshoot-project-collaboration)

1. **Vercel에 연결한 본인 GitHub 계정**으로 내 저장소의 **main → README.md → 연필(Edit)**을 엽니다.
2. 맨 아래에 `<!-- deployment check -->`를 추가합니다. 이미 있으면 주석 안에 날짜 등을 붙여 바꿉니다. README 화면에는 보이지 않습니다.
3. **main에 직접 커밋**합니다.
4. Vercel **Deployments**에서 방금 만든 커밋의 **새 배포**가 **Ready · Production**인지 확인합니다. 막힌 배포의 Redeploy를 누르지 마세요.

같은 오류가 계속되면 Vercel **Account Settings → Login Connections**에 커밋한 GitHub 계정이 연결됐는지 확인합니다.

### 3. 앱에 적용

앱을 새로고침합니다. 연결 확장을 쓰고 있고 앱 주소나 확장 코드가 바뀌었다면 새 ZIP을 받아 다시 로드합니다.

### 되돌리기와 백업

문제가 있는 업데이트는 Vercel **Deployments**에서 이전 배포를 **Promote to Production**으로 되돌릴 수 있습니다. 단, Redis 문서 형식이 바뀐 업데이트 뒤에는 그 형식을 읽지 못하는 버전으로 바로 되돌리면 안 됩니다(아래 [사용량과 저장 범위](#사용량과-저장-범위) 참고). Redis 데이터는 Upstash 콘솔에서 따로 백업합니다.

`APP_SECRET`을 바꾸면 저장한 TMDB·Gemini 키를 복호화할 수 없으므로 바꾼 뒤 키를 다시 입력합니다. 개인 도메인은 Vercel **Settings → Domains**에서 연결하고, 연결 확장을 쓴다면 `APP_URL`도 넣어 다시 배포한 뒤 확장을 다시 설치합니다.

브라우저 사이트 데이터를 지우면 그 기기의 카탈로그·자막·번역 캐시와 아직 전송되지 않은 변경이 사라집니다. 서버로 전송된 시청 기록·프로필·작품 참조는 다시 로그인하면 돌아옵니다. 기기를 바꾸거나 로그아웃하기 전에는 네트워크 연결을 확인합니다.

## 내장 ByeDPI (기본 켜짐)

연결 확장 없이 소스 목록·검색·상세·영상 링크 추출과 표지는 Vercel 조회 중계에서 내장 ByeDPI를 거칩니다. 기기에 별도 설치할 필요가 없습니다. 공식 v0.17.3 Linux x64 정적 실행 파일과 MIT 라이선스를 함수에 포함하며 빌드에서 SHA-256을 검사합니다. 요청마다 루프백 SOCKS 프록시를 실행하고 성공·실패·취소 시 종료합니다. 서버 DNS 검증, 사설 IP 차단, 원본 TLS 인증서 검증과 조회 크기 제한은 유지합니다.

환경변수를 생략해도 활성화됩니다. `BYEDPI_ENABLED=0`이면 기존 직접 서버 조회를 사용합니다. 기본 `BYEDPI_STRATEGY=tlsrec`는 TLS SNI 레코드를 분할하며, 필요하면 `disorder`로 패킷 재배열과 TLS 레코드 분할 자동 재시도를 사용할 수 있습니다. 변경 후 재배포합니다. 실행 파일 시작에 실패하면 조회 오류를 반환하며 조용히 직접 연결로 바꾸지 않습니다. 로컬 개발은 Linux x64에서 지원하고 다른 플랫폼에서는 `BYEDPI_ENABLED=0`을 사용합니다.

ByeDPI가 바꾸는 것은 **Vercel에서 원본 사이트로 보내는 조회 연결**입니다. 영상·HLS 세그먼트는 계속 브라우저에서 원본으로 직접 받습니다. 사용자 기기의 차단, 원본 CORS·Referer 정책, 사이트의 데이터센터 IP 차단·로그인·CAPTCHA까지 해결하지는 않습니다. 차단 방식과 배포망에 따라 효과가 달라지므로 실제 소스로 확인해야 합니다. [ByeDPI 공식 문서](https://github.com/hufrea/byedpi)

## PC 연결 확장 (선택 사항)

앱의 **설정 → 이 기기 → 연결 확장**(`/settings/connector`)에서 설치 상태를 보고, ZIP을 받고, 브라우저별 설치 순서를 따라 할 수 있습니다. 설치가 끝나면 이 화면이 새로고침 없이 **연결됨**으로 바뀝니다. 모든 배포에서 동일한 ZIP을 쓰며 다음 주소에서도 받을 수 있습니다.

- Chromium: `/install/moa-lite-connector-chromium.zip`
- Firefox: `/install/moa-lite-connector-firefox.zip`

Chrome·Edge에서는 ZIP을 풀고 `chrome://extensions` 또는 `edge://extensions`에서 개발자 모드를 켠 뒤 **압축해제된 확장 프로그램을 로드**하여 해당 폴더를 선택합니다. Firefox에서는 `about:debugging`의 임시 부가 기능 로드로 `manifest.json`을 선택할 수 있습니다. Firefox 임시 설치는 브라우저 재시작 후 다시 로드해야 합니다. Kiwi처럼 확장을 지원하는 Android Chromium 브라우저에서는 확장 메뉴의 개발자 모드에서 **+ (from .zip/.crx/.user.js)**로 Chromium ZIP을 압축을 풀지 않고 설치할 수 있습니다(브라우저별 확장 API 지원 차이로 동작은 보장하지 않습니다). 서명된 스토어 패키지는 포함하지 않습니다.

설치 직후 확장의 설정 탭이 열리고, 열려 있는 탭 중 최근에 쓴 앱 주소가 맨 위에 나옵니다. **이 주소로 연결**을 누르거나 앱 주소를 직접 입력해 저장하세요. 앱 탭에서 확장 팝업을 열어 **이 탭 주소로 연결**해도 됩니다. 주소는 경로·끝 슬래시 없는 HTTPS origin이며 로컬 개발 주소만 HTTP를 허용합니다. 이미 열린 앱 탭에도 새로고침 없이 연결합니다. 팝업의 **주소 변경**으로 다른 배포에 연결할 수 있습니다.

HTTPS 사이트 접근 권한은 설치 시 부여하며 사이트마다 허용할 필요가 없습니다. Firefox 등에서 권한을 취소했다면 **권한 허용**으로 복원하세요. 쿠키는 기본적으로 전송하지 않습니다. 원본 사이트 탭에서 **이 사이트에 로그인 쿠키 사용**을 켠 사이트만 쿠키를 사용하며, 목록의 **원본 로그인 탭**에서 인증할 수 있습니다. 삭제하면 쿠키 사용과 해당 로그인 탭 연결이 해제됩니다.

Firefox는 MV3 백그라운드 스크립트를 사용합니다. 동적 등록이 불가능한 환경에서는 탭 로드 시 주입하므로 document_start 시점은 보장하지 않습니다.

확장이 있고 사이트 권한이 있으면 조회를 브라우저에서 보냅니다. 권한이 없으면 제한된 Vercel 조회 중계로 시도합니다. 재생 시 해당 앱 탭과 미디어 호스트에만 임시 헤더/CORS 규칙을 추가합니다. 재생 종료·로그아웃·탭 연결 종료 시 정리하며 백그라운드 재시작 때 남은 규칙도 제거합니다.

영상과 HLS 세그먼트는 원본에서 직접 받습니다. 연결 확장을 설치할 수 없는 모바일에서는 원본의 CORS·Referer 제한과 브라우저 코덱 지원이 적용됩니다. WebView 실행·EDL·FFmpeg 변환이 필요한 소스는 지원하지 않습니다.

## 사용량과 저장 범위

2026-10-05 공식 문서 기준입니다. **무료 배포가 가능한 구성과 사용량 무제한은 다릅니다.** 한도는 프로젝트별로 새로 생기는 용량이 아니라 해당 팀/데이터베이스의 다른 사용량과 함께 확인해야 합니다. Hobby는 개인·비상업 용도입니다.

| 항목 | 무료 한도 | moa-lite에서 주로 소비하는 경로 |
| --- | --- | --- |
| Vercel Fast Origin Transfer | 월 10GB | 표지, 소스 HTML/JSON, 동기화, 번역의 함수 요청·응답 |
| Vercel Fast Data Transfer | 월 100GB | 위 응답과 앱·Worker·WASM 정적 파일 |
| Vercel CDN 요청 / 함수 호출 | 각각 월 100만 | 정적 파일 포함 CDN 요청 / API 함수 호출 |
| Vercel Active CPU | 월 4시간 | 인증, JSON·압축, 자막 변환, ByeDPI |
| Vercel Provisioned Memory | 월 360GB-hours | 원본·Redis·번역 응답을 기다리는 시간도 포함 |
| Upstash Redis Free | 256MB, 월 50만 명령·10GB 전송 | 인증, 동기화, 소스 공통 설정, 호출 제한 |

출처: [Vercel CDN](https://vercel.com/docs/manage-cdn-usage), [Fluid compute](https://vercel.com/docs/functions/usage-and-pricing), [Upstash](https://upstash.com/pricing/redis). 현재 함수는 Fluid compute의 2GB 메모리를 사용하므로, 동시 요청이 없는 단순 모델에서 월 360GB-hours는 약 180시간의 처리 시간입니다. 대기 중에도 메모리는 집계되며 같은 인스턴스의 동시 요청은 시간을 공유합니다. 실제 사용량은 대시보드로 확인합니다. [메모리 문서](https://vercel.com/docs/functions/configuring-functions/memory)

가장 먼저 주의할 것은 **100GB 전체 전송량보다 작은 10GB Origin Transfer**입니다. 예를 들어 브라우저 캐시에 없는 표지 500장을 매일 150KB씩 받으면 30일에 약 2.25GB이며, 같은 사용자가 5명이면 표지만 약 11.25GB입니다. 이 계산은 설명용 가정이며 HTML·검색·자막·요청 헤더·정적 파일은 제외했습니다. 일반 조회 JSON의 base64는 압축 전 본문을 약 4/3로 늘립니다. 이미지는 바이너리로 응답합니다. 실제 계측은 Vercel 집계가 기준입니다.

사용량을 줄이기 위해 적용한 방식:

- 동기화의 공통 소스 조회와 기록 전송을 단일 API로 합쳤습니다. 변경되지 않은 확장 코드/설정은 재전송하지 않습니다. 변경 없는 1시간 활성 탭은 동기화 부분만 약 120회에서 60회가 됩니다(초기화·사용자 변경 제외).
- IndexedDB의 마지막 동기화 시각을 계정 잠금 안에서 확인하여 여러 탭이 같은 빈 동기화를 반복하지 않습니다. 실패 시 30초부터 최대 5분까지 자동 재시도 간격을 늘리고 오프라인에서는 자동 요청을 생략합니다. 수동 동기화·로그아웃과 로컬 변경 대기열은 유지합니다.
- Redis 문서는 4KB 이상이면 gzip 압축을 시도하고 더 작을 때만 저장합니다. 이전 비압축 문서도 읽습니다. 함수 인스턴스에 있는 문서와 Redis의 실제 값이 같으면 내용 대신 작은 응답만 받습니다. 인증 문서·세션 인덱스는 인스턴스에서 최대 30초 재사용한 뒤 Redis 지문으로 재검증합니다. 같은 인스턴스의 로그아웃·세션·계정·초대 변경은 캐시를 즉시 무효화하며, 다른 인스턴스의 변경 반영은 최대 30초 지연될 수 있습니다. 캐시는 최대 64개·압축 전 JSON 기준 8MiB이며, 콜드 시작에서는 전체 압축 문서를 다시 읽습니다.
- 인증 SQL을 요청마다 다시 열지 않고 내용이 바뀔 때 세션 인덱스를 재생성합니다. 세션 만료 시간은 매 요청 검사합니다. 표지·소스 HTTP처럼 API 키가 필요 없는 요청은 secrets 문서를 읽지 않습니다.
- 표지 GET은 암호화 티켓의 무결성·만료와 세션 쿠키 존재만 검사하여 Redis 명령을 사용하지 않습니다. 세션 유효성·계정 일치는 다시 조회하지 않으며 티켓은 최대 1시간 유효합니다. URL·사설 IP·응답 크기 검사는 유지합니다.
- API 호출 제한(계정당 시간당 3,000회)과 관리자 진단 제한(분당 30회)은 인스턴스별 메모리에 적용합니다. 인스턴스 재시작 시 초기화되며 여러 인스턴스의 합산 제한은 아닙니다. 로그인·설정 등 인증 변경 제한은 Redis에서 전역으로 유지합니다.
- 계정 정보가 포함된 암호화 표지 URL을 기기에 보관해 새로고침·다른 탭에서도 기존 1시간 브라우저 이미지 캐시를 재사용합니다. 영속 목록은 256개·JSON 256K자 이하로 제한하며 로그아웃 시 제거합니다. 계정용 응답을 공개 CDN 캐시로 전환하지 않습니다.

남는 제약: 표지 신규 탐색량, 긴 번역·차단 소스 대기 시간, 다수 기기의 기록 쓰기는 계속 사용량을 소비합니다. ByeDPI는 조회 실패를 줄이는 용도이며 Vercel 할당량을 없애지 않습니다. Redis의 조건부 조회도 명령을 사용하고, Lua/CAS 재시도·인증 변경 호출 제한 검사도 사용량에 포함해 관찰해야 합니다. Gemini·TMDB·자막 사이트의 자체 제한은 별도입니다.

시청 기록의 계정별 3MiB·3,000행 한도는 아래와 같이 유지됩니다. 작품·회차 참조, 프로필, 설정과 삭제 tombstone도 행 수에 들어가므로 **3,000개 작품을 뜻하지 않습니다.** 장기간 사용 시 별도의 보관/정리 설계가 필요할 수 있습니다. 삭제 동기화가 깨지지 않도록 오래된 tombstone을 임의로 제거하지 않습니다.

배포 후 며칠간 Vercel의 Origin Transfer·CPU·Memory와 Upstash의 명령·전송량을 확인하고, `관측 사용량 / 관측 일수 × 30`으로 월 예상치를 계산합니다. 관측 기간에 탐색과 실제 자막 번역을 포함해야 합니다. Hobby 한도를 넘으면 기능이 제한될 수 있으며 무료로 계속 처리된다는 보장은 없습니다. [Hobby 한도 초과 안내](https://vercel.com/docs/plans/hobby)

Vercel 함수의 요청·응답 한도는 4.5MB입니다. 이 구현은 요청·JSON 응답을 4,000,000바이트 이하로 제한하고 일반 조회 본문은 최대 2MiB로 제한합니다. 영상·오디오·미디어 세그먼트는 중계에서 거부합니다. 번역은 함수 호출당 Gemini 요청 하나로 처리합니다. [공식 함수 제한](https://vercel.com/docs/functions/limitations)

Redis에는 인증·공통 설치 상태·관리자 기본 설정·계정별 행 revision·삭제 tombstone·최소 작품 참조를 저장합니다. 계정별 동기화 문서는 최대 3MiB·3,000행이며 배치당 100개 변경을 보냅니다. 전체 카탈로그·영상 URL·번역 캐시는 동기화하지 않습니다. 탭이 보이는 동안 60초 간격으로 확인하고 변경은 모아서 전송합니다.

압축 형식 추가 후에는 이 형식을 읽지 못하는 이전 코드로 즉시 되돌리면 안 됩니다. 롤백할 버전도 `compression: gzip` 읽기를 포함하거나, 먼저 문서 형식 변환 및 백업을 준비해야 합니다.

Upstash 콘솔의 명령 수·데이터·대역폭과 Vercel Usage를 확인합니다. 무료 요금제 한도 안에서 운영하는 구조입니다. Hobby의 개인 비상업 용도와 사용량 제한은 [공식 안내](https://vercel.com/docs/plans/hobby)를 따릅니다.

## 운영

### 진단 메뉴와 실제 할당량 확인

관리자 계정의 **설정 → 운영 → 진단 · 할당량**(`/settings/diagnostics`)에서 확인합니다. 기존 MOA 설정 카드·버튼·레이아웃을 재사용합니다. 일반 계정은 화면과 API 모두 접근할 수 없습니다.

- **Vercel**: 무료 한도와 공식 Usage 화면 링크를 제공합니다. 월 CPU·메모리·전송량을 자동 조회하는 연결은 구현하지 않았습니다. 사용량을 알 수 없으면 `사용량 확인 필요`로 표시하며 0%로 표시하지 않습니다. 팀의 다른 프로젝트 사용량도 공식 화면에서 함께 확인합니다.
- **Upstash**: 아래 관리 API 환경변수를 추가하면 실제 이번 달 요청·전송량과 현재 저장 용량을 읽습니다. 80%부터 주의, 100%부터 한도 도달을 표시합니다. 요청에 실패하거나 일부 값이 없으면 알 수 없음으로 남깁니다.
- **서버 진단**: 현재 요청을 받은 인스턴스에서 관측한 경로별 호출·오류·응답 본문 크기·평균/최대 응답 시간, Node CPU·RSS, ByeDPI 설정과 최근 오류 최대 20건을 표시합니다. 전체 배포/월 누적 집계가 아니며 재시작이나 다른 인스턴스 연결 시 값이 달라집니다. CPU는 프로세스 전체 누적값이라 동시 요청을 중복 합산하지 않지만 ByeDPI 자식 프로세스·플랫폼 작업은 제외합니다. 이를 Vercel 청구 CPU로 대체하면 안 됩니다.

| 선택 환경변수 | 값 |
| --- | --- |
| `UPSTASH_MANAGEMENT_EMAIL` | Upstash 계정 이메일 |
| `UPSTASH_MANAGEMENT_API_KEY` | 콘솔에서 발급한 Developer API 키. Redis REST 토큰과 다름 |
| `UPSTASH_DATABASE_ID` | 이 앱이 사용하는 Redis 데이터베이스 ID |

세 값은 서버에만 등록하고 `VITE_` 접두사를 붙이지 않습니다. 키를 설정한 뒤 재배포하면 적용됩니다. API 응답에는 키·이메일·원본 통계 문서가 포함되지 않습니다. [Upstash Developer API](https://upstash.com/docs/common/account/developerapi)는 Upstash에 직접 가입한 계정에 제공되며 Vercel 등 제3자 연동으로 만든 계정은 지원하지 않습니다. 그 경우 콘솔 링크로 확인합니다. 통계 필드는 [공식 데이터베이스 통계 API](https://upstash.com/docs/devops/developer-api/redis/get_database_stats)를 따릅니다.

진단 페이지는 열 때와 새로고침을 누를 때만 요청합니다. 일반 앱 데이터 무효화나 탭 포커스 변경으로 통계 API를 반복 호출하지 않습니다. 관리 API 결과는 성공·실패 모두 인스턴스별 최대 5분 동안 재사용하고, 진단용 Redis 쓰기나 상주 타이머를 추가하지 않습니다. 공식 콘솔의 집계 지연은 별도로 존재할 수 있습니다.

CPU 예시: 요청당 실제 CPU를 100ms라고 가정하면 10만 회는 약 2.78시간입니다. 영상 시청 시간이나 외부 서버 응답 대기 시간을 곧바로 CPU 시간으로 계산하지 않습니다. 반면 Vercel의 메모리 할당 시간은 외부 응답 대기에도 소비됩니다. 실제 판단은 [Fluid compute 사용량](https://vercel.com/docs/functions/usage-and-pricing)과 공식 Usage 화면을 기준으로 합니다.

원본의 자동 Docker 이미지 게시 workflow는 `docs/upstream/MOA-container-images.yml`에 보존했고, 이 저장소에는 빌드·테스트만 실행하는 `.github/workflows/lite.yml`을 적용했습니다.
