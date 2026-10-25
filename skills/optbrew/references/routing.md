# Situation routing

이 표는 SKILL.md 10단계에서 수정안의 근거 가이드를 고를 때만 쓴다. 표의 가이드는 고치는 법을 읽는 문서이고, 실행할 도구가 아니다. 수집, 판정, 채점은 `run.mjs`가 한 번에 하므로, 표의 모듈을 감사 단계에서 따로 돌리지 않는다. 필요한 분기의 GUIDE만 연다. 모든 모듈 출력은 관찰 후보이며 한 URL·문제·검사는 한 번만 채점한다. 무료 경로는 허용된 공개 HTTP/HTML과 사용 가능한 호스트 도구를 사용한다. 원본 HTML, 렌더, 소유자 패널과 AI 제공자 응답의 출처를 각각 기록한다.

| 고칠 문제 | 먼저 열 가이드(이 중 하나) | 함께 볼 근거 | 수정안에 담을 것 |
|---|---|---|---|
| 기술 차단·색인 | [mblode audit](../modules/mblode-seo/references/audit.md), [marketing SEO audit](../modules/marketing-search/skills/seo-audit/GUIDE.md) | 네이버 목표면 [Naver](../modules/naver-searchadvisor/GUIDE.md); HTTP·원본 HTML·허용된 렌더·소유자 URL 검사 | 차단·오류·unknown과 근거 |
| URL·템플릿 구조 | [mblode](../modules/mblode-seo/GUIDE.md), [site architecture](../modules/marketing-search/skills/site-architecture/GUIDE.md) | 대량 생성 요청일 때만 [programmatic SEO](../modules/marketing-search/skills/programmatic-seo/GUIDE.md) | 고정 URL 표본·링크·템플릿 개선안 |
| 자바스크립트로만 보이는 내용·수집 실패 | [Firecrawl SEO audit](../modules/firecrawl-seo-audit/GUIDE.md) | 같은 경계와 비용을 보장하는 호스트 HTTP/브라우저 기능 | 원본·렌더 구분 및 raw 참조 |
| 질문·답변·엔티티 | [Magnus](../modules/magnus-seo/GUIDE.md), [AI SEO](../modules/marketing-search/skills/ai-seo/GUIDE.md) | [content strategy](../modules/marketing-search/skills/content-strategy/GUIDE.md), [schema](../modules/marketing-search/skills/schema/GUIDE.md); 고정 질문·사실 목록 | 근거 있는 답변·사실 정정안 |
| 네이버 노출 | [Naver](../modules/naver-searchadvisor/GUIDE.md) | mblode 기술 근거, Yeti 응답·마크업·Search Advisor 소유자 자료 | 네이버 범위의 관찰과 unknown |
| AI 인용·경쟁 비교 | [SE Ranking](../modules/seranking-seo/skills/seo-ai-search-share-of-voice/GUIDE.md) | 승인된 API 또는 날짜가 있는 내보내기, Magnus 질문 프로토콜 | 엔진별 인용 실측; 무료 감사의 필수 조건 아님 |
| 유입·전환 비교 | [mblode monitoring](../modules/mblode-seo/references/monitoring.md), [analytics](../modules/marketing-search/skills/analytics/GUIDE.md) | 같은 소유 속성·필터·완결된 28일 창 | 실제 성과와 비교 가능성 |

호스트 도구의 경계·비용 강제가 확인되지 않으면 사용하지 않는다. 감사 흐름은 Anthropic API를 직접 부르지 않는다. 다른 API와 SE Ranking 실행은 각자의 승인·상한·능력 근거가 있어야 한다. 호스트 정책만 비용을 강제하면 그 한계를 보고한다.
