# optbrew 출처와 공개 배포 경계

확인일: 2026-10-13, Asia/Seoul. 이 문서는 설계의 출처 기록이다. 패키지 설치와 제품 실행의 검증 결과는 다음 단계에서 별도로 작성한다.

## 1. 공식 저장소의 라이선스

공식 GitHub API로 아래 파일을 해당 고정 ref에서 읽었다. 표의 Git blob SHA는 라이선스 파일의 식별자이며 저장소 commit SHA와 다르다. MIT·ISC 고지를 지키는 자체 파일의 사용·수정·재배포가 허용된다. 이 판단은 서비스 계정·API 데이터 이용권을 포함하지 않는다.

| 원본 | 고정 ref | 공식 라이선스 파일 | Git blob SHA |
|---|---|---|---|
| mblode/agent-skills | 872bc83bdb6dd54a9ff456fbf1181beea6db7875 | [LICENSE.md](https://github.com/mblode/agent-skills/blob/872bc83bdb6dd54a9ff456fbf1181beea6db7875/LICENSE.md), MIT | c5a1d56c6d623c72d077f8aab56b31d7dc371cbb |
| JaceProgramming/naver-searchadvisor-expert | cd95f6281090416b3dfbf15fb0f66f0ffa67a19c | [LICENSE](https://github.com/JaceProgramming/naver-searchadvisor-expert/blob/cd95f6281090416b3dfbf15fb0f66f0ffa67a19c/LICENSE), MIT의 적용 범위 제한 | 4434edf30edce0a41c07fbc776b0d5cebd044547 |
| firecrawl/firecrawl-workflows | 94cc91229d6cedc0613f140d3d013b150bc8e1b0 | [LICENSE](https://github.com/firecrawl/firecrawl-workflows/blob/94cc91229d6cedc0613f140d3d013b150bc8e1b0/LICENSE), ISC | ee221a2151d63ddc1db9857f9c5d346a3de9d816 |
| magnus919/agent-skills | 2e8fb962819b2b01b270620f92f0cc7213d77ef1 | [LICENSE.md](https://github.com/magnus919/agent-skills/blob/2e8fb962819b2b01b270620f92f0cc7213d77ef1/LICENSE.md), MIT | 9745e19f4b20d77c134964ae1bf0af0ace5c4db7 |
| seranking/seo-skills | fd6d1408f2e6a06454d81c07c29e0f04342eb9ba | [LICENSE](https://github.com/seranking/seo-skills/blob/fd6d1408f2e6a06454d81c07c29e0f04342eb9ba/LICENSE), MIT | ca6b9a33c8234bf47cdcfb2dc157b308195845c5 |
| coreyhaines31/marketingskills | v2.11.1, 5b2c0007766c6a1cf1d53fd8fc73e979e0821022 | [LICENSE](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/LICENSE), MIT | 7c48dd638a9ebed49a8ef0c0c4eea90105381cdf |

네이버의 LICENSE는 MIT 적용 대상을 자체 SKILL.md, scripts, tools, README, NOTICE, references/INDEX로 제한한다. references/guide의 네이버 원문에는 적용하지 않는다. [NOTICE.md](https://github.com/JaceProgramming/naver-searchadvisor-expert/blob/cd95f6281090416b3dfbf15fb0f66f0ffa67a19c/NOTICE.md)는 원문 55개가 네이버 저작권이고 원본 수집이 2026년 7월이라고 설명한다. 공개 웹 문서를 읽을 수 있다는 사실을 전문 재배포 허가로 바꾸지 않는다.

Corey Haines의 설치 플러그인은 2.11.1이며 공식 v2.11.1 tag의 ref를 git ls-remote로 확인했다. 설치 캐시를 제품 원본으로 직접 사용하지 않는다. 포함 파일은 공식 ref와 대조하고 각 해시를 기록한다.

mblode와 Magnus의 루트 라이선스 파일은 LICENSE.md다. LICENSE로 요청한 첫 조회는 404였고 정확한 파일명으로 재조회해 성공했다. 첫 404를 라이선스 부재로 해석하지 않았다.

## 2. 점수·측정의 1차 근거

| ID | 근거 | 설계에서 사용하는 범위 |
|---|---|---|
| G-TECH | [Google technical requirements](https://developers.google.com/search/docs/essentials/technical) | 접근, 성공 응답, 색인 가능한 콘텐츠와 실제 색인의 구분 |
| G-AI | [Google AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) | SEO 기반, 콘텐츠·기술 구조, 불필요한 특수 AI 전술의 구분 |
| G-CWV | [Google CWV](https://developers.google.com/search/docs/appearance/core-web-vitals) | 실제 방문의 성능 지표와 검색 결과의 관계 |
| WEB-CWV | [CWV thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds) | 75백분위와 LCP·INP·CLS의 good·poor 기준 |
| LH | [Lighthouse scoring](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring) | 실험실 검사, 버전·환경 변동, 성능 점수의 가중 평균 |
| G-SC | [Search performance report](https://support.google.com/webmasters/answer/7576553) | 클릭·노출·CTR·평균 위치와 집계·기간의 정의 |
| G-AIR | [Generative AI report](https://support.google.com/webmasters/answer/16984139) | AI Overviews·AI Mode 노출, 집계 차이와 내보내기 결측의 0 변환 |
| B-AI | [Bing AI Performance](https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview) | 인용 수·인용 페이지·표본 grounding queries. 순위·정확성과 구분 |
| OA-BOT | [OpenAI crawlers](https://developers.openai.com/api/docs/bots) | OAI-SearchBot, GPTBot, 사용자 요청 fetch의 독립된 의미 |
| N-MARKUP | [네이버 콘텐츠 마크업](https://searchadvisor.naver.com/guide/markup-content) | 제목·설명·OG의 실제 권장·요건. 임의 고정 글자 수 제외 |
| N-STRUCT | [네이버 구조 마크업](https://searchadvisor.naver.com/guide/markup-structure) | 해당 로봇 메타와 콘텐츠 제어의 적용 범위 |
| ROBOTS | [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) | 일치 그룹 병합과 robots 정책 해석 |

CWV 기준은 실제 방문 값의 75백분위다. LCP good ≤2500ms, poor >4000ms. INP good ≤200ms, poor >500ms. CLS good ≤0.1, poor >0.25다. optbrew가 중간 구간에 0.5를 부여하는 것은 자체 산식이며 Google 산식이 아니다.

Lighthouse 문서는 score가 환경에 따라 변동하고 실측 분포를 생각해야 한다고 설명한다. Lighthouse 전체 성능 점수를 Google 순위 점수나 실제 방문 CWV로 대신하지 않는다. Lighthouse와 실제 방문 자료를 합산해 같은 지표를 두 번 채점하지 않는다.

Google AI report는 내보내기에서 화면의 `~`·`-`를 0으로 바꿀 수 있다고 설명한다. 이 손실을 인식하지 않은 분석은 결측과 실제 0을 혼동할 수 있다. optbrew 입력 계약에 표시 상태·결측 마스크 또는 zero_or_missing을 둔다.

## 3. 연구와 보완 레퍼런스

| ID | 원문 | 활용 | 확대 해석하지 않는 범위 |
|---|---|---|---|
| GEO-2024 | [GEO, KDD 2024](https://dl.acm.org/doi/10.1145/3637528.3671900), [논문](https://arxiv.org/pdf/2311.09735.pdf) | 인용 위치·내용과 실험별 visibility metric의 구분 | 최대 40% 결과를 특정 사이트의 예상 효과·schema 효과로 일반화하지 않음 |
| VERIFY-2023 | [Evaluating Verifiability](https://arxiv.org/abs/2304.09848) | 인용 coverage와 연결 주장 support·precision의 구분 | 2023년 제품 실험 비율을 현재 서비스의 정확도로 사용하지 않음 |
| MB-MEASURE | [mblode SEO](https://github.com/mblode/agent-skills/tree/872bc83bdb6dd54a9ff456fbf1181beea6db7875/skills/seo) | 속성·범위·데이터 부족·실측 인용·구현 검증의 구분 | 행동 예제는 실사이트 성과 검증이 아님 |
| MG-MEASURE | [Magnus SEO](https://github.com/magnus919/agent-skills/tree/2e8fb962819b2b01b270620f92f0cc7213d77ef1/seo) | 고정 질문, 관찰 로그, 반복 의존성과 0~2 평가 rubric | 원본 파서 통과만으로 콘텐츠·실제 성과를 검증했다고 주장하지 않음 |
| SR-GEO | [SE Ranking GEO](https://github.com/seranking/seo-skills/tree/fd6d1408f2e6a06454d81c07c29e0f04342eb9ba/skills/seo-geo) | URL별 AIO 관찰과 근거 보존 | upstream correlations·필수 Firecrawl 전제를 공통 정책으로 사용하지 않음 |
| SR-SOV | [SE Ranking SOV](https://github.com/seranking/seo-skills/tree/fd6d1408f2e6a06454d81c07c29e0f04342eb9ba/skills/seo-ai-search-share-of-voice) | 엔진·도메인·브랜드별 비교 | 이미 노출된 prompt 표본을 전체 인용률의 분모로 사용하지 않음 |

기존 SNS 수집 자료의 18개 참고 카드에서 공식 A·재현 B·사례 C·미검증 D 구분과 관련 측정·봇·콘텐츠 조언을 확인했다. 검색한 3개 문구는 179개 블록 중 50개 블록을 반환했다. 전문 전수 검증을 수행한 것은 아니다. 공개 패키지에는 비공개 카드 본문을 넣지 않는다. 카드에서 얻은 공식 원칙은 이 문서의 직접 확인한 공개 원문으로 연결한다.

## 4. 에이전트·플러그인·업데이트의 공식 근거

| ID | 공식 문서 | 확인한 내용 |
|---|---|---|
| SKILL-SPEC | [Agent Skills specification](https://agentskills.io/specification) | name·description·directory, progressive disclosure와 supporting files |
| CODEX-SKILL | [Codex skills](https://developers.openai.com/codex/skills/) | .agents의 발견, symlink와 plugin 배포 |
| OA-PLUGIN | [Package your plugin](https://developers.openai.com/plugins/build/plugins) | root plugin.json, extensions.com.openai와 호환 overlay |
| CODEX-CLI | [Codex CLI reference](https://developers.openai.com/codex/cli/reference) | plugin add·list, marketplace add·upgrade. 실제 클라이언트 문법은 설치 버전에서 대조 |
| CODEX-PLUGIN | [Codex plugins](https://developers.openai.com/codex/plugins) | Work 웹·데스크톱 및 Codex, 일반 Chat·모바일과의 차이 |
| CC-SKILL | [Claude Code skills](https://code.claude.com/docs/en/skills) | 공통 규격과 Claude Code 확장의 차이 |
| CC-UPDATE | [Host marketplace](https://code.claude.com/docs/en/plugins/host-marketplace) | version 변경, 수동 업데이트, 사용자가 켜는 auto-update |
| CLAUDE-WEB | [Claude에서 스킬 사용](https://support.claude.com/en/articles/12512180-use-skills-in-claude) | Customize → Skills의 ZIP 업로드, code execution·정책 조건 |
| CURSOR | [Cursor Agent Skills](https://cursor.com/docs/context/skills) | .agents·.cursor 경로, Cloud 동기화의 구분 |
| OPENCODE | [OpenCode Agent Skills](https://opencode.ai/docs/skills/) | 호환 경로와 skill permission |
| PI-SKILL | [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) | 재귀 발견, .agents와 .pi 경로 |
| PI-PACKAGE | [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) | npm·git package 설치, update, pinned ref의 갱신 경계 |
| VERCEL-SKILLS | [Vercel Skills](https://github.com/vercel-labs/skills) | agent 선택·global 범위·skills update. 지원 경로는 버전별 확인 |
| NPM-UPDATE | [npm update](https://docs.npmjs.com/cli/v11/commands/npm-update) | semver 제약, global 업데이트와 직접 파일 복사의 차이 |

badlogic/pi-mono의 공식 문서 URL은 조회 시 earendil-works/pi로 연결됐다. 새 저장소 이름과 설치 명령은 배포 문서 작성 때 다시 확인한다. root README의 계정·경로와 예전 문서를 혼합하지 않는다.

Claude Code의 marketplace auto-update는 사용자가 켜는 기능이다. marketplace.json 자체가 이 설정을 켜지 않는다. version을 고정해 놓고 release 때 올리지 않으면 사용자가 새 파일을 받지 못할 수 있다. 릴리스 산출물 검사에 version 일치를 포함한다.

npm package 업데이트만으로 과거에 복사한 agent 폴더가 갱신되지는 않는다. optbrew 관리 설치의 update가 실제 설치 파일과 InstallRecord를 갱신하고 readback해야 한다. Vercel Skills 설치와 Pi package 설치는 해당 도구의 기록·업데이트 경로를 안내한다.

## 5. API 설정의 공식 근거

| 서비스 | 공식 경로 | 사용자가 할 일 |
|---|---|---|
| Claude API | [API 키 발급](https://platform.claude.com/docs/en/get-api-key) | platform.claude.com에 로그인 → Settings → API keys → Create key. local secrets에서 ANTHROPIC_API_KEY로 사용 |
| Claude Code 계정 | [Authentication](https://code.claude.com/docs/en/authentication) | 구독 로그인과 Console/API 과금 경로를 구분 |
| SE Ranking | [API 안내](https://seranking.com/api.html), [MCP 문서](https://seranking.com/api/integrations/mcp) | 계정·API 크레딧 확인, 연결된 HTTP MCP에서 OAuth 또는 문서화된 직접 인증 |
| SE Ranking MCP | https://api.seranking.com/mcp | 호스트별 HTTP MCP 문법을 현재 버전에서 확인해 등록 |

SE Ranking 문서에 포함된 예전 Codex rmcp 설정을 그대로 설치 지침에 복사하지 않는다. 호스트의 현재 공식 CLI와 동작을 우선한다. 키 실값을 예제, 대화나 로그에 넣지 않는다.

## 6. 이번 단계의 확인 범위

확인함: 위 6개 소스의 공식 라이선스, 네이버 제외 조건, 기존 플러그인 버전과 공식 tag, 측정·설치·업데이트 문서의 관련 내용, SNS 참고자료의 선택한 블록.

다음 단계에서 확인함: 모든 전이 참조 파일의 포함·저작권, 실제 보정 코드, dependency license, 채점 실행, 호스트 설치·새 세션 호출, API의 실제 사용량·단가·호출 권한, 배포 파일 내부 내용과 게시 계정.

문서를 읽었다는 증거를 제품 성능 시험, 모든 플랫폼 실행 성공, 실제 SEO·AI 성과의 증거로 사용하지 않는다.
