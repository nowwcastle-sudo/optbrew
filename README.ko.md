# optbrew

[English](README.md)

Optbrew는 웹사이트의 검색 준비도를 확인하고, 승인된 로컬 파일을 고친 뒤, 전후 근거를 비교하는 스킬과 CLI입니다. 고정된 원본 묶음 5개(mblode SEO, Naver Search Advisor, Firecrawl SEO Audit, Magnus SEO, SE Ranking SEO)와 선택한 마케팅 가이드 7개를 포함합니다. 최상위 `SKILL.md` 한 파일이 내부 가이드를 안내합니다. 실행 중에 바뀌는 upstream 파일을 가져오지 않습니다.

저장된 JSON으로 점수를 계산하고 보고서를 만드는 데 API 계정은 필요하지 않습니다. 사이트 감사에는 대상과 허용 범위가 필요합니다. 공개 게시, 검색엔진 제출, 원격 사이트 수정, 유료 호출은 각각 별도 권한이 필요합니다. 설치 파일이 놓인 상태와 호스트가 실제로 스킬을 호출한 상태는 [플랫폼 안내](docs/platforms.md)에서 구분합니다.

## 설치

Node.js 22 이상이 필요합니다. 내부 Python 감사 도구는 Python 3.10 이상이 필요합니다. Python이 없으면 그 도구는 미실행으로 남깁니다. 이 checkout에서 `site`라는 별도 프로젝트 폴더를 만든 뒤 실행합니다.

Bash와 PowerShell에서 같은 명령을 사용합니다.

```text
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --dry-run --json
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --json
node bin/optbrew.mjs doctor --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --json
```

저장소 루트에서 실행하십시오. 기본 전략은 `--strategy link`입니다. 링크를 쓸 수 없으면 `copy`를 선택할 수 있습니다. 관리 기록은 프로젝트의 `.optbrew/install`에 둡니다. 한 호스트만 설치하려면 목록 대신 `codex`, `claude-code`, `cursor`, `opencode`, `pi` 중 한 ID를 적습니다. 사용자 전체 범위에 설치할 때만 `--scope user`를 씁니다. 설치 명령은 번들 manifest를 확인하며 관리 대상이 아닌 기존 폴더를 덮어쓰지 않습니다.

checkout은 `https://github.com/nowwcastle-sudo/optbrew`를 clone해서 받고, 위 명령은 그 저장소 최상위에서 실행합니다. `npm install -g optbrew`로 설치하면 같은 CLI를 `optbrew` 명령으로 쓸 수 있습니다. 이때는 위 명령의 `node bin/optbrew.mjs`를 `optbrew`로 바꿉니다. 호스트 고유 설치와 ZIP은 [플랫폼 안내](docs/platforms.md)를 보십시오.

## 첫 실행

호스트에 optbrew를 사용하라고 요청할 때 대상 URL, 목표, 사이트 소유 또는 접근 권한, 허용할 로컬 변경, 보유한 근거를 전달합니다. 로컬 감사 전에 URL 범위를 선언합니다. 기본 수집 상한은 URL 50개, 깊이 3, 동시성 2입니다. 사설 주소는 명시한 로컬 대상에서만 허용합니다. 작업은 원시 근거, 준비도 관찰, 로컬 변경, 후속 확인을 기록합니다. 로컬 검증 통과를 운영 성과로 해석하지 않습니다.

다음 명령은 포함된 합성 fixture를 재생하며 제공자 호출을 하지 않습니다. 저장소 루트에서 새 출력 경로를 골라 실행합니다.

Bash와 PowerShell에서 같은 명령을 사용합니다.

```text
node bin/optbrew.mjs score --input ./before.json --output ./score.json
node bin/optbrew.mjs compare --before ./before.json --after ./after.json --output ./comparison.json
node bin/optbrew.mjs report --input ./remote-only.json --output-dir ./report-output
```

명령을 그대로 실행하려면 `tests/fixtures/scoring/before.json`, `after.json`을 현재 폴더로 복사합니다. `tests/fixtures/reports/remote-only.json`과 같은 폴더의 근거 파일도 함께 복사합니다. 실제 작업에서는 자신의 검증된 `ScoreInput` 또는 `ReportPacket` 경로를 넘깁니다. 계약은 [채점](skills/optbrew/references/scoring.md), [측정](skills/optbrew/references/measurement.md), [보고 근거](skills/optbrew/references/report.md)에 있습니다.

## 점수와 보고서

자체 준비도 프로필은 SEO, 네이버가 대상일 때 NEO, AEO, GEO, LLMO입니다. 고유 검사군 22개는 여러 가이드가 같은 문제를 찾아도 한 번만 셉니다. 확인하지 못한 적용 검사는 분모에 남기고, 근거 있는 `not_applicable` 검사만 제외합니다. 결과에는 점수, 측정 범위, 미측정 구간의 상·하한, 차단 요소, 미확인 핵심 검사가 들어갑니다. 측정 범위 80% 기준은 optbrew 자체 규칙이며 검색엔진 기준이 아닙니다. 높은 준비도 점수는 색인, 유입, 인용, 사실 정확성, 전환, 매출을 증명하지 않습니다.

감사 스크립트가 수집한 응답에서 스스로 관찰하는 항목은 다음과 같습니다. 응답 상태, meta 태그와 `X-Robots-Tag`의 색인 지시자(대상 엔진별), 제목 없음·중복, 선언한 엔진별 robots.txt 접근(Googlebot, Yeti, [`ai-crawlers.md`](skills/optbrew/references/ai-crawlers.md)의 AI 검색 봇. 학습 봇은 점수에 넣지 않음), canonical 대상과 리다이렉트 체인 길이, 링크 또는 선언한 사이트맵을 통한 발견성, JSON-LD 문법, 네이버 마크업(Open Graph, 설명, canonical, viewport, 제목 키워드 반복, 막힌 CSS·JS), 이름·주소·전화·설립연도의 페이지 간 일치입니다. 따라서 SEO와 NEO는 접근·색인·마크업 검사를 스크립트로 합니다. AEO와 GEO는 준비도 감사로 남습니다. 답변 구조, 주장 근거, 저자, 최신성은 가이드와 에이전트 판단이 필요합니다. LLMO는 페이지 간 불일치를 보여 주는 검사를 얻지만 사실이 맞다는 것을 증명하지는 않습니다. 심은 결함 시험과 한계는 저장소의 `docs/validation/detection-0.1.2.md`에 있습니다.

측정 범위가 80% 미만이면 보고서는 하나의 대표 점수를 내지 않고 측정된 부분의 값과 상·하한을 보여 줍니다. 모든 대표 점수는 측정 범위와 함께 표시됩니다.

보고서는 준비도, 해결 방안, 실제 성과, 남은 일을 별도 표로 보여 줍니다. 실제 성과에는 소유자 내보내기 자료 또는 고정된 AI 질문 패널이 필요합니다. 일반 성과 비교에는 정의와 필터가 같은 인접한 완결 28일 기간 두 개를 사용합니다. 로컬 수정은 배포와 운영 관찰의 근거가 생기기 전까지 로컬 수정입니다.

## API와 비용

API 사용은 선택 사항입니다. Claude 또는 Claude Code 구독에 Anthropic API 과금이 포함되는 것은 아닙니다. 직접 API 키는 [공식 발급 안내](https://platform.claude.com/docs/en/get-api-key)의 Console → Settings → API keys에서 만듭니다. 키는 자신의 셸 또는 비밀 관리 도구에서 `ANTHROPIC_API_KEY`로 설정합니다. 보고서에 실값을 넣지 마십시오. v0.1.0에서 도입한 직접 어댑터는 여러 Anthropic workspace에 걸친 키에 필요할 수 있는 `anthropic-workspace-id` 헤더를 여전히 설정하지 않습니다. 호환 키나 별도로 승인된 호스트 기능을 사용합니다.

직접 어댑터는 텍스트 `{model,max_tokens,messages}` 요청과 정확한 모델 ID `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`만 받습니다. `max_tokens` 상한은 128,000입니다. 매 시도에는 `1,000,000 + max_tokens` 이상의 토큰 예약 한 개, 맞는 장부 예산, 승인 참조가 필요합니다. 이 예약은 최악 경우의 용량 상한이며 예상 청구액이 아닙니다. 첫 유료 호출 전에 현재 단가의 출처와 날짜, 예상 지출, 승인된 중단 조건을 기록합니다. 추가 필드, 도구, 검색, 비텍스트 입력, 다른 모델, 통화만으로 설정한 상한은 직접 호출 전에 거부됩니다. 자세한 경계는 [API 안내](skills/optbrew/references/api.md)에 있습니다.

SE Ranking은 별도의 [API](https://seranking.com/api.html), [MCP 안내](https://seranking.com/api/integrations/mcp), 계정 상품, 크레딧을 사용합니다. [HTTP MCP 주소](https://api.seranking.com/mcp)는 문서에 따른 OAuth 또는 직접 토큰 경로를 씁니다. `ANTHROPIC_API_KEY`와는 별개입니다. 사용 가능한 도구는 구독에 따라 달라집니다. 오프라인 채점에는 어느 연결도 필요하지 않습니다. 유료 기능을 결정할 때 실제 계정의 단가와 크레딧을 확인합니다.

## 업데이트와 복원

관리 설치를 갱신하려면 먼저 검증된 새 optbrew 번들을 빌드하거나 받습니다. 저장소 루트에서 다음 명령을 실행합니다.

Bash와 PowerShell에서 같은 명령을 사용합니다.

```text
node bin/optbrew.mjs check-updates --json
node bin/optbrew.mjs update --scope project --project ./site --json
node bin/optbrew.mjs rollback --scope project --project ./site --release-version 0.1.0 --json
```

`check-updates --package optbrew`는 npm 레지스트리에서 최신 버전을 읽습니다. `--package`를 빼면 `local_only`를 반환합니다. `update`는 현재 CLI 번들을 검증한 뒤 관리 기록의 모든 대상에 적용합니다. 로컬 편집은 자동으로 덮어쓰지 않습니다. `rollback`은 관리 기록에 해당 이전 버전이 남아 있어야 합니다. 새 0.1.2 설치에서는 위 복원 예시가 실패하며, 로컬 0.1.0을 보존한 관리 설치에 적용됩니다. 출시 후 `npm update -g optbrew`는 npm 패키지를 갱신하지만 이전에 agent 스킬 폴더로 복사한 파일까지 바꾸지는 않습니다. CLI를 갱신한 다음 관리 `update`를 다시 실행합니다. 관리 중인 0.1.1 설치는 0.1.2로 갱신할 수 없고 `update`가 `migration_required`로 멈춥니다(아래 재설치 절차). 호스트 고유 갱신은 [플랫폼 안내](docs/platforms.md)를 보십시오.

### migration_required 뒤 재설치

0.1.2는 평가 버전 0.2.0을 사용합니다(0.1.1은 0.1.0). 그래서 0.1.1로 만든 점수와 기준선은 0.1.2와 비교할 수 없고 `compare`는 `not_comparable`을 반환합니다. 기준선 감사는 0.1.2로 다시 실행하십시오. 같은 이유로 관리 중인 0.1.1 설치에서 `optbrew update`를 실행하면 `migration_required`로 멈추고 아무것도 바꾸지 않으며, 메시지에 아래 경로와 명령이 나옵니다. `uninstall` 명령은 없습니다. 관리 루트와 `install-record.json`에 적힌 대상을 지운 뒤 0.1.2 저장소 루트에서 `install`을 다시 실행하는 방식으로 교체합니다. 이 명령은 `.optbrew/runs`(감사 증거)를 건드리지 않습니다. `.optbrew` 폴더 전체를 지우지 마십시오. 자세한 설명은 [플랫폼 안내](docs/platforms.md)를 보십시오.

사용자 범위:

```powershell user
$ErrorActionPreference = 'Stop'
$root = Join-Path $HOME '.optbrew/installs/user'
$record = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'install-record.json') | ConvertFrom-Json
Remove-Item -Recurse -Force -LiteralPath $root
foreach ($t in $record.targets) { Remove-Item -Recurse -Force -LiteralPath $t.path }
foreach ($t in $record.targets) { node bin/optbrew.mjs install --agents $t.agent --scope user --strategy $t.strategy; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
node bin/optbrew.mjs doctor --agents (($record.targets | ForEach-Object agent) -join ',') --scope user
exit $LASTEXITCODE
```

```bash user
set -e
root="$HOME/.optbrew/installs/user"
rows=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targets.map(t=>[t.agent,t.strategy,t.path].join("|")).join("\n")' "$root/install-record.json")
rm -r -- "$root"
while IFS='|' read -r agent strategy target; do rm -r -- "$target"; done <<< "$rows"
while IFS='|' read -r agent strategy target; do node bin/optbrew.mjs install --agents "$agent" --scope user --strategy "$strategy"; done <<< "$rows"
node bin/optbrew.mjs doctor --agents "$(cut -d'|' -f1 <<< "$rows" | paste -sd, -)" --scope user
```

프로젝트 범위(`./site`를 프로젝트 폴더로 바꾸십시오. 한 곳에만 나옵니다):

```powershell project
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path './site').Path
$root = Join-Path $project '.optbrew/install'
$record = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'install-record.json') | ConvertFrom-Json
Remove-Item -Recurse -Force -LiteralPath $root
foreach ($t in $record.targets) { Remove-Item -Recurse -Force -LiteralPath $t.path }
foreach ($t in $record.targets) { node bin/optbrew.mjs install --agents $t.agent --scope project --project $project --strategy $t.strategy; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
node bin/optbrew.mjs doctor --agents (($record.targets | ForEach-Object agent) -join ',') --scope project --project $project
exit $LASTEXITCODE
```

```bash project
set -e
project="$(cd "./site" && pwd)"
root="$project/.optbrew/install"
rows=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targets.map(t=>[t.agent,t.strategy,t.path].join("|")).join("\n")' "$root/install-record.json")
rm -r -- "$root"
while IFS='|' read -r agent strategy target; do rm -r -- "$target"; done <<< "$rows"
while IFS='|' read -r agent strategy target; do node bin/optbrew.mjs install --agents "$agent" --scope project --project "$project" --strategy "$strategy"; done <<< "$rows"
node bin/optbrew.mjs doctor --agents "$(cut -d'|' -f1 <<< "$rows" | paste -sd, -)" --scope project --project "$project"
```

## 지원 범위와 라이선스

관리 설치·검사·갱신·복원은 문서화된 기본 경로의 Codex, Claude Code, Cursor, OpenCode, Pi를 대상으로 합니다. 호스트의 사용자 지정 경로, 프로젝트 신뢰 설정, 세션 재시작 조건은 탐색 결과를 바꿀 수 있습니다. 일반 ChatGPT 채팅에서는 파일을 첨부해 안내형으로 사용합니다. 이는 Codex나 Work/desktop 플러그인 설치와 다릅니다. Claude 웹에서는 ZIP을 직접 올리고 갱신 때 다시 올립니다. 호스트 탐색과 실제 호출 성공은 따로 확인해야 합니다.

네이버 묶음은 [Search Advisor 공식 안내](https://searchadvisor.naver.com/guide)의 색인을 포함합니다. 네이버 원문 55개는 제외했으므로 전문을 오프라인에서 읽을 수 없습니다. 온라인에서 공식 링크를 여십시오. 포함한 원본의 라이선스와 변경 내역은 [제삼자 고지](skills/optbrew/THIRD_PARTY_NOTICES.md)에 있습니다. optbrew 자체 코드는 [MIT 라이선스](LICENSE)입니다. 서비스 접근권과 API 자료 이용권은 코드 라이선스와 별개입니다. 묶음 생성·검증 절차는 [릴리스 안내](docs/release.md)에 있습니다.
