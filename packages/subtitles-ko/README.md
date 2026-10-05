# @moa/subtitles-ko

자막 제목/시즌/회차 매칭, 제작자 후보 조회, 파일 수집·ZIP 안전 검사, ASS/SRT/SMI/VTT 변환을 제공한다. `createSubtitleClient`, `resolveKoreanTitle`, `listCreators`, `searchSubtitles`, `fetchCreatorSubtitle`과 변환·추출 API를 export한다.

`SubtitleQuery`의 title/season/episode와 선택 aliases/episodeOffset으로 가상 작품이나 사용자가 확인한 항목을 지정한다. request timeout·abort signal·응답 크기 제한과 diagnostic callback을 제공한다. 외부 메타데이터와 제작자 페이지를 조회할 수 있으며 자동 제목 연결은 판본 일치를 보장하지 않는다. 특정 제작자나 사이트의 사용·호환성을 추천하지 않는다.

[자막과 외부 전송](../../docs/SUBTITLES-AND-SKIP.md)을 참고한다. 테스트는 직접 작성한 짧은 자막과 합성 ZIP/HTTP fixture를 사용한다.

```sh
corepack pnpm --filter @moa/subtitles-ko build
corepack pnpm --filter @moa/subtitles-ko test
```

온라인 연동은 Anissia의 제작자 메타데이터, AniList 제목 정보와 공개 자막 제작자 아카이브(카이란·Csora·Melody)를 대상으로 한다. 영상 스트리밍 사이트나 확장 저장소 목록이 아니다. `enableKairan`, `enableCsora`, `enableMelody`로 각 아카이브 조회를 끌 수 있다. 제작자 표시는 실제 배포처의 출처를 보존하기 위한 것으로, 파일 수집 성공이나 특정 작품·회차 제공을 보장하지 않는다. 운영 조회 기록·실제 첨부 파일은 테스트에 포함하지 않는다.

## 검색과 첨부 선택

애니시아 검색어는 문장부호를 정리해 보내고, 반환된 작품·시즌은 원래 제목으로 확인한다. 요청한 회차 또는 해당 시리즈임이 확인된 게시글에서는 파일명의 작품명을 다시 요구하지 않는다. 애니시아가 직접 제공한 자막·압축 파일 URL도 작품 연결을 신뢰한다. 파일명에서는 요청 회차와 명시된 시즌을 확인하며, 축약명만을 이유로 후보를 제외하거나 신뢰도를 낮추지 않는다.

다른 회차의 글에서 통합 압축 파일을 찾는 등 게시글만으로 요청 회차를 확인하지 못한 경우에는 기존 파일 식별 검사를 유지한다. 압축 해제 한도·경로 검사, 자막 형식 변환, 한국어 본문 확인은 모든 경로에 적용한다. 잘못 첨부된 파일 자체를 완전히 판별하는 기능은 아니다.
