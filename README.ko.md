# optbrew

[![npm](https://img.shields.io/npm/v/optbrew.svg)](https://www.npmjs.com/package/optbrew)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md)

코딩 에이전트용 검색 준비도 감사 스킬입니다. optbrew는 구글·네이버·AI 답변 엔진 기준으로 사이트를 점검합니다. 승인한 로컬 파일만 고치고, 같은 조건으로 다시 확인한 뒤, 다시 계산할 수 있는 근거로 점수 보고서를 씁니다.

- 스킬 하나로 다섯 가지를 봅니다: **SEO**, **NEO**(네이버), **AEO**, **GEO**, **LLMO**.
- 초보자도 한 번에 끝냅니다. 시작 질문에 한 번 답하면 에이전트가 감사 전체를 돌리고 HTML 보고서를 건네 줍니다.
- 고정된 감사 가이드 묶음 5개를 점검 항목 22개로 합쳤습니다. 여러 가이드가 같은 문제를 짚어도 한 번만 셉니다.
- 보고서의 판정은 모두 수집한 원본 응답(해시 기록)에서 다시 계산할 수 있습니다.
- 근거가 모자라면 대표 점수를 내지 않습니다. 측정 범위가 80% 미만이면 잰 부분과 그 범위만 보여 줍니다.
- Codex, Claude Code, Cursor, OpenCode, Pi에서 씁니다. 점수 계산과 보고서에는 API 계정이 필요 없습니다.

## 왜 optbrew인가

이제 「검색에 잡힌다」는 말은 세 가지를 뜻합니다. 구글 순위, 네이버 노출, AI 답변 속 인용입니다. 셋 다 가이드가 따로 있고, 가이드끼리 겹치거나 서로 다른 말을 합니다. 에이전트에게 「SEO 개선해 줘」라고 하면 보통 체크리스트 하나를 골라 파일을 고치고, 근거 없이 끝났다고 보고합니다.

optbrew는 다섯 기준 모두에 같은 작업 순서와 같은 채점 규칙을 씁니다. 잰 것만 점수에 넣고, 재지 못한 것은 통과가 아니라 「알 수 없음」으로 남깁니다. 로컬에서 고친 것과 실제 운영 결과도 따로 적습니다. 준비도 점수가 높아도 방문자나 인용이 는다는 보장은 없으며, 보고서에도 그렇게 적힙니다.

## 동작 방식

1. **질문.** URL을 알려 주면 optbrew가 시작 쪽, 사이트맵, 사용자의 환경(크롬, 구글 키, 네트워크)을 읽습니다. 그다음 시작 질문을 한 메시지로 보냅니다. 안내 수준, 목표, 사람들이 찾을 질문, 사이트에서 읽은 사실, 쪽수 상한을 묻습니다. 번호마다 답하거나 「시작」만 답하면 기본값으로 갑니다. 네트워크가 막혀 있는 것처럼 감사를 막는 일이 하나 있으면 설정 안내를 먼저 보여 줍니다. 그 밖의 안내는 한 줄짜리 제안으로 최대 세 개까지 나오고, 그 단어로 답하면 열립니다.
2. **감사.** 명령 한 번으로 수집, 전용 헤드리스 크롬 렌더링, 속도 측정, 코드 판정을 끝냅니다. 사이트맵과 시작 쪽의 링크에서 쪽을 골라 상한까지 감사합니다. 기본은 50쪽이고 올리면 최대 200쪽입니다. 상한은 모든 요청을 세므로 리다이렉트와 robots·사이트맵 파일도 한도를 씁니다. 주소가 `www`나 `https` 쌍둥이 주소로 넘어가면 따라가고, 보고서에 그렇게 적습니다. 응답마다 해시와 함께 저장합니다.
3. **판정.** 코드가 판정할 수 없는 글 내용(주장, 답의 명확성, 최신성 등)은 에이전트가 읽고 판정합니다. 근거로 삼은 문장을 인용하고, 같은 명령을 한 번 더 실행하면 인용한 글이 증거 안에 실제로 있는지 확인한 뒤 점수를 냅니다.
4. **보고.** 내용이 같은 파일 셋이 나옵니다. `report.html`(먼저 여십시오. 파일 하나로 완결됩니다), `report.md`, `report.json`입니다. 글은 한국어입니다. 문제마다 고칠 것이 하나이고 영향을 주는 쪽수가 붙습니다. 구글 키가 없을 때처럼 비어 있는 칸은 번호를 매긴 단계로 채우는 법을 알려 줍니다. 비어 있는 칸은 통과가 아니라 「알 수 없음」으로 보입니다.
5. **수정과 재확인(선택).** 에이전트가 로컬 파일 수정안을 냅니다. 승인 없이 고치거나 배포하거나 검색엔진에 제출하지 않습니다. 배포한 뒤에는 같은 조건으로 다시 수집합니다. 그래서 수정 전후를 비교할 수 있습니다.

스크립트가 직접 재는 것과 가이드·에이전트 판단에 맡기는 것은 이렇게 나뉩니다.

| 기준 | 대상 | 스크립트가 재는 것 | 판단에 맡기는 것 |
|---|---|---|---|
| SEO | 구글과 웹 검색 | 응답 상태, meta와 `X-Robots-Tag`의 `noindex`, 제목, Googlebot용 robots.txt, canonical, 리다이렉트 단계, 링크·사이트맵으로 찾을 수 있는지, JSON-LD 문법 | 콘텐츠 품질, 검색 의도와 맞는지 |
| NEO | 네이버 | Yeti용 robots.txt, Open Graph, description, canonical, viewport, 제목 반복, 막힌 CSS·JS | 네이버 콘텐츠 가이드 |
| AEO, GEO | 답변 엔진과 AI 검색 | [ai-crawlers.md](skills/optbrew/references/ai-crawlers.md)에 적은 AI 검색 봇용 robots.txt(학습용 봇은 채점하지 않음) | 답변 구조, 주장, 작성자, 최신성 |
| LLMO | AI가 우리를 설명하는 방식 | 상호·주소·전화·설립 연도가 페이지끼리 일치하는지, 페이지들이 한 업체를 설명하는지 | 그 사실이 맞는지 |
| 전체 | 속도와 스크립트 | 자바스크립트가 돈 뒤에도 글이 보이는지(크롬). 구글 Chrome UX Report와 PageSpeed Insights의 방문자 실측 점수(LCP, INP, CLS) | 없음. 크롬으로 잰 실험실 값은 실행 조건으로만 보이고 채점하지 않습니다 |

엔진별 검사는 대상으로 밝힌 엔진에만 적용됩니다. ChatGPT·Claude·Perplexity처럼 신경 쓰는 AI 답변 엔진을 알려 주십시오. 목표에 네이버가 들어 있거나, 네이버 내보내기 파일을 주었거나, 사이트가 한국어이면 네이버는 저절로 대상이 됩니다. 구글은 항상 대상입니다. 채점 규칙은 [scoring.md](skills/optbrew/references/scoring.md)에 있습니다. 측정 범위 80% 기준은 optbrew가 정한 규칙이며, 검색엔진 표준이 아닙니다.

## 설치

[Node.js](https://nodejs.org) 22 이상이 필요합니다. Python 3.10 이상은 선택입니다. 없으면 내부 Python 감사 도구만 실행하지 않습니다. 아래 다섯 방법 중 하나를 고르십시오. 예시는 Codex와 Claude Code에 사용자 범위로 설치합니다. 에이전트 ID는 `codex`, `claude-code`, `cursor`, `opencode`, `pi`입니다.

Windows PowerShell에서 `npx`나 `optbrew`가 「스크립트를 실행할 수 없습니다」라고 하면 `npx.cmd`, `optbrew.cmd`로 바꿔 입력하십시오.

### 1. npm

```bash
npm install -g optbrew@0.2.0
optbrew install --agents codex,claude-code --scope user --dry-run
optbrew install --agents codex,claude-code --scope user
optbrew doctor --agents codex,claude-code --scope user
```

미리보기(`--dry-run`)는 쓸 폴더를 보여 줍니다. `doctor`는 파일과 해시를 확인합니다.

### 2. npx

전역 설치 없이 같은 CLI를 실행합니다.

```bash
npx optbrew@0.2.0 install --agents codex,claude-code --scope user
npx optbrew@0.2.0 doctor --agents codex,claude-code --scope user
```

### 3. PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/install.ps1 | iex
```

이 스크립트는 이번 버전에 고정돼 있습니다. Node.js를 확인하고, 설치할 폴더를 보여 주고, Codex와 Claude Code에 설치합니다. `doctor`가 문제를 찾으면 오류로 멈춥니다. 먼저 읽어 보거나 에이전트·프로젝트 폴더를 고르려면 이렇게 실행합니다.

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Agents codex,claude-code,cursor
```

한 프로젝트에만 설치하려면 `-Scope project -Project C:\path\to\site`를 붙입니다.

### 4. 플러그인

Claude Code:

```bash
claude plugin marketplace add nowwcastle-sudo/optbrew
claude plugin install optbrew@optbrew
```

Codex:

```bash
codex plugin marketplace add nowwcastle-sudo/optbrew
codex plugin add optbrew@optbrew
```

claude.ai, Claude Desktop, Cowork: Customize > Plugins에서 Add > Add marketplace를 고르고 `nowwcastle-sudo/optbrew`를 입력한 뒤 `optbrew`를 추가합니다.

플러그인은 이 저장소의 `main` 브랜치를 따르며, 업데이트는 각 호스트의 플러그인 명령이나 마켓플레이스 동기화로 합니다.

### 5. 에이전트에게 맡기기

Codex, Claude Code 같은 코딩 에이전트에 아래 글을 붙여 넣으십시오.

```text
optbrew 스킬을 설치해 줘. https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/AGENT_INSTALL.md 를 읽고 단계대로 따라 해. 어느 에이전트에, 어느 범위로 설치할지 먼저 묻고, 설치 전에 바뀔 내용을 보여 줘.
```

[AGENT_INSTALL.md](AGENT_INSTALL.md)는 단계마다 실행할 명령과 통과 기준, 멈추고 사용자에게 물어야 할 경우를 적어 둔 에이전트용 안내서입니다.

소스 checkout에서 설치하기, Agent Skills CLI, Pi 패키지, Claude 웹 업로드는 [플랫폼 안내](docs/platforms.md)에 있습니다.

## 빠른 시작

새 에이전트 세션을 열고 이렇게 요청합니다.

```text
https://example.com 에 optbrew 돌려 줘. 목표: 네이버 노출, AI 답변 인용.
```

optbrew는 환경을 점검한 뒤 시작 질문을 한 메시지로 보냅니다. 번호마다 답하거나 「시작」만 답하면 기본값으로 갑니다. 구글 키, 크롬, 내보내기 파일이 없어도 감사는 멈추지 않습니다. 빈 칸은 채우는 방법과 함께 보고서에 적힙니다.

감사에는 몇 분이 걸립니다. 결과는 작업 폴더의 `optbrew-audit/<사이트>-<날짜>`에 쌓입니다. 원본 근거(응답마다 해시)와 보고서 셋이 들어 있습니다. `report.html`을 먼저 여십시오. 같은 이름의 폴더가 있으면 `-2`, `-3`을 붙입니다. 사설 네트워크 주소는 로컬 대상으로 명시했을 때만 가져옵니다.

### 구글 API 키(선택)

무료 구글 API 키가 있으면 실제 방문자가 겪는 속도 점수(LCP, INP, CLS)가 채워집니다. optbrew가 권하면 「키」라고 답하십시오. 발급 방법이 나옵니다. 키는 대화창이 아니라 본인 터미널에서 저장하십시오. Codex나 Claude Code 클라우드에서는 키 안내가 저장할 곳을 대신 알려 줍니다.

```bash
optbrew key set google
optbrew key status
optbrew key remove google
```

`set`은 숨겨진 입력 창으로 키를 받습니다. `status`는 키가 있는지와 해시 앞 8자만 보여 줍니다. `remove`는 키를 지웁니다. npm CLI가 없으면 스킬 폴더의 같은 명령을 씁니다: `node <스킬 폴더>/scripts/key.mjs set google`. 키는 홈 폴더의 `.optbrew/credentials.json`에 저장되며 어느 프로젝트 안에도 들어가지 않습니다. 환경 변수 `OPTBREW_GOOGLE_API_KEY`가 있으면 그것이 먼저입니다. optbrew는 키를 요청 헤더로만 구글에 보내고, 보고서·로그·근거에는 쓰지 않습니다.

## 업데이트

```bash
npm install -g optbrew@latest
optbrew update --scope user
```

npx를 쓴다면 `npx optbrew@latest update --scope user`를 실행합니다. `optbrew check-updates --package optbrew`는 아무것도 바꾸지 않고, 지금 실행한 CLI보다 새 버전이 npm에 있는지 알려 줍니다. 에이전트 폴더에 설치된 버전은 `optbrew doctor --json`의 `release_version`에 나옵니다. `npm update`만으로는 에이전트 폴더에 이미 놓인 사본이 바뀌지 않습니다. 사본은 `update` 명령이 바꿉니다.

### 0.1.x에서 올리기

0.2.0은 평가 버전(0.4.0), 감사 프로토콜(0.2.0), 계약 스키마(2.0.0)를 바꿨습니다. 그래서 이렇습니다.

- 0.1.x 설치본(managed install)은 `migration_required`로 멈추며, `optbrew update`는 아무것도 바꾸지 않습니다. [migration_required 뒤 재설치](docs/platforms.md#reinstall-after-a-migration_required-update) 절차를 따르십시오. 이 절차는 읽기 전용 검사가 출력한 경로만 지우며, 감사 근거는 건드리지 않습니다.
- 플러그인 설치(Claude Code, Codex, claude.ai)는 `main`을 따라가므로, 쓰는 도구의 플러그인 업데이트 명령이 그대로 됩니다.
- 0.1.x 실행이 남긴 결과 폴더와 근거 묶음은 한 문장으로 거부됩니다. 새 폴더에서 감사를 다시 실행하십시오. 평가 버전이 다른 점수끼리는 비교할 수 없어서, 0.1.x 기준선과 `compare`하면 `not_comparable`이 나옵니다. 기준선 감사를 0.2.0으로 다시 돌리십시오.

## API와 비용

유료 계정 없이 쓸 수 있습니다. Anthropic API나 [SE Ranking](https://seranking.com/api.html)을 직접 호출하려면 먼저 사용자 승인, 예산 기록, 중단 조건이 있어야 합니다. Claude 구독에는 API 요금이 포함되지 않습니다. 위의 구글 키는 본인 키이고, 그 키로 부르는 구글 속도 서비스는 무료입니다. 키는 환경 변수나 키 파일에만 두며 보고서에는 넣지 않습니다. 자세한 내용은 [API 경계](skills/optbrew/references/api.md)를 보십시오.

## 문서

- [플랫폼 안내](docs/platforms.md): 에이전트별 설치 경로, checkout 명령, 재설치 절차
- [채점](skills/optbrew/references/scoring.md), [측정](skills/optbrew/references/measurement.md), [보고서 근거](skills/optbrew/references/report.md)
- [변경 기록](CHANGELOG.md), [출시 절차](docs/release.md)

## 기여

기여를 환영합니다. 버그 제보, 실제 사이트에서 나온 오판, 가이드 갱신, 번역, 코드 모두 좋습니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 보십시오.

## 라이선스

optbrew 자체 코드는 [MIT 라이선스](LICENSE)입니다. 포함된 가이드는 각자의 라이선스를 따르며, [제3자 고지](skills/optbrew/THIRD_PARTY_NOTICES.md)에 정리돼 있습니다. 네이버 묶음에는 공식 [서치어드바이저 가이드](https://searchadvisor.naver.com/guide) 색인만 있고, 원문 55편은 없습니다. 온라인에서 공식 링크를 따라가십시오.
