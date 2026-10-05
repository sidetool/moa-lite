# 이용 책임 및 면책 / Responsibility and disclaimer

moa-lite는 사용자가 자신의 Vercel·Upstash 계정에 직접 배포해 쓰는 영상 재생 소프트웨어다. 이 프로젝트, 공식 저장소와 배포 가이드는 제3자 확장, 확장 저장소 또는 영상·자막 등 콘텐츠를 제공·호스팅·번들·추천·보증하지 않는다. 기본으로 등록되거나 제공되는 확장 저장소는 없으며 사용자가 직접 주소와 확장을 선택한다.

## 사용자의 책임

사용자는 자신이 추가·설치·사용하는 저장소·확장·콘텐츠에 전적으로 책임을 지며, 필요한 권한을 확보하고 저작권법을 비롯한 거주 국가의 법령과 원본 사이트·서비스의 이용 조건을 준수해야 한다. 권리자가 허락하지 않은 콘텐츠에 접근하거나 이를 공유·재배포하는 데 moa-lite를 사용해서는 안 된다.

선택 기능인 PC 연결 확장과 서버 조회의 ByeDPI는 네트워크 호환성을 위한 기능이며, 원본 사이트의 접근 제한·인증·이용 조건을 무시해도 된다는 뜻이 아니다. 이 기능을 켜거나 쓰는 것이 거주 국가의 법령이나 이용 중인 네트워크·서비스의 조건에 맞는지는 사용자가 확인한다. ByeDPI는 `BYEDPI_ENABLED=0`으로 끌 수 있다.

## 배포본의 운영

각 배포본은 그것을 배포한 사람(운영자)이 운영한다. 유지관리자는 사용자가 배포한 앱을 운영·관리·감시하지 않으며, 그 앱의 계정·시청 기록·API 키·Redis 데이터에 접근할 수 없다. 운영자가 초대한 다른 사용자의 이용을 포함해 배포본에서 일어나는 일과 그 데이터의 보호·백업은 운영자가 책임진다.

배포본은 기능상 확장 소스의 목록·검색·상세·영상 링크 조회와 표지를 Vercel 함수로 중계하고, 계정·시청 기록과 관리자가 입력한 API 키(암호화)를 Upstash Redis에 저장한다. 영상과 HLS 세그먼트는 중계하지 않으며 사용자의 브라우저가 원본에서 직접 받는다. 확장·카탈로그·자막·번역 캐시는 사용자 기기의 브라우저 저장소에 저장된다.

## 외부 서비스

Vercel, Upstash, GitHub, TMDB, Google Gemini, 자막 서비스 등 외부 서비스의 요금, 사용량 한도, 이용 약관과 계정 조치는 해당 서비스와 사용자 사이의 일이며 유지관리자는 이에 책임지지 않는다. Vercel Hobby는 개인·비상업 용도로 제한된다. 무료 요금제 안에서 운영할 수 있도록 설계했지만 사용량이 무료 한도 안에 머문다는 보장은 없다. 유료 요금제를 고르면 요금이 청구될 수 있으므로 요금제를 직접 확인한다.

## 제휴 없음

moa-lite와 유지관리자는 어떤 사이트·확장 제작자·저장소 운영자와도 제휴하지 않는다. moa-lite는 Mangayomi, Aniyomi, Tachiyomi, TMDB, Vercel, Upstash, Google 또는 ByeDPI의 공식 프로젝트가 아니다. 기술 호환이나 명칭 언급은 승인·추천·제휴를 뜻하지 않는다.

## 보증 부인과 책임 제한

소프트웨어는 명시적·묵시적 보증 없이 **있는 그대로(AS IS)** 제공된다. 법률이 허용하는 최대 범위에서 유지관리자와 기여자는 사용·사용 불능, 데이터 손실, 외부 서비스 요금, 제3자 확장·저장소·콘텐츠로 인한 손해에 책임을 지지 않는다. [GPL-3.0](LICENSE) 제15조(보증 부인)·제16조(책임 제한)와 함께 포함된 제3자 코드 라이선스의 보증 부인과 책임 제한도 적용된다. 이 안내는 법령상 배제할 수 없는 책임까지 면제한다는 뜻이 아니다.

## 문의

- 제3자 콘텐츠 삭제 요청은 해당 콘텐츠의 제공자에게 보낸다. 개별 배포본에 관한 문의는 그 운영자에게 한다.
- 이 저장소의 코드·문서에 관한 권리 문제는 이 저장소의 이슈에 관련 파일과 권리 근거를 알려 준다.
- 보안 문제는 [비공개 제보](SECURITY.md)를 따른다.

## English

moa-lite is video playback software that users deploy to their own Vercel and Upstash accounts. This project, its official repository and its deployment guide do not provide, host, bundle, recommend, endorse, or warrant third-party extensions, extension repositories, or content, including videos and subtitles. No extension repositories are registered or supplied by default. Users choose repository addresses and extensions themselves.

Users are solely responsible for the repositories, extensions, and content they add, install, or use, for obtaining necessary permissions, and for complying with copyright law, the laws where they live, and the terms of the sites and services they access. Do not use moa-lite to access, share, or redistribute content without the rights holder's permission. The optional PC connector and the server-side ByeDPI lookup feature exist for network compatibility; they do not authorize bypassing a site's access controls, authentication, or terms. Users must check that enabling them is lawful and permitted on their network. ByeDPI can be disabled with `BYEDPI_ENABLED=0`.

Each deployment is operated by the person who deployed it. Maintainers do not operate, manage, or monitor user deployments and cannot access their accounts, watch history, API keys, or Redis data. The operator is responsible for everything that happens on their deployment, including use by invited users, and for protecting and backing up its data. A deployment relays extension source lookups (lists, search, details, video links) and cover images through a Vercel function, and stores accounts, watch history, and admin-entered API keys (encrypted) in Upstash Redis. It does not relay video or HLS segments; the user's browser fetches them directly from the origin. Extension, catalog, subtitle, and translation caches are stored in the user's browser.

Pricing, usage limits, terms, and account actions of external services such as Vercel, Upstash, GitHub, TMDB, Google Gemini, and subtitle services are between the user and that service; maintainers are not responsible for them. Vercel Hobby is limited to personal, non-commercial use. The project is designed to run within free tiers, but usage is not guaranteed to stay within free limits, and choosing a paid plan may incur charges.

moa-lite and its maintainers are not affiliated with any site, extension author, or repository operator. This is not an official project of Mangayomi, Aniyomi, Tachiyomi, TMDB, Vercel, Upstash, Google, or ByeDPI. Compatibility and third-party names do not imply endorsement, approval, or affiliation.

The software is provided **AS IS**, without express or implied warranties. To the maximum extent permitted by law, maintainers and contributors are not liable for damages arising from use or inability to use, data loss, external service charges, or third-party extensions, repositories, or content. Sections 15 and 16 of the [GPL-3.0](LICENSE) and the warranty disclaimers and liability limits of included third-party licenses also apply. Nothing here excludes liability that cannot be excluded by law.

Direct third-party content removal requests to the content provider, and questions about a specific deployment to its operator. Report rights issues in this repository's code or documents through its issues, identifying the files and basis of the claim. Report vulnerabilities [privately](SECURITY.md).

## TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

[TMDB](https://www.themoviedb.org) · [API attribution requirements](https://developer.themoviedb.org/docs/faq)
