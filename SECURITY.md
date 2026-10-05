# 보안 제보

이 저장소의 GitHub **Security → Advisories → Report a vulnerability**에서 private vulnerability reporting으로 제보한다. 영향받는 버전/커밋, 재현 절차와 최소한의 합성 증거를 포함한다. 실제 계정·API 키·쿠키·재생 세션 URL·미디어·DB는 첨부하지 않는다. private reporting이 아직 비활성화되어 있으면 비밀이나 재현 exploit을 공개 이슈에 올리지 말고, 해당 기능의 활성화만 요청한다.

보안 수정은 최신 main과 최신 릴리스를 우선 대상으로 한다. 이전 버전에 대한 별도 지원 기간은 약속하지 않는다.

확장은 제3자 실행 코드다. moa-lite는 Mangayomi JS 확장을 브라우저의 격리된 QuickJS/WASM Worker에서 시간·메모리 제한과 함께 실행하지만, 신뢰하는 확장만 설치한다. `APP_SECRET`, `SETUP_CODE`, Upstash 토큰은 Vercel 서버 환경변수로만 등록하고 `VITE_` 접두사를 붙이거나 저장소에 커밋하지 않는다. 배포본의 계정·초대·Redis 데이터와 백업은 배포한 운영자가 관리한다. [구조](docs/ARCHITECTURE.md)와 [배포](docs/DEPLOYMENT.md)를 참고한다.
