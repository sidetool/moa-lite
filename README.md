<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.png">
  <img src=".github/assets/logo-light.png" alt="MOA" width="200">
</picture>

### moa-lite — 서버 없이, Vercel 무료 요금제로 쓰는 MOA

[MOA](https://github.com/sidetool/moa)의 화면과 플레이어를 그대로 옮겨<br>
Docker 서버 없이 **Vercel Hobby + Upstash Redis Free**에서 5분 안에 배포하는 개인용 영상 앱입니다.

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-7b61ff)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![Vercel](https://img.shields.io/badge/vercel-hobby-000000?logo=vercel&logoColor=white)
![Upstash](https://img.shields.io/badge/upstash-redis_free-00e9a3?logo=upstash&logoColor=white)

**[배포 가이드](https://sidetool.github.io/moa-lite/)** · [시작하기](#시작하기) · [MOA와 다른 점](#moa와-다른-점) · [문서](#문서) · [면책](#면책-조항)

<br>

<img src=".github/assets/home.webp" alt="moa-lite 홈 화면 (MOA와 같은 화면)" width="100%">

</div>

<br>

도움이 됐다면 ⭐ **Star**로 응원해 주세요.

## 주요 기능

- **MOA와 같은 화면** — 홈, 통합 검색, 작품 상세, 작품 묶기, 시즌 전환, 프로필, 볼 목록, 이어 보기를 그대로 씁니다.
- **플레이어** — MP4·HLS 재생, 완료 회차 다음으로 이어보기, 자막 검색과 ASS 자막 표시, 자막 파일·압축파일 가져오기, 선택한 자막 기억, 지원 브라우저에서 자막·컨트롤이 포함된 PiP, 같은 회차의 소스 전환 시 자막·싱크 유지
- **작품 정보와 자막 번역** — TMDB 포스터·줄거리, Gemini 자막 번역 (각자 API 키 입력, 선택 사항)
- **확장 소스** — Mangayomi JS 저장소를 직접 추가합니다. 확장은 브라우저 안의 QuickJS/WASM에서 실행됩니다.
- **계정과 동기화** — 관리자 초대 방식의 계정, 같은 계정이면 PC와 휴대폰이 프로필·볼 목록·시청 기록을 공유합니다.
- **무료 배포** — 단일 Vercel 함수와 Upstash Redis만 씁니다. 영상은 브라우저가 원본에서 직접 받습니다.

## 시작하기

**[배포 가이드 열기](https://sidetool.github.io/moa-lite/)** 에서 버튼을 차례로 누르면 됩니다. 필요한 것은 GitHub 계정과 Vercel 계정(GitHub로 가입 가능)뿐입니다.

[![Vercel로 배포](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsidetool%2Fmoa-lite&project-name=moa-lite&repository-name=moa-lite&env=APP_SECRET%2CSETUP_CODE%2CENABLE_EXPERIMENTAL_COREPACK&envDescription=APP_SECRET%3A+%EB%B0%B0%ED%8F%AC+%EA%B0%80%EC%9D%B4%EB%93%9C%EC%97%90%EC%84%9C+%EB%A7%8C%EB%93%A0+64%EC%9E%90+%EB%B9%84%EB%B0%80%ED%82%A4.+SETUP_CODE%3A+%EB%B0%B0%ED%8F%AC+%EA%B0%80%EC%9D%B4%EB%93%9C%EC%97%90%EC%84%9C+%EB%A7%8C%EB%93%A0+%EC%84%A4%EC%A0%95+%EC%BD%94%EB%93%9C%28XXXX-XXXX-XXXX-XXXX%29.+ENABLE_EXPERIMENTAL_COREPACK%3A+1+%EA%B7%B8%EB%8C%80%EB%A1%9C.&envLink=https%3A%2F%2Fsidetool.github.io%2Fmoa-lite%2F&envDefaults=%7B%22ENABLE_EXPERIMENTAL_COREPACK%22%3A%221%22%7D&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D)

| 단계 | 할 일 | 입력하는 값 |
| --- | --- | --- |
| ① 값 만들기 | 가이드에서 **두 값 만들기**를 누르고 **파일로 보관**합니다. 값은 브라우저 안에서만 만들어집니다. | — |
| ② 배포 | **Vercel 배포 시작**을 누르고 GitHub로 로그인한 뒤, **Upstash** 저장 공간을 **Free** 요금제로 만듭니다. Free가 안 보이면 [Fork로 배포하기](docs/DEPLOYMENT.md#fork로-배포하기)를 따르세요. | `APP_SECRET`: ①의 비밀키<br>`SETUP_CODE`: ①의 설정 코드<br>`ENABLE_EXPERIMENTAL_COREPACK`: `1` (미리 채워짐) |
| ③ 관리자 계정 | 배포된 주소(`이름.vercel.app`)를 열어 **관리자 계정**을 만듭니다. | ①의 설정 코드, 아이디, 비밀번호 |

그다음 프로필을 만들고 **영상 소스**에서 쓸 Mangayomi JS 저장소 주소를 추가합니다. **기본으로 들어 있는 저장소나 영상은 없습니다.** TMDB·Gemini 키는 **설정**에서 넣습니다(선택). 휴대폰에서는 브라우저 메뉴의 **홈 화면에 추가**로 앱처럼 쓸 수 있습니다.

원클릭 배포는 처음 설치가 간편하지만, 내 저장소가 Fork가 아닌 복사본이 되어 이후 업데이트가 번거롭습니다. 업데이트를 자주 받으려면 처음부터 [Fork로 배포](docs/DEPLOYMENT.md#fork로-배포하기)하는 편이 낫습니다. 업데이트 방법은 [새 버전 받기](docs/DEPLOYMENT.md#새-버전-받기)를 참고하세요.

## MOA와 다른 점

moa-lite는 MOA를 포크해 서버가 하던 일을 브라우저와 Vercel 함수로 나눴습니다. 내 서버가 있다면 기능이 더 많은 [MOA](https://github.com/sidetool/moa)를 쓰세요.

| | MOA | moa-lite |
| --- | --- | --- |
| 실행 환경 | 내 서버의 Docker | Vercel Hobby + Upstash Redis Free |
| 확장 | Mangayomi JS, Aniyomi APK | Mangayomi JS (브라우저에서 실행) |
| 내 영상 파일·FFmpeg 변환 | 지원 | 지원하지 않음 |
| 영상 전송 | 서버가 중계·변환 | 브라우저가 원본에서 직접 받음 |
| 카탈로그·자막·번역 캐시 | 서버 DB | 기기의 IndexedDB |
| 계정·시청 기록 | 서버 DB | Upstash Redis (기기 간 동기화) |
| 원격 접속 | 터널 설정 | 배포 주소 그대로 |

### 재생 범위

- 브라우저가 바로 재생할 수 있는 HTTPS **MP4·WebM·HLS**만 재생합니다. WebView가 필요한 소스, FFmpeg 변환이 필요한 포맷은 기존 오류 화면으로 안내합니다.
- Vercel에 배포해도 원본 사이트의 접근 제한·Cloudflare 인증·데이터센터 IP 차단은 풀리지 않습니다. 소스마다 조회·재생 성공 여부가 다릅니다.
- PC에서는 선택 사항인 **연결 확장**(Chromium·Firefox)으로 조회를 내 브라우저에서 보내고, 재생 탭에만 임시 헤더/CORS 규칙을 적용할 수 있습니다. [설치 방법](docs/DEPLOYMENT.md#pc-연결-확장-선택-사항)
- 서버 쪽 조회(목록·검색·상세·영상 링크·표지)에는 [ByeDPI](https://github.com/hufrea/byedpi)가 기본으로 켜져 있습니다. `BYEDPI_ENABLED=0`으로 끌 수 있습니다. [자세히](docs/DEPLOYMENT.md#내장-byedpi-기본-켜짐)

### 무료 사용량

Vercel Hobby와 Upstash Free의 한도 안에서 무료입니다. **무료로 배포할 수 있다는 것이 사용량 무제한이라는 뜻은 아닙니다.** Vercel Hobby는 개인·비상업 용도로만 쓸 수 있고, 가장 먼저 닿기 쉬운 한도는 월 10GB의 Fast Origin Transfer(표지·소스 조회·동기화)입니다. 관리자 계정의 **설정 → 운영 → 진단 · 할당량**에서 한도와 공식 사용량 화면을 확인할 수 있습니다. [사용량과 저장 범위](docs/DEPLOYMENT.md#사용량과-저장-범위) · [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Upstash 요금](https://upstash.com/pricing/redis)

## 문서

- [배포·업데이트·문제 해결](docs/DEPLOYMENT.md) — 환경변수, Fork 배포, 연결 확장, ByeDPI, 사용량, 진단 메뉴
- [구현 구조와 저장 범위](docs/ARCHITECTURE.md)
- [검증 결과와 남은 확인 사항](docs/VERIFICATION.md)
- [면책 조항](DISCLAIMER.md) · [보안 제보](SECURITY.md) · [기여](CONTRIBUTING.md)
- [MOA 원본 README](docs/upstream/MOA-README.md) — `docs/`의 다른 문서는 MOA 원본 문서이며 Docker판 기준입니다.

## 개발

Node.js 24와 Corepack이 필요합니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm dev
```

개발 주소는 `http://127.0.0.1:5180`이고, 개발용 설정 코드는 서버 로그에 출력됩니다. Redis 없이 실행하면 서버를 다시 시작할 때 계정·동기화 데이터가 초기화됩니다. 계속 보관하려면 `.env.example`을 `.env`로 복사해 Redis와 비밀값을 채웁니다.

```bash
corepack pnpm typecheck
corepack pnpm test
CHROMIUM_PATH=/path/to/chrome corepack pnpm test:browser
corepack pnpm verify:vercel
```

브라우저 검증에는 Chromium이 필요합니다(`corepack pnpm --filter @moa/lite exec playwright-core install chromium`). `verify:vercel`은 공식 스키마와 Node 빌더를 내려받으므로 인터넷 연결이 필요합니다. 로그와 산출물은 Git에 포함하지 않는 `.state/`에 생깁니다. 배포 가이드 페이지의 원본은 [docs/index.html](docs/index.html)이며 GitHub Pages로 게시합니다.

## 면책 조항

moa-lite는 사용자가 직접 배포해 쓰는 영상 재생 소프트웨어입니다. 전문은 [DISCLAIMER.md](DISCLAIMER.md)를 따릅니다.

- **콘텐츠와 저장소를 제공하지 않습니다.** 기본 확장 저장소가 없으며, 이 프로젝트는 영상·자막 등 어떤 콘텐츠도 호스팅·배포·추천하지 않습니다. 어떤 저장소와 확장을 추가하고 무엇을 볼지는 전적으로 사용자가 정합니다.
- **법령과 이용 약관은 사용자가 지켜야 합니다.** 저작권법을 비롯한 거주 국가의 법령과 원본 사이트의 이용 약관을 지킬 책임은 사용자에게 있습니다. 연결 확장이나 ByeDPI로 원본에 접속할 때도 같습니다. 권리자가 허락하지 않은 콘텐츠에 접근하거나 공유하는 데 쓰지 마세요.
- **각 배포본은 배포한 사람이 운영합니다.** 제작자는 사용자가 배포한 앱을 운영·관리·감시하지 않으며 그 안의 계정과 기록에 접근할 수 없습니다. 초대한 사용자의 이용을 포함해 배포본에서 일어나는 일은 그 운영자가 책임집니다.
- **외부 서비스의 요금과 약관은 각 서비스와 사용자 사이의 일입니다.** Vercel, Upstash, GitHub, TMDB, Gemini 등의 요금·사용량 제한·계정 조치에 대해 제작자는 책임지지 않습니다.
- **보증 없음**: GPL-3.0 제15·16조에 따라 “있는 그대로(AS IS)” 제공되며, 법이 허용하는 범위에서 제작자와 기여자는 손해에 책임지지 않습니다.
- moa-lite는 Mangayomi, Aniyomi, Tachiyomi, TMDB, Vercel, Upstash의 공식 프로젝트가 아니며 이들과 제휴하지 않습니다. This product uses the TMDB API but is not endorsed or certified by TMDB.

## 라이선스

[GPL-3.0-or-later](LICENSE). MOA 코드([sidetool/moa](https://github.com/sidetool/moa))와 MOA의 Git 이력을 그대로 이어받았습니다. 출처·변경 범위·라이선스 전문은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [NOTICE](NOTICE), [LICENSES/](LICENSES/)에 있습니다. 확장 소스와 원본 콘텐츠의 권리·이용 조건은 각 제공자에게 있습니다.
