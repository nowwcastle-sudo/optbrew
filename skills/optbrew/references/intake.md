# Intake and start questions

SKILL.md의 3단계~6단계가 쓰는 참고 문서다. 순서는 SKILL.md가 정한다. 여기에는 각 값을 어떻게 읽고 만드는지만 적는다.

## 원칙

- 사용자가 이미 준 값은 다시 묻지 않는다. 주소가 없을 때만 주소 하나를 따로 묻는다. 나머지는 시작 질문 한 묶음에서 묻는다.
- 모르는 값은 `unknown`으로 남긴다. 값을 지어내지 않는다.
- 소유자 자료(검색 콘솔 내보내기)나 유료 API가 없어도 허용된 공개 HTTP/HTML로 기본 감사는 끝까지 간다. 없는 자료는 보고서의 남은 일이 된다.
- 원격 전용 사이트는 수정할 수 있다고 가정하지 않는다.
- 비용이 드는 호출은 이 흐름에 없다. 유료 경로는 예상 단가의 출처·날짜, 승인된 한도, 중단 조건이 기록되기 전에는 쓰지 않는다. 단가를 모르면 0으로 넣지 말고 보류한다.
- 감사 범위(주소 범위, 요청 수, 렌더할 쪽, 판정 대상)는 `run.mjs`가 답 파일에서 `RunContext`와 프로토콜로 만든다. 에이전트가 계약 JSON을 손으로 조립하지 않는다.

## `start.json`을 읽는 법

`preflight.mjs`가 `<OUT>/preflight/start.json`에 쓴다. 채점하지 않는 사전 읽기이며, 본 감사의 요청 수와 프로토콜에 들어가지 않는다. 본 감사는 답 파일로 프로토콜을 고정한 뒤 처음부터 새로 수집한다.

| 필드 | 뜻 | 쓰는 곳 |
|---|---|---|
| `probe.harness` | 실행 환경: `claude-code`, `claude-code-cloud`, `codex`, `other` | 키 저장 런북 고르기 |
| `probe.block_reason` | `null`, `site_down`, `codex_sandbox`, `cloud_network_level` | 3단계 표 |
| `probe.transport`, `probe.address_vetting`, `probe.proxy` | 직접 연결인지 프록시인지. 프록시는 호스트와 포트만 있다 | 답 파일에 그대로 복사 |
| `probe.chrome` | `{ found, kind, reason }`. 없으면 렌더 항목이 빈칸이 된다 | 답 파일에 그대로 복사 |
| `probe.google_key` | Google 키 유무. 값은 없다 | 답 파일에 그대로 복사 |
| `sitemap_pages`, `sitemap_pages_basis` | 사이트맵 쪽수. `basis`는 `exact`, `lower_bound`, `null` | 5번 질문 |
| `question_candidates_input` | 읽은 쪽마다 `{ url, title, h1, description }` | 3번 질문 |
| `fact_candidates` | `{ key, value, source_url }`. 쪽에서 읽은 이름·주소·전화·설립 연도 후보 | 4번 질문 |
| `start_runbooks.blocking` | 감사가 돌지 않게 막는 런북. 최대 1개. `text`에 본문이 들어 있다 | 3단계 표 |
| `start_runbooks.improving` | 있으면 결과가 채워지는 런북. 각각 `{ id, line, harness }`. 최대 3개 | 6번 질문 |

`probe`는 한 번만 점검한다. 답 파일에는 `start.json`의 `probe`를 그대로 복사한다. 사용자가 점검 뒤에 키나 크롬을 준비했으면 점검 명령을 다시 실행해 새 `start.json`을 쓴다.

## 시작 질문 만들기

### 목표 (2번)

고를 수 있는 목표는 검색 유입, 네이버 노출, AI 답변 인용, 브랜드 사실 정확성, 전환이다. 답 파일에는 사용자의 말에 가까운 짧은 문자열로 적는다. 사용자가 목표를 말하지 않았으면 "검색 유입", "AI 답변 인용"을 기본으로 둔다.

### 질문 목록 (3번)

감사가 "이 사이트가 이 질문에 답하는가"를 보는 기준이다. `question_candidates_input`의 제목, 첫 제목, 설명에서 만든다.

- 10개 안팎으로 만든다. 8개에서 12개 사이면 된다.
- 브랜드 질문(이름이 들어간 질문, 예: "OO는 어디에 있나요")과 일반 질문(이름 없이 찾는 질문, 예: "재가 요양 서비스 신청은 어떻게 하나요")을 섞는다.
- 사이트의 언어로 쓴다. 사이트에 근거가 없는 주제로는 만들지 않는다.
- 답 파일에서는 `{ id, question, category, goal }`이다. `id`는 `q1`, `q2`처럼 번호를 붙인다. `category`는 `brand` 또는 `non_brand`다. `goal`은 2번에서 확정한 목표 중 하나다.

### 사실 목록 (4번)

쪽 사이의 사실 일치(이름, 주소, 전화, 설립 연도)를 검사하는 기준이다. 후보는 사이트에서 읽은 값이므로, 이 목록은 "사이트가 자기 자신과 맞는가"를 보는 용도다. 사이트 밖 진실을 확인하지 않는다. 사용자가 틀린 값을 고치면 고친 값을 쓴다.

### 표본과 상한 (5번)

기본 상한은 50쪽이다(`max_urls_default`). 사이트맵이 50쪽을 넘으면 "표본 감사" 또는 "상한을 올림"을 묻는다. 올릴 수 있는 한도는 200쪽이다(`max_urls_cap`). 두 값의 원천은 [limits.json](limits.json)이다. 상한은 페이지와 보조 파일(robots, sitemap)의 요청 수를 모두 합친 값이다.

### 있으면 더 채워지는 것 (6번)

`start_runbooks.improving`에 있는 항목만 보여 준다. 항목마다 한 줄이다. 사용자가 해당 단어로 답할 때만 런북을 펼친다. 답하지 않으면 감사는 그대로 가고, 그 런북은 보고서의 남은 일에 붙는다.

## 답 파일의 필드

`<OUT>/intake-answers.json`의 필드는 SKILL.md 6단계가 보여 준다.

| 필드 | 뜻 |
|---|---|
| `schema_version` | [versions.json](versions.json)의 `contract_schema` 값 |
| `guidance_level` | 런북 깊이: `beginner`, `brief` |
| `url` | 사용자가 확인한 감사 시작 주소 |
| `goals` | 목표 문자열 목록 |
| `questions` | 확정한 질문 목록 |
| `facts` | 확정한 사실 목록 |
| `sample_mode` | `null`, `sample`, `raise`. 5번 질문이 없었으면 `null` |
| `max_urls` | 요청 상한. 정수이며 기본 50, 올려도 200 이하 |
| `source_tools` | 소스 분석 도구 이름 목록 |
| `probe` | `start.json`의 `probe` |

## 재개

같은 결과 폴더의 증거와 답 파일을 읽어 이어간다. 새 실행으로 조용히 바꾸거나 증거를 덮어쓰지 않는다. 목표, 범위, 표본이 바뀌면 새 결과 폴더에서 처음부터 한다. 이전 결과와 비교할 수 있는지는 비교 단계가 판정한다.
