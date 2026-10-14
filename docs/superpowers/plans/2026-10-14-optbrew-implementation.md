# optbrew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 추천한 5개 묶음을 포함하는 optbrew를 제작하고, 근거가 있는 감사·로컬 개선·전후 평가·보고와 다중 플랫폼 설치·업데이트를 검증한다.

**Architecture:** `skills/optbrew/`가 유일한 스킬 원본이다. 내부 모듈은 GUIDE로 배포하고, 결정적 계산과 수집 경계는 스킬 내부의 Node 모듈에 둔다. npm CLI와 호스트별 플러그인은 이 원본을 사용하며 설치 기록·비용 기록·감사 자료는 번들 밖에 보존한다.

**Tech Stack:** Node.js 22+ ESM, `node:test`, Node 내장 라이브러리, Python 3.10+ 표준 라이브러리, Agent Skills, OpenAI portable plugin schema 1.0.0, Claude Code plugin, npm·Pi package metadata. v0.1.0 자체 CLI의 runtime dependency는 0개다.

**Spec:** [승인된 설계서](../specs/2026-10-13-optbrew-design.md), [출처·배포 경계](../specs/2026-10-13-optbrew-sources.md), [설계 승인 기록](../specs/2026-10-14-optbrew-approval.md).

상태: 작성 구현 계획의 사용자 검토 대기. 작성일: 2026-10-14, Asia/Seoul. 이 문서는 앞으로 만들 파일과 검증을 정의한다. 계획 작성은 제품 시험·설치·공개 게시의 통과를 뜻하지 않는다.

## Global Constraints

- 기본 동작은 **감사 → 로컬 개선 → 검증**이다. 게시·운영 수정·검색엔진 제출·외부 콘텐츠 발행은 별도 실행 권한을 확인한다.
- 유료 API는 **비용이 드는 첫 실행에서 예상 비용과 한도를 결정**한다. 값이 없는 단가를 0원으로 쓰지 않는다.
- Node 22 이상, 내부 Python 감사 도구는 Python 3.10 이상. Python이 없으면 가능한 호스트 capability를 사용하고 실행하지 않은 도구는 미실행으로 표시한다.
- 추천 5개와 기존 선택 7개는 실제 파일로 포함한다. 실행 중 upstream HEAD를 받아 섞거나 다른 스킬의 설치를 필수로 요구하지 않는다.
- 최상위 SKILL은 1개다. 내부 SKILL은 GUIDE로 매핑하고 frontmatter를 제거한다. 계산·보고 코드도 `skills/optbrew/` 안에 포함한다.
- 네이버 `references/guide/` 원문 55개는 제외한다. 자체 INDEX의 공식 URL로 연결하고 전문 오프라인 조회의 손실을 고지한다.
- MIT·ISC 원문의 저작권·허가문과 변경 고지를 보존한다. 자체 코드는 MIT다. 서비스 이용 조건과 API 자료의 이용권은 별도다.
- 비공개 SNS 카드 본문, 사용자 감사 자료, 계정 설정, API 키, authoring 스킬은 공개 패키지에 포함하지 않는다.
- 공개 수집 기본값은 **최대 50 URL, 깊이 3, 동시성 2**다. localhost·사설 주소는 명시한 로컬 대상에서만 허용한다.
- AI 패널 기본값은 **엔진별 10개 이상 질문 × 3회**다. 고유 질문 10개 미만은 탐색 관찰이다. 반복 답변을 독립 표본으로 가정하지 않는다.
- 실제 성과 기본 창은 **완결된 28일 대 이전 28일**이다. 실제 색인·검색 성과·AI 답변 정확성은 준비도 점수에 합산하지 않는다.
- 준비도는 22개 고유 family와 승인 설계서의 5축·5프로필을 사용한다. unknown은 분모에 포함하고 not_applicable만 제외한다.
- `100N/M`, `100M/A`, `[100N/A, 100(N+A−M)/A]`를 계산한다. M=0이면 점수 null, A=0이면 프로필 not_applicable이다. 표시할 때만 소수점 한 자리로 반올림한다.
- CWV는 실제 방문 75백분위 자료를 사용한다. LCP ≤2500ms / >4000ms, INP ≤200ms / >500ms, CLS ≤0.1 / >0.25 사이의 자체 q는 0.5다.
- blocker·핵심 정책 unknown을 높은 점수로 숨기지 않는다. 80% 측정 범위와 점수 구간은 optbrew 자체 운영 기준이다.
- 전후 환경·표본·조건·평가 버전이 다르면 같은 기준으로 원자료를 재계산하거나 not_comparable을 반환한다.
- `report.md`와 `report.json`에 점수, 해결 방안, 실제 성과, 남은 작업 표를 제공한다. local 검증을 production 성과로 표시하지 않는다.
- npm postinstall·자동 인증·자동 유료 호출·예약 측정·백그라운드 업데이트 서비스를 만들지 않는다.
- npm version, Git tag, 플러그인 version, ZIP 이름을 일치시킨다. 평가 버전과 관측 프로토콜 버전은 별도 필드다.
- README.md는 영어, README.ko.md는 한국어다. humanize-korean·kill-ai-slop을 적용하며 명령·URL·비용·지원 제한의 의미를 보존한다.
- GitHub 공개 저장소 생성·push와 npm publish는 산출물 검토 후 최종 실행 권한을 확인한다. 이번 구현 계획은 그 권한을 부여하지 않는다.
- 실행 시 현재 좌표를 재확인한다. 기존 원본 편집 전 `_백업_원본_*`으로 보존한다. 각 커밋은 검증 → 비밀값 검사 → 명시적 staging 순서다.

## Review Focus

1. Markdown 수집에서 JSON-LD가 사라진 경우: schema 부재를 확정하지 않고 raw HTML capability와 근거를 요구한다. Task 5·6의 시험으로 고정한다.
2. 공유 도메인의 경로·외부 리다이렉트·private IP·DNS 변경: 허용한 URL 경계 밖으로 수집이 확장되지 않는다. Task 5의 시험으로 고정한다.
3. 높은 점수와 핵심 unknown, 수정 뒤 적용 조건 변경: 준비 완료를 표시하거나 분모 변경을 개선량으로 제출하지 않는다. Task 3·4의 시험으로 고정한다.
4. 동시 유료 요청과 응답 전 중단: 예약 비용을 이중 소비하거나 미확정 청구를 0으로 취소하지 않는다. Task 5의 시험으로 고정한다.
5. Windows junction·공백/한글 경로·사용자 편집·업데이트 중 종료: 다른 스킬과 사용자 설정을 보존하고 검증된 이전 버전으로 복원한다. Task 8·9의 시험으로 고정한다.

---

## 파일 구조와 책임

한 릴리스가 같은 원본·평가 계약을 배포하므로 계획을 여러 독립 제품으로 나누지 않는다. 작업별 산출물은 따로 검증하고, 그 인터페이스를 아래에 고정한다. 모든 상대 경로는 optbrew 저장소 루트 기준이다.

| 경로 | 책임 | 작업 |
|---|---|---|
| package.json, package-lock.json, .gitignore, .gitattributes, LICENSE | CLI 진입점·패키지 범위·LF 계약·자체 라이선스 | 1 |
| scripts/vendor.mjs, scripts/vendor.config.json, scripts/patches/ | 고정 ref의 선택 파일·참조 폐쇄·변환·보정 | 1·2 |
| skills/optbrew/modules/{mblode-seo,naver-searchadvisor,firecrawl-seo-audit,magnus-seo,seranking-seo,marketing-search}/ | 외부 모듈 6묶음의 코드·GUIDE·참고파일 | 1·2·5 |
| skills/optbrew/licenses/, skills/optbrew/source-lock.json, skills/optbrew/THIRD_PARTY_NOTICES.md | ZIP에도 들어가는 라이선스·파일 출처·변경 기록 | 1·10 |
| skills/optbrew/references/schemas/contract.schema.json | RunContext 등 9개 엔티티와 ScoreInput의 기계 판독 계약 | 3 |
| skills/optbrew/references/check-registry.json, profiles.json, scoring.md | 22개 family·조건·분배·산식 | 3 |
| skills/optbrew/scripts/core/{contracts,protocol,weights,score}.mjs | 입력 검증·고정 프로토콜·결정적 채점 | 3 |
| skills/optbrew/scripts/core/{compare,metrics,bootstrap}.mjs, references/measurement.md | 전후 비교·성과 정의·질문 군집 구간 | 4 |
| skills/optbrew/scripts/core/{scope,collector,capabilities,cost-ledger}.mjs | 수집 경계·자료 capability·호출 전 예산 예약 | 5 |
| skills/optbrew/scripts/adapters/{anthropic,imports}.mjs, references/api.md | 선택적 직접 API와 내보내기 정규화 | 4·5 |
| skills/optbrew/scripts/core/{findings,report}.mjs, references/remediations.json, report.md | 발견 병합·근거별 해결책·기계/사람 보고 | 6 |
| skills/optbrew/scripts/{cli,audit}.mjs | ZIP의 계산 명령과 문맥을 요구하는 내부 감사 실행 | 3~6 |
| skills/optbrew/SKILL.md, agents/openai.yaml, references/{intake,routing,evidence,policies}.md | 발동·접수·모듈 선택·권한·완료 지침 | 7 |
| bin/optbrew.mjs, lib/{cli,paths,install,doctor}.mjs, scripts/build-bundle.mjs, skills/optbrew/scripts/core/bundle.mjs | npm 설치·검사·번들 manifest·내부 계산 명령 전달 | 8 |
| lib/{update,records,transaction}.mjs | 설치 기록·업데이트·손상 감지·복원 | 9 |
| plugin.json, .codex-plugin/plugin.json, .claude-plugin/{plugin,marketplace}.json | 같은 스킬·버전의 호스트별 배포 어댑터 | 10 |
| scripts/{build-release,verify-release,scan-secrets}.mjs, scripts/validate-plugin.py, docs/validation/plugin.schema.json, skills/optbrew/bundle-manifest.json | npm·ZIP·manifest 생성과 범위/해시/비밀 검사 | 1·8·10 |
| README.md, README.ko.md, CHANGELOG.md, docs/{platforms,release}.md | 실제 배포 상태·설치·API·갱신·공개 절차 | 11 |
| tests/*.test.mjs, tests/python/test_magnus.py, tests/fixtures/, evals/scenarios.json | 정상·실패 대조군·실행 결과의 판정 기준 | 해당 작업·12 |
| docs/validation/{implementation,skill-judge,release-readiness}.md | 완료 조건별 증거와 지원 범위 | 12 |

`dist/`, `.optbrew/`, `_백업_원본_*`, 실제 감사 산출물과 테스트의 임시 설치는 Git/npm 파일 목록에서 제외한다. 라이선스와 source-lock은 스킬 폴더 안의 파일이 정본이다. 루트 배포 고지는 build가 정본에서 생성한다.

## 공통 인터페이스

영속 엔티티의 타입 이름은 `contract.schema.json`의 `$defs`와 각 함수의 JSDoc에서 일치시킨다. 지역 함수의 반환 타입은 각 Interfaces와 아래 표에 정의한다. JSON에 NaN·Infinity·undefined·비밀값은 허용하지 않는다. 식별자는 문자열이며 날짜는 timezone을 가진 ISO 8601이다. 최초 schema_version은 1.0.0, release_version·evaluation_version·protocol_version은 각각 별도 필드의 0.1.0이다.

| 타입 | 최소 필드/불변식 |
|---|---|
| RunContext | schema_version, run_id, target, environment, goals, allowed_changes, scope, protocol, evaluation_version, protocol_version, data_sources, cost_decision, evidence_ref |
| CheckObservation | schema_version, observation_id, check_id, family_id, unit_key, state, q, partial_basis, reason, evaluator_type, source_ref, evidence_ref. unknown/N/A의 q는 null |
| MetricObservation | schema_version, metric_id, value_state, value, numerator, denominator, definition, filters, window, panel_hash, provider_definition, sample_selection, source_ref, evidence_ref |
| Finding | schema_version, finding_id, check_id, unit_key, priority, blocker, message, source_ref, evidence_ref, remediation_ids, status |
| ChangeRecord | schema_version, change_id, finding_ids, environment, path, before_hash, after_hash, backup_ref, verification, evidence_ref |
| CostLedger | schema_version, run_id, budgets, reservations, settlements, approval_ref, source_ref. 단위가 다른 한도를 합치지 않음 |
| ScoreResult | schema_version, evaluation_version, profile, A, M, N, score, coverage, missing_bounds, band, readiness_status, blockers, unknown_core, source_ref |
| ReportPacket | schema_version, run_context: RunContext, baseline: {input: ScoreInput, scores: ScoreResult[]}, after: null 또는 같은 구조, comparison: ComparisonResult, metrics: MetricObservation[], findings: Finding[], changes: ChangeRecord[], costs: CostLedger, remaining, evidence_index, source_ref |
| InstallRecord | schema_version, scope_id, release_version, bundle_hash, source, managed_root, targets, file_hashes, previous_releases, transaction, source_ref |
| ScoreInput | schema_version, run_context, observations. 표본·적용 조건은 run_context.protocol에 고정 |

`state`는 pass / partial / fail / unknown / not_applicable이다. partial_basis는 threshold_half 또는 ratio이며 ratio는 정수 분자·양의 정수 분모를 요구한다. pass=1, fail=0, partial=0.5 또는 정의한 비율이다. `value_state`는 measured / unknown / zero_or_missing / not_applicable이다.

프로토콜에는 page_types와 URL 목록·고정 가중치, family 적용 조건, engine별 관찰 단위, 질문·브랜드/비브랜드 범주, 지역·언어, 표면·모델·검색 사용, 장비·브라우저, 환경, 평가·관측 버전을 포함한다. URI는 원문과 정규화 값을 함께 보존한다. hash에는 비교에 필요한 조건을 넣고 run_id·수집 시각·증거 파일 경로는 넣지 않는다.

| 반환 타입 | 공유하는 필드 |
|---|---|
| ParsedRobots | groups: [{agents: string[], rules: [{type,path}]}], sitemaps: string[] |
| FetchArtifact | requested_url, normalized_url, final_url, status, headers, redirect_chain, raw_html_ref, content_hash, capability, source_ref, evidence_ref, error. 저장 headers는 쿠키/인증값을 제외 |
| CollectionResult | artifacts: FetchArtifact[], discovered_count, evaluated_count, skipped: [{url,reason}], limit_reached |
| AuditResult | context_ref, artifacts: FetchArtifact[], observations: CheckObservation[], module_outputs, evidence_ref |
| CapabilityPlan | selected: [{capability,provider,tool_ref,cost_enforcement}], missing: string[], limitations: string[] |
| Reservation | reservation_id, provider, upperBounds: [{unit,currency,amount}], status, approval_ref. amount는 비음수 정수 |
| ProviderObservation | provider, surface, model, search_enabled, request_id, response_ref, usage, valid, error, evidence_ref |
| RemediationSelection | remediation_id, check_id, selected, reason, source_ref, module_ref, validation, required_authority |
| InstallTarget | agent, path, strategy, managed_target |
| InstallResult | status, record: InstallRecord 또는 null, changed_paths: string[], decision, verification |
| DoctorResult | scope_id, targets: [{agent,path,file_present,hash_ok,registered,session_discovery,invocation_verified}], warnings: string[] |
| BundleVerification | status, checked_files, errors: [{path,code}], bundle_hash |
| UpdateStatus | current_version, latest_version 또는 null, status, source_ref |
| RecoveryResult | status, restored_version 또는 null, unresolved_paths: string[], evidence_ref |
| ReleaseArtifacts | version, skill_zip, npm_tarball 또는 null, plugin_root, hashes. npm_tarball은 pack 전에는 null |
| VerificationReceipt | status, checked_files, artifact_hashes, errors: [{path,code}], source_ref |
| HostReceipts | host, host_version, scenarios: [{scenario_id,command,exit_code,discovery_status,invocation_status,artifact_hashes,verdict,limitations}], evidence_ref |

### Task 1: 출처가 고정된 내부 번들과 라이선스

**Files:** Create: `package.json`, `package-lock.json`, `.gitignore`, `.gitattributes`, `LICENSE`, `scripts/vendor.mjs`, `scripts/vendor.config.json`, `scripts/scan-secrets.mjs`, `skills/optbrew/source-lock.json`, `skills/optbrew/THIRD_PARTY_NOTICES.md`, `skills/optbrew/licenses/`와 위 modules의 선택 파일. Test: `tests/vendor.test.mjs`, `tests/secret-scan.test.mjs`.

**Interfaces:** Consumes: 설계서3절의 repo·commit·선택 파일·고지. Produces: `vendor({sourcesRoot, outputRoot, configPath, patchSet}): Promise<SourceLock>`; `scanSecrets({root, files}): Promise<{checked, findings:[{path,line,rule}], exitCode}>`. SourceLock에는 module_id·repo·commit·license·license_blob_sha·upstream_path·package_path·original_sha256·distributed_sha256·transformations·patch_reason·excluded_files를 기록한다. 스캔 결과는 일치한 실값을 출력하지 않는다.

- [ ] **Step 1: 선택 파일 시험을 작성한다.** `vendor.test.mjs`는 6개 module_id, 추천 5개 포함, 기존 7개·SE Ranking 13개 GUIDE의 존재, GUIDE frontmatter 부재, 누락 없는 상대 참조, 고지의 원문 해시를 검증한다. 정상 라이선스 대조군과 `references/guide/` 원문을 넣은 실패 대조군을 함께 둔다.
- [ ] **Step 2: 시험을 실행해 실패를 보존한다.** Run: `node --test tests/vendor.test.mjs tests/secret-scan.test.mjs`. Expected: 구현/번들 부재로 실패. 비밀 검사는 가짜 키 4종을 가진 임시 파일에서 findings가 나오고, 일반 공개 SHA에서는 나오지 않음을 요구한다.
- [ ] **Step 3: 고정 소스의 선택 파일을 번들로 변환한다.** 로컬 스냅샷의 HEAD와 blob을 아래 ref에 대조한다. 없는 공식 소스는 해당 commit으로 별도 작업 폴더에 가져온다. cache를 원본으로 쓰지 않는다. SKILL→GUIDE·상대 링크 매핑과 제외 이유를 기록한다. scripts·references의 전이 참조는 폐쇄될 때까지 포함하되 경로 탈출·라이선스 불명 파일은 릴리스 실패로 남긴다.

| module_id | repo와 ref | 선택 루트 |
|---|---|---|
| mblode-seo | mblode/agent-skills @872bc83bdb6dd54a9ff456fbf1181beea6db7875 | skills/seo |
| naver-searchadvisor | JaceProgramming/naver-searchadvisor-expert @cd95f6281090416b3dfbf15fb0f66f0ffa67a19c | 자체 SKILL·scripts·tools·references/INDEX·LICENSE·NOTICE |
| firecrawl-seo-audit | firecrawl/firecrawl-workflows @94cc91229d6cedc0613f140d3d013b150bc8e1b0 | skills/firecrawl-seo-audit |
| magnus-seo | magnus919/agent-skills @2e8fb962819b2b01b270620f92f0cc7213d77ef1 | seo |
| seranking-seo | seranking/seo-skills @fd6d1408f2e6a06454d81c07c29e0f04342eb9ba | 설계서3절의 13개 skills·전이 참조 |
| marketing-search | coreyhaines31/marketingskills @5b2c0007766c6a1cf1d53fd8fc73e979e0821022 | 공식 v2.11.1의 설계서3절 7개 skills·전이 참조 |

로컬 스냅샷 루트는 `../work/seo-alternatives/sources`다. 네이버 폴더명은 `JaceProgramming__naver-seo-expert`지만 공식 ref·원격 identity로 확인한다. SE Ranking의 `scripts/google_auth.py`, `extensions/google/install.sh`, `extensions/firecrawl/install.sh` 참조는 자동 실행하지 않는다. 배포 GUIDE의 실행 안내를 optbrew capability/API 경로로 보정하고 원래 설치 스크립트는 활성 배포 경로에서 제외한 매핑을 남긴다. 필요한 읽기용 도구 코드의 별도 라이선스를 확인한다.
- [ ] **Step 4: 변환과 라이선스 시험을 통과시킨다.** Run: `node scripts/vendor.mjs --sources-root ../work/seo-alternatives/sources`; `node --test tests/vendor.test.mjs tests/secret-scan.test.mjs`. Expected: 종료 0, 6개 고지 일치, 금지 원문 0, 재귀 SKILL 0, 상대 참조 누락 0. 원문에 다른 선택 skill 링크가 있으면 포함된 GUIDE나 optbrew routing으로 이유를 기록해 매핑한다.
- [ ] **Step 5: 검증된 번들을 커밋한다.** `node scripts/scan-secrets.mjs --tracked-and-staged`가 종료 0일 때 이 작업의 Files만 `git add`하고 `git commit -m 'feat: bundle pinned search modules with license provenance'`를 실행한다. 원본 해시·제외 목록의 readback을 증거로 보존한다.

### Task 2: 알려진 robots·HTML 파서 결함 보정

**Files:** Create: `skills/optbrew/modules/naver-searchadvisor/scripts/robots.mjs`, `scripts/patches/naver-robots.patch`, `scripts/patches/magnus-html.patch`. Modify: `modules/naver-searchadvisor/scripts/audit.mjs`, `modules/magnus-seo/scripts/aeo_audit.py`(모두 skills/optbrew 아래), `source-lock.json`. Test: `tests/parsers.test.mjs`, `tests/python/test_magnus.py`, `tests/fixtures/parsers/`.

**Interfaces:** Consumes: Task1의 Naver/Magnus 배포 파일·SourceLock·patchSet. Produces: `parseRobots(text): ParsedRobots`; `robotsVerdict(parsed, agent, path): {allowed,reason,matched_rules}`. Python의 기존 `audit(source: str) -> dict` 출력 호환을 보존하고 `audit_html(html: str, source: str) -> dict`를 추가한다. Naver audit는 pure robots 모듈을 사용한다. 자동 fetch는 Task5의 경계 어댑터로 교체한다.

- [ ] **Step 1: 기존 실패와 정상 대조군 시험을 작성한다.** 반복 Yeti 두 그룹에서 `/private/`는 차단, 더 긴 `/private/public/`는 허용이어야 한다. 동일 길이는 Allow 우선, wildcard는 일치 Yeti 그룹이 없을 때만 사용한다. JSON-LD 최상위 배열·@graph·@type 배열, `<h1>How <em>does</em> it work?</h1>`, 정상 JSON·무효 JSON을 각각 검사한다.
- [ ] **Step 2: upstream 고정본에서 실패를 재현한다.** Run: `node --test tests/parsers.test.mjs`; `python -m unittest discover -s tests/python -p test_magnus.py -v`. Expected: 반복 그룹 및 JSON 배열/인라인 제목 사례에서 실패, 정상 단순 객체/허용 경로는 통과. 실패의 코드·입력·종료값을 기록한다.
- [ ] **Step 3: 순수 판정과 HTML 상태 관리를 보정한다.** RFC 9309의 일치 그룹 병합·경로 옥텟/percent encoding·긴 규칙·Allow 동률·주석·빈 Disallow를 처리한다. Magnus는 배열에 `.get()`을 호출하지 않고 JSON-LD에 해당하는 script만 읽으며 제목/heading의 중첩 텍스트·여러 data chunk·style/script의 비가시 텍스트를 분리한다. 순수 import가 CLI 요청을 시작하지 않게 한다.
- [ ] **Step 4: 보정 시험과 원본/배포 해시를 확인한다.** 위 두 명령 Expected: 종료 0. `script` 안의 가짜 HTML·일반 script 텍스트·손상 JSON은 별도 결과다. 이 파서의 구조 진단을 공식 정책 위반이나 인용 효과 판정으로 그대로 승격하지 않는다.
- [ ] **Step 5: 재현·보정·고지를 함께 커밋한다.** 비밀 검사 후 위 Files만 stage하고 `git commit -m 'fix: merge robots groups and parse nested AEO markup'`. vendor 재생성에서 보정이 재적용되고 distributed hash가 일치해야 한다.

### Task 3: 입력 계약·고정 표본·준비도 계산기

**Files:** Create: `skills/optbrew/references/schemas/contract.schema.json`, `check-registry.json`, `profiles.json`, `scoring.md`, `skills/optbrew/scripts/core/contracts.mjs`, `protocol.mjs`, `weights.mjs`, `score.mjs`, `skills/optbrew/scripts/cli.mjs`. Test: `tests/contracts.test.mjs`, `tests/scoring.test.mjs`, `tests/fixtures/scoring/`.

**Interfaces:** Consumes: 설계서6절의 family·적용 조건·프로필·산식. Produces: `validateEntity(typeName, value): value`(오류 시 ContractError); `freezeProtocol(context): {protocol,protocol_hash}`; `compileUnits(input: ScoreInput, profile): WeightedUnit[]`; `scoreWeighted(units): {A,M,N,score,coverage,missing_bounds}`; `score(input): ScoreResult[]`. WeightedUnit은 `{key,family_id,engine,url,weight,state,q}`다. CLI: `node skills/optbrew/scripts/cli.mjs score --input <file> --output <file>`.

- [ ] **Step 1: 손계산·판정 경계 시험을 작성한다.** 아래 assert를 넣고, M=0·A=0·N/A 축·잘못된 q·미선택 URL·동일 unit의 충돌을 검사한다.

```js
assert.equal(scoreWeighted(weightedCase(100, 80, 58)).score, 72.5);
assert.equal(scoreWeighted(weightedCase(100, 80, 58)).coverage, 80);
assert.deepEqual(scoreWeighted(weightedCase(100, 80, 58)).missing_bounds, [58, 78]);
assert.equal(scoreWeighted(allUnknown).score, null);
assert.equal(scoreWeighted(allNotApplicable).A, 0);
assert.equal(score(noindexBlocker)[0].readiness_status, 'blocked');
assert.equal(score(unknownCorePolicy)[0].readiness_status, 'unverified');
```

`weightedCase`는 테스트가 만드는 명시적 unit 배열이다. mock이 계산 함수의 반환값을 대신하지 않는다. 통과한 동일 문제를 두 모듈에서 보내도 점수가 늘어나지 않아야 한다.
- [ ] **Step 2: 계약·채점 시험 실패를 확인한다.** Run: `node --test tests/contracts.test.mjs tests/scoring.test.mjs`. Expected: 계산/검증 모듈 부재로 실패.
- [ ] **Step 3: 승인된 22 family·프로필과 계산기를 구현한다.** 설계서6절의 모든 family_id·적용 조건·q·requirement_class를 입력 규칙으로 옮긴다. profiles는 SEO [30,20,15,20,15], NEO [35,30,10,15,10], AEO [20,20,10,35,15], GEO [25,15,5,30,25], LLMO [10,10,0,30,50]다. 종합은 SEO 기본 가중치이며 프로필 평균을 내지 않는다.

분배 순서는 축 → 적용 family → 적용 엔진 → 고정 페이지 유형/URL이다. N/A 단위만 해당 family 안에서 제외해 정규화한다. origin·사이트 단위에는 페이지 수를 곱하지 않는다. 예정 단위의 관찰 누락은 unknown이다. 미등록 관찰과 상충 결과는 조용히 평균하지 않고 계약 오류로 반환한다. float 오차는 계산 내부에서 비교 tolerance 1e-9를 쓰고 최종 표시만 반올림한다. `readiness_status`는 blocked / unverified / provisional / measured / not_applicable이다. measured는 검색 성과 보장이 아니다.
- [ ] **Step 4: 분배·CWV·CLI 재계산을 검증한다.** Run: 위 시험 명령과 `node skills/optbrew/scripts/cli.mjs score --input tests/fixtures/scoring/partial.json --output .optbrew/test-score.json`. Expected: 종료 0, 고유 family 22개, 모든 프로필 합 100, 4개 설계 합성 예 일치. URL 복제·유형별 페이지 수 차이는 점수를 왜곡하지 않는다. 정확한 CWV 경계와 자료 없는 성능 unknown을 확인한다.
- [ ] **Step 5: 계약·계산기를 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: score readiness with fixed coverage and missing bounds'`.

### Task 4: 비교·네이티브 지표·AI 패널 평가

**Files:** Create: `skills/optbrew/scripts/core/compare.mjs`, `metrics.mjs`, `bootstrap.mjs`, `skills/optbrew/scripts/adapters/imports.mjs`, `skills/optbrew/references/measurement.md`. Modify: `contract.schema.json`, `scripts/cli.mjs`. Test: `tests/compare.test.mjs`, `tests/metrics.test.mjs`, `tests/fixtures/metrics/`.

**Interfaces:** Consumes: Task3의 `validateEntity(typeName,value)`, `score(input)`, `freezeProtocol(context)`와 ScoreInput. Produces: `compare(before: ScoreInput, after: ScoreInput): ComparisonResult`; `normalizeImport(provider, rows, metadata): MetricObservation[]`; `measurePanel(panel, responses, evaluations): MetricObservation[]`; `clusterBootstrap({questionIds, valuesByQuestion, seed, iterations=2000, confidence=0.95}): {interval,method,seed,iterations,unique_questions}`. ComparisonResult는 `{status,score_deltas,reasons}`이며 status는 comparable / not_comparable / no_after다. score_deltas는 raw difference이며 비율은 percentage_point_delta와 relative_change를 별도 필드로 둔다.

- [ ] **Step 1: 비교 불가·결측·표본 편향 시험을 작성한다.** URL·페이지 유형·적용 조건·질문·엔진·모델·환경·평가 버전 변경은 not_comparable과 이유를 반환해야 한다. 같은 기준의 사전 원자료 재계산은 별도 evaluation_version 결과로 보존한다. 이전 값 0의 relative_change는 null이다. Google 표시 `~`·`-`와 마스크 없는 AI export의 0은 zero_or_missing이며 positive_only는 전체 인용률의 분모가 될 수 없다.
- [ ] **Step 2: 시험 실패를 확인한다.** Run: `node --test tests/compare.test.mjs tests/metrics.test.mjs`. Expected: 비교/지표 어댑터 부재로 실패.
- [ ] **Step 3: 정의를 보존하는 정규화와 비교를 구현한다.** GSC·GA4·Google AI·Bing AI·Naver·SE Ranking은 provider_definition, property·hostname·검색 유형·장치·국가·기간·시간대·집계·수집 시각을 보존한다. 원자료가 제공하지 않는 값은 unknown이다. 완결된 날짜와 명시한 timezone으로 28일 창을 만든다. 조회/내보내기는 자료 소유자의 권한 안에서만 사용한다.

AI 패널은 인용·엔티티 언급·인용 지지·사실 일치·브랜드 점유·관측 완료를 각각 계산한다. 사실 목록이나 인용 접근이 없으면 해당 평가 unknown과 평가 범위를 남긴다. 10질문×3회의 30계획응답 중 유효24·대상인용6이면 인용 응답률25%, 관측 완료율80%다. 2000회·seed 고정 군집 bootstrap은 question_id를 재표집한다. 같은 seed의 재현성과 모든 질문값이 같을 때 점구간을 검사한다. 작은 표본에는 유의성 주장을 내보내지 않는다. API Claude·Claude 웹·검색 없는 API 응답을 다른 surface로 유지한다.
- [ ] **Step 4: 시나리오와 CLI 비교를 검증한다.** Run: 위 명령; `node skills/optbrew/scripts/cli.mjs compare --before tests/fixtures/scoring/before.json --after tests/fixtures/scoring/after.json --output .optbrew/test-compare.json`. Expected: 종료 0, 예상 절대 변화와 비교 상태 일치. 측정되지 않은 기간·전환·성과에 개선 수치를 만들지 않는다.
- [ ] **Step 5: 비교와 측정 계약을 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: compare protocols and preserve outcome measurement limits'`.

### Task 5: 공개 수집 경계·capability·선택적 유료 호출

**Files:** Create: `skills/optbrew/scripts/core/scope.mjs`, `collector.mjs`, `capabilities.mjs`, `cost-ledger.mjs`, `skills/optbrew/scripts/adapters/anthropic.mjs`, `skills/optbrew/scripts/audit.mjs`, `skills/optbrew/references/api.md`. Modify: Naver `audit.mjs`, Magnus `aeo_audit.py`, 관련 GUIDE/preflight 참조와 보정 파일·source-lock. Test: `tests/collector.test.mjs`, `tests/cost-ledger.test.mjs`, `tests/capabilities.test.mjs`, `tests/adapters.test.mjs`.

**Interfaces:** Consumes: Task3의 RunContext·CostLedger·`validateEntity(typeName,value)`, Task2의 `audit_html(html,source)`·robots 함수. Produces: `assertInScope(url, scope, resolvedAddresses): URL`; `fetchScoped(url, {context,transport,resolve,timeoutMs=20000,maxBytes=5242880,maxRedirects=10}): Promise<FetchArtifact>`; `collect(context, {transport,resolve}): Promise<CollectionResult>`; `selectCapabilities(available, requirements): CapabilityPlan`; `reserveCost(ledgerPath, {provider,upperBounds,approvalRef}): Promise<Reservation>`; `settleCost(ledgerPath, reservationId, actualOrUnknown): Promise<CostLedger>`; `requestAnthropic({context,request,env,transport,ledgerPath}): Promise<ProviderObservation>`; `runAudit({context,modules,outputDir}): Promise<AuditResult>`.

audit 명령은 `node skills/optbrew/scripts/audit.mjs --context <run-context.json> --modules naver-searchadvisor,magnus-seo --output-dir <run-dir>`다. 수집 원자료와 모듈 출력은 같은 run의 evidence에 저장한다. 결정적으로 측정할 수 있는 registry 항목만 관찰로 만들고, 의미 판단·실제 방문 자료 부재는 unknown으로 남긴다. 원본의 단순 warning을 optbrew 감점으로 그대로 변환하지 않는다.

- [ ] **Step 1: 수집·비용 실패 대조군을 작성한다.** 51URL 입력은50만 수집하고 깊이4·동시3은 허용하지 않는다. 공유 도메인의 `/owned/` 외 링크, 다른 host·private 주소로 redirect, DNS public→private 변환은 요청 전에 차단한다. 명시한 localhost 정상 대조군을 둔다. raw JSON-LD는 존재하지만 Markdown에는 없는 자료에서 structured-data-truth를 fail로 만들지 않는다.

비용 cap10에 upperBound6인 동시 예약 두 개 중 하나만 허용한다. timeout·과금 불명은 예약 상한을 점유한 채 settlement unknown으로 남긴다. 첫 비용 미결정·상한 미확정·키 부재에는 provider 호출0이다. 오류 응답의 키 문자열은 로그에 남지 않아야 한다.
- [ ] **Step 2: 모의 transport 시험 실패를 확인한다.** Run: `node --test tests/collector.test.mjs tests/cost-ledger.test.mjs tests/capabilities.test.mjs tests/adapters.test.mjs`. Expected: 모듈 부재로 실패. 시험은 인터넷이나 유료 API를 호출하지 않는다.
- [ ] **Step 3: 범위와 예산을 강제하는 어댑터를 구현한다.** URL scheme은 HTTP(S), userinfo는 거절한다. host·포트·경로 구간의 경계와 모든 redirect를 검사한다. public transport는 해석한 IP에 연결을 고정하고 TLS hostname 검증을 보존한다. 검사 뒤 재해석하는 fetch만으로 DNS 변경 방지를 주장하지 않는다. IP 정책은 loopback·private·link-local·ULA·mapped IPv4를 포함한다. 로컬 허용도 명시한 host·포트에 제한한다. 응답 크기·시간·redirect·URL·깊이·동시성을 같은 context로 제한한다.

Naver와 Magnus의 optbrew 경로는 이 collector가 보존한 HTML/응답을 입력으로 사용한다. leaf script의 직접 원격 인자는 유효한 scope context 없이는 요청을 시작하지 않는다. 원본 Yeti UA는 실제 봇 접근 증거가 아니며, 봇별 응답 관찰이라는 범위를 남긴다. Firecrawl·호스트 MCP는 제공 capability와 비용 한계를 먼저 확인한다. 허용 경계·한도를 보장하지 못하는 bulk crawl은 사용하지 않는다.

CostLedger는 atomic mkdir lock·예약 ID·원자 파일 교체를 사용한다. stale lock은 자동 해제하지 않는다. 단위는 credits / tokens / search_calls / currency_minor와 통화로 구분한다. 직접 호출은 시도마다 상한을 예약하고 최대2시도·각20초로 제한한다. 미확정 과금·재시도도 비용에 포함한다. MCP 비용을 코드로 잠글 수 없으면 보고서에 enforcement=host_policy를 표시한다. Anthropic model·검색 도구는 사용자가 선택한 현행 공식 API 형식으로만 전달하고 다른 모델로 자동 대체하지 않는다. 키는 환경변수 존재 여부만 확인한다.
- [ ] **Step 4: 경계·동시성·오류 처리를 검증한다.** 위 시험 Expected: 종료 0. 403·429·손상 JSON·중간 종료를 확인하고, 무료 자료 수집이 계속되는지 검사한다. 의도적으로 scope 검사/비용 예약을 생략하는 변이를 격리 복사본에 적용해 두 안전 시험이 실패함을 증명하고 원본 GREEN을 복원한다. 실제 유료 호출은 가격·한도 결정이 없으면 미실행으로 남긴다.
- [ ] **Step 5: 수집과 비용 경계를 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: bound collection and reserve paid API budgets'`.

### Task 6: 문제 병합·해결책 선정·완성 보고서

**Files:** Create: `skills/optbrew/scripts/core/findings.mjs`, `report.mjs`, `skills/optbrew/references/remediations.json`, `report.md`, `tests/fixtures/reports/`. Modify: `scripts/cli.mjs`, `contract.schema.json`. Test: `tests/findings.test.mjs`, `tests/report.test.mjs`.

**Interfaces:** Consumes: Task3의 `score(input)`·계약, Task4의 `compare(before,after)`·MetricObservation, Task5의 CapabilityPlan·CostLedger. Produces: `mergeFindings(findings): Finding[]`; `selectRemediations(finding, {context,capabilities,catalog}): RemediationSelection[]`; `buildReport(packet: ReportPacket): {json,markdown}`; `writeReport(packet, outputDir): Promise<{jsonPath,markdownPath}>`. CLI: `report --input <packet.json> --output-dir <directory>`. catalog에는 remediation_id·check_id·적용 조건·근거 URL/조회일·module_ref·실제 수정 기제·검증 방법·비용/노력·권한을 둔다.

- [ ] **Step 1: 보고서의 원자료 연결 시험을 작성한다.** 같은 URL·check·문제를 두 모듈이 보내면 Finding1개와 출처2개를 남긴다. noindex blocker는 높은 점수보다 먼저 표시하고, local 검증·미배포·API 미연결·확인 안 됨은 완료로 바꾸지 않는다. 전후 숫자는 Task3 재계산과 같아야 한다. 파이프·HTML·줄바꿈을 가진 제목과 근거는 표 구조를 깨뜨리지 않는다.
- [ ] **Step 2: 시험 실패를 확인한다.** Run: `node --test tests/findings.test.mjs tests/report.test.mjs`. Expected: 보고/해결 모듈 부재로 실패.
- [ ] **Step 3: 근거와 적용 조건으로 해결책을 선별한다.** 공식 문서→관련 재현→연구→확인한 사례→가설의 순서를 보존한다. P0 접근·의도하지 않은 색인 차단·중대한 사실 오류, P1 핵심 목표/템플릿, P2 제한된 개선, P3 실험으로 정한다. SEO 상승률은 생성하지 않는다. 가정한 준비도 상승은 실제 after가 아닌 별도 scenario로 표시한다.

보고서는 설계서8절의 점수·해결·실제 성과·남은 작업 표를 모두 생성한다. finding→check→source/evidence→remediation→change→verification 연결의 누락은 계약 오류다. 원격 전용에는 수정 위치·패치안·검증 절차를 제공하고 상태를 제안만으로 남긴다. JSON의 환경·비교 상태·결측 범위는 Markdown에도 보인다. 증거 경로는 run 디렉터리 안으로 제한하고 비밀/개인정보를 첨부하지 않는다.
- [ ] **Step 4: 보고서 CLI와 손계산을 대조한다.** Run: 위 시험; `node skills/optbrew/scripts/cli.mjs report --input tests/fixtures/reports/remote-only.json --output-dir .optbrew/test-report`. Expected: 두 파일 생성, 종료0, 합성 예라는 표기와 원자료 재계산 일치. Markdown-only 수집은 schema 미확인 상태를 보존한다. 파일만 존재하는 것을 보고 성공으로 판정하지 않는다.
- [ ] **Step 5: 보고·해결 카탈로그를 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: link scored findings to verified remediation reports'`.

### Task 7: 발동·접수·상황별 모듈 라우팅

**Files:** Create: `skills/optbrew/SKILL.md`, `skills/optbrew/agents/openai.yaml`, `skills/optbrew/references/intake.md`, `routing.md`, `evidence.md`, `policies.md`, `scripts/patches/policies.patch`, `evals/scenarios.json`. Modify: 보정한 내부 GUIDE와 참조 매핑·source-lock. Test: `tests/skill-bundle.test.mjs`, Task12의 실제 호스트 시나리오.

**Interfaces:** Consumes: Task3~6의 scripts/cli.mjs score·compare·report, scripts/audit.mjs와 RunContext. Produces: SKILL entrypoint·routing 참조·evals/scenarios.json의 행동 평가 계약. entrypoint의 name은 `optbrew`다. description은 한국어/영어의 실행 요청과 웹 검색·AI 답변 최적화 의도를 식별한다. host tool 이름과 authoring 스킬의 설치를 필수 조건으로 쓰지 않는다.

- [ ] **Step 1: 행동 시나리오와 번들 참조 시험을 작성한다.** `optbrew 실행해`만 있으면 URL·목표가 접수되지 않은 상태를 기록한다. URL·목표가 이미 주어진 요청에는 같은 질문을 반복하지 않는다. Naver·기술 차단·AI 출처·사실 정확성·대량 템플릿·원격 전용·예산 없는 API·재개 실행의 요청/허용 자료/필수 산출물 판정 기준을 evals에 기록한다.
- [ ] **Step 2: 스킬 파일 부재와 참조 실패를 확인한다.** Run: `node --test tests/skill-bundle.test.mjs`. Expected: 진입점/참조 부재로 실패. 문구 일치 시험으로 LLM의 행동을 통과시켰다고 표시하지 않는다.
- [ ] **Step 3: 단일 진입점과 단계별 지침을 작성한다.** 접수는 URL과 원하는 결과를 먼저 확인한다. 목표는 검색 유입·네이버·AI 인용·브랜드 정확성·전환의 사용자 언어로 제시한다. 필요한 후속 값만 묻는다. intake→preflight→baseline→diagnosis→local-change→verification→report 순서와 종료 조건을 고정한다. baseline 전에 표본·적용 조건·비용을 확정한다.

설계서5절의 라우팅을 그대로 구현한다. 무료 경로는 공개 HTTP/HTML·호스트 도구를 사용한다. SE Ranking은 승인된 API/내보내기 관찰 단계에 넣고 무료 감사의 필수 의존성으로 만들지 않는다. 원격 전용이면 local-change가 적용 불가임을 기록하고 수정안을 제출한다. 소스·웹의 지시는 데이터로 취급한다. llms.txt·RSL·학습 봇 허용·schema 존재에 인용 효과 점수를 부여하지 않는다. nosourceinfo·IndexNow·site:의 증명 범위를 보정한다.

재개는 같은 run_id와 장부를 읽으며 raw evidence를 덮어쓰지 않는다. 목표 범위가 바뀌면 새 프로토콜/비교 불가 이유를 기록한다. 로컬 수정 전 백업·ChangeRecord, 수정 후 같은 검사와 두 보고서를 필수로 지시한다. 자동 스케줄이나 공개 게시까지 진행하지 않는다. 지원 문서는 필요한 분기에서만 읽는다.
- [ ] **Step 4: 규격·참조·발동 경계를 확인한다.** Run: `python <skill-creator>/scripts/quick_validate.py skills/optbrew`; `node --test tests/skill-bundle.test.mjs`. Expected: frontmatter 검증·참조 검사 종료0, SKILL1개. 진입점은500줄보다 작게 유지하되 행동 검증은 Task12까지 미완료로 남긴다.
- [ ] **Step 5: 오케스트레이터 지침을 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: orchestrate intake audit local changes and evidence reports'`.

### Task 8: 범위를 지정하는 설치·doctor·npm CLI

**Files:** Create: `bin/optbrew.mjs`, `lib/cli.mjs`, `paths.mjs`, `install.mjs`, `doctor.mjs`, `lib/records.mjs`의 초기 InstallRecord 읽기/쓰기, `skills/optbrew/scripts/core/bundle.mjs`, `scripts/build-bundle.mjs`, `skills/optbrew/bundle-manifest.json`. Modify: `package.json`. Test: `tests/cli.test.mjs`, `tests/install.test.mjs`, `tests/doctor.test.mjs`.

**Interfaces:** Consumes: Task3의 InstallRecord, Task3~6의 scripts/cli.mjs, Task7의 완성 스킬 폴더. Produces: `createBundleManifest({bundleRoot,releaseVersion}): Promise<BundleManifest>`; `verifyBundle({bundleRoot,manifest}): Promise<BundleVerification>`; `main(argv, {stdout,stderr,env,cwd}): Promise<number>`; `resolveTargets({agents,scope,home,projectRoot}): InstallTarget[]`; `install({bundleRoot,agents,scope,home,projectRoot,dryRun}): Promise<InstallResult>`; `doctor({agents,scope,home,projectRoot}): Promise<DoctorResult>`; `readInstallRecord(scopeRoot): Promise<InstallRecord|null>`; `writeInstallRecord(scopeRoot, record): Promise<void>`. BundleManifest는 version·파일 allowlist·distributed hash·자신을 제외한 정렬 목록의 bundle_hash다.

CLI 계약은 install·doctor·check-updates·update·rollback·score·compare·report다. `--agents codex,claude-code`로 대상을 명시하고 `--scope user|project`, project는 `--project <path>`를 받는다. `--home <path>`는 격리 시험/사용자의 별도 환경에만 명시적으로 사용한다. install/doctor는 `--json`, install은 `--dry-run`을 지원한다. 계산 명령은 Task3/4/6에 전달한다. 동작 가능한 인자 오류는 종료2, 파일/환경 실패는 종료1, 성공은0이다.

- [ ] **Step 1: 격리 설치·충돌·부작용 시험을 작성한다.** 한글/공백/괄호 경로에 설치하고 기존 `seo/`·사용자 설정의 hash가 같음을 확인한다. dry-run은 설치 기록/디렉터리/링크를 만들지 않는다. 미선택 agent 경로는 수정하지 않는다. 타인이 만든 optbrew·범위 밖으로 가는 junction·손상 bundle은 거절한다. doctor는 file_present / registered / session_discovery / invocation_verified를 별도 값으로 낸다.
- [ ] **Step 2: 시험 실패를 확인한다.** Run: `node --test tests/cli.test.mjs tests/install.test.mjs tests/doctor.test.mjs`. Expected: CLI/설치 구현 부재로 실패.
- [ ] **Step 3: 관리 원본과 선택한 호스트 경로를 구현한다.** user의 관리 루트는 `<home>/.optbrew/installs/user/`, project는 `<projectRoot>/.optbrew/install/`다. 저장한 검증 bundle에 host 경로를 연결한다. Windows는 관리 디렉터리 junction, Unix는 symlink를 사용한다. 링크를 사용할 수 없으면 오류/선택 근거를 보이고 명시한 copy 모드에서만 복사하며 전략을 기록한다.

예정 경로는 Codex `.agents/skills/optbrew`, Claude Code `.claude/skills/optbrew`, Cursor `.cursor/skills/optbrew`, OpenCode user `.config/opencode/skills/optbrew` / project `.opencode/skills/optbrew`, Pi user `.pi/agent/skills/optbrew` / project `.pi/skills/optbrew`다. 각 현행 공식 문서를 대조한 뒤 paths에 고정한다. 공통 `.agents`를 다른 호스트도 발견할 수 있음을 doctor에서 설명한다. 선택하지 않은 플랫폼의 등록·성공으로 확대하지 않는다.

설치 경로·실제 realpath·관리 파일 집합을 확인한다. 디렉터리 전체를 임의로 삭제/이동하지 않는다. secrets·config·runs는 관리 bundle 밖이다. SKILL 설치가 모델 계정·MCP를 등록하지 않는다. CLI 계산은 네트워크와 모델 계정 없이 작동한다.

같은 scope의 추가 install은 기존 targets를 보존하고 선택한 target만 추가한다. 다른 version을 install로 기존 공통 bundle에 교체하지 않는다. 그 경우 명시적인 update 경로를 안내한다. 초기 설치도 scope lock·atomic record 쓰기로 동시 실행의 충돌을 감지한다. copy 전략은 `--strategy copy`로만 선택하고 기본 link 실패를 조용히 복사로 바꾸지 않는다.
- [ ] **Step 4: 격리 CLI를 확인한다.** Run: `node scripts/build-bundle.mjs --bundle skills/optbrew --version 0.1.0`; 위 시험; `node bin/optbrew.mjs install --agents codex,claude-code --scope user --home .optbrew/test-home --dry-run --json`. Expected: manifest 생성 후 dry-run은 선택2개·dry_run=true·쓰기0. 실제 격리 install 후 doctor의 hash·경로는 확인되지만 새 세션 호출은 아직 not_verified다.
- [ ] **Step 5: 설치 어댑터를 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: install optbrew into selected agent scopes'`.

### Task 9: 업데이트·사용자 편집 감지·rollback

**Files:** Create: `lib/update.mjs`, `transaction.mjs`. Modify: `lib/records.mjs`, `cli.mjs`, `doctor.mjs`. Test: `tests/update.test.mjs`, `tests/rollback.test.mjs`, `tests/fixtures/releases/`.

**Interfaces:** Consumes: Task8의 `verifyBundle({bundleRoot,manifest})`·InstallRecord 읽기/쓰기·InstallTarget. Produces: `checkUpdates({packageName,currentVersion,registryTransport}): Promise<UpdateStatus>`; `update({bundleRoot,recordRoot,localChanges='abort',faultHook}): Promise<InstallResult>`; `rollback({recordRoot,releaseVersion,faultHook}): Promise<InstallResult>`; `recoverTransaction(recordRoot): Promise<RecoveryResult>`.

`update`는 현재 실행하는 검증된 npm/플러그인 번들 버전을 적용한다. 최신 npm 패키지 획득은 `npx --yes optbrew@<version> update ...`가 담당한다. CLI가 임의 tar 다운로드/실행 또는 upstream 동기화를 추가하지 않는다. `check-updates`는 registry version만 읽고 파일을 바꾸지 않는다. registry 패키지명이 미확정이면 로컬-only 상태를 반환한다.

- [ ] **Step 1: 손상·편집·중단의 복원 시험을 작성한다.** v0.1.0→합성v0.1.1 성공, manifest/hash 손상·사용자 파일 편집·비관리 링크는 기존 설치/설정 hash를 보존한다. staging 이후·첫 target 전환 이후·record 교체 이전에 fault를 주입한다. 재실행은 journal을 읽어 검증된 이전 release를 복원하거나 명확한 recovery_required를 낸다. 정상 rollback 후 version·내용·doctor가 일치해야 한다.
- [ ] **Step 2: 시험 실패를 확인한다.** Run: `node --test tests/update.test.mjs tests/rollback.test.mjs`. Expected: update/rollback 구현 부재로 실패.
- [ ] **Step 3: 검증→준비→전환→readback 트랜잭션을 구현한다.** scope lock과 durable journal을 사용한다. 같은 볼륨의 staging에서 파일 범위·source-lock·bundle hash·버전·매핑을 검사한 뒤 targets를 전환한다. 실패 시 기록된 이전 상태로 복원한다. 이전 snapshot은 자동 정리하지 않는다. Windows move 대상은 해석한 절대 관리 경로 안인지 직전에 확인한다.

로컬 변경은 기존 기록 hash와 비교한다. 기본 abort이며 사용자가 선택한 `--local-changes backup-and-replace`일 때만 `_백업_원본_*`을 만들고 교체한다. 충돌 파일과 백업을 기록한다. 수정한 rollback snapshot·다른 사용자의 경로·손상 InstallRecord는 임의로 신뢰하지 않는다. 호환되지 않는 schema/evaluation 변화는 migration_required와 안내를 낸다. rollback은 검증된 이전 bundle을 적용하며 keys·config·runs를 건드리지 않는다.
- [ ] **Step 4: 업데이트 실패와 실제 readback을 검증한다.** 위 시험 Expected: 종료0. 격리 복사본에서 edit detection을 생략하는 변이를 적용하면 사용자 편집 보존 시험이 실패해야 한다. 실제 faultHook 호출·손상 hash가 적용됐다는 기록을 남기고 원본 GREEN을 복원한다. 부분 전환이 성공으로 보고되지 않는지 확인한다.
- [ ] **Step 5: 업데이트 계약을 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'feat: verify managed updates and restore prior releases'`.

### Task 10: npm·ZIP·OpenAI·Claude·Pi 릴리스 산출물

**Files:** Create: `scripts/build-release.mjs`, `scripts/verify-release.mjs`, `scripts/validate-plugin.py`, `docs/validation/plugin.schema.json`, `requirements-dev.txt`, `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, 루트 `THIRD_PARTY_NOTICES.md`, `source-lock.json` 생성본. Modify: `skills/optbrew/bundle-manifest.json`, `package.json`, `package-lock.json`. Test: `tests/release.test.mjs`, `tests/fixtures/plugins/`.

**Interfaces:** Consumes: Task8의 `createBundleManifest({bundleRoot,releaseVersion})`·`verifyBundle({bundleRoot,manifest})`, Task1의 SourceLock·고지. Produces: `buildRelease({root,version,outputDir}): Promise<ReleaseArtifacts>`; `verifyRelease({root,artifacts}): Promise<VerificationReceipt>`. root portable schema는 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`이고 OpenAI 확장은 `extensions.com.openai`다. Claude와 Codex overlay는 같은 `skills/optbrew`와 release_version을 가리킨다. Pi package metadata는 현행 공식 pi package 규격에 맞춘다.

- [ ] **Step 1: 배포 내부 목록·버전·독립 ZIP 시험을 작성한다.** npm tar 목록과 ZIP에서 추천5개·기존7개·SE13개·고지·공통 scripts가 존재해야 한다. SKILL은 optbrew 루트1개, 네이버 원문·private 자료·tests·백업·run 자료는0이다. SHA를1개 변조하면 검증 실패다. README의 참조와 GUIDE 상대 경로가 ZIP 밖을 요구하지 않아야 한다.
- [ ] **Step 2: 시험 실패를 확인한다.** Run: `node --test tests/release.test.mjs`. Expected: release builder/manifest 부재로 실패.
- [ ] **Step 3: 같은 원본에서 manifest와 패키지를 생성한다.** manifest는 파일별 distributed hash와 release/evaluation/protocol version을 기록한다. bundle hash는 자신을 제외한 정렬된 경로·hash 목록으로 계산한다. npm files allowlist를 사용하고 자체 lifecycle의 설치/인증/외부 호출은 넣지 않는다. ZIP의 최상위는 `optbrew/`다. ZIP 생성은 제작 환경의 Python 표준 라이브러리를 사용할 수 있고, 설치/계산 CLI에 Python을 필수로 만들지 않는다.

공식 plugin JSON Schema를 현재 출처에서 `docs/validation/plugin.schema.json`에 보존한다. `scripts/validate-plugin.py`는 jsonschema의 `validator_for(schema)`·`check_schema`·`iter_errors`로 전체 규격을 검증한다. 제작용 `requirements-dev.txt`는 jsonschema>=4.18,<5를 선언하고 사용한 버전·전이 라이선스를 영수증에 기록한다. 현재 이 환경에는 jsonschema가 있지만 제품 runtime dependency는 아니다. 없으면 격리 dev 환경에 설치하며 부분 필드 검사로 full schema 통과를 대신하지 않는다. 아직 미정인 GitHub owner·npm 계정·remote URL에는 확인되지 않은 실제 주소를 넣지 않는다. 로컬 marketplace는 로컬 source로 검증한다. 공개 metadata 생성은 Task12의 실제 계정 확인 이후다.
- [ ] **Step 4: 산출물을 만들고 독립 실행한다.** Run: `node scripts/build-release.mjs --version 0.1.0 --output-dir dist`; `python scripts/validate-plugin.py --schema docs/validation/plugin.schema.json --manifest plugin.json`; `npm pack --ignore-scripts --json --pack-destination dist`; `node scripts/verify-release.mjs --dist dist`; `node --test tests/release.test.mjs`. Expected: 종료0, manifest 버전/해시 일치, 금지 파일0. ZIP만 임시 폴더에 풀고 그 안의 `scripts/cli.mjs score`와 report를 실행해 npm lib 경로 없이 통과해야 한다. 본 시험은 Claude 웹 업로드/실행 시험을 대신하지 않는다.
- [ ] **Step 5: 생성 규칙·manifest를 커밋한다.** 비밀 검사 후 위 source Files만 stage하고 `git commit -m 'feat: build versioned skill plugin and npm release artifacts'`. dist는 커밋하지 않고 검증 hash를 증거에 보존한다.

### Task 11: 한국어·영어 README·API·플랫폼별 갱신 문서

**Files:** Create: `README.md`, `README.ko.md`, `CHANGELOG.md`, `docs/platforms.md`, `docs/release.md`. Modify: `skills/optbrew/references/api.md`. Test: `tests/docs-commands.test.mjs`; 윤문 원문/결과/의미 대조는 공개 패키지 밖의 작업 증거 폴더에 보존한다.

**Interfaces:** Consumes: Task8~10의 실제 CLI·호스트 manifest·release 상태, Task3~6의 점수/보고 예. Produces: 양언어 README·API 안내·플랫폼별 지원/갱신표. 소개→설치→첫 실행→점수/보고서 예→API/비용→업데이트→지원 범위→라이선스 순서를 일치시킨다. 문서 명령은 각 shell과 released/local-only 상태를 표시한다. API 안내는 키 실값 없이 공식 발급/인증 경로를 설명한다.

- [ ] **Step 1: 명령 추출·격리 실행의 판정 기준을 작성한다.** 공개 설치 명령은 패키지/저장소가 실제 공개되기 전에는 출시 후 명령으로 표시한다. 로컬 실행은 checkout에서 `node bin/optbrew.mjs` 또는 검증 tarball로 확인한다. 모든 문서에 나온 CLI 인자와 설치 범위는 dry-run/fixture로 실행되고 알 수 없는 옵션이 없어야 한다.
- [ ] **Step 2: 문서/CLI 불일치 시험을 실행한다.** Run: `node --test tests/docs-commands.test.mjs`. Expected: 문서 부재로 실패. 텍스트 heading을 맞추는 시험으로 기능·문체를 인증하지 않는다.
- [ ] **Step 3: 실제 지원 경계와 API 경로를 작성한다.** Vercel Skills·Pi·npm과 공식 agent README의 구성만 참고하고 문장/성과를 복제하지 않는다. Claude API는 `https://platform.claude.com/docs/en/get-api-key`와 Console Settings→API keys, `ANTHROPIC_API_KEY`를 안내한다. SE Ranking은 `https://seranking.com/api.html`, `https://seranking.com/api/integrations/mcp`, `https://api.seranking.com/mcp`와 구독/credits·OAuth/직접 토큰 차이를 안내한다. 호스트 구독과 API 과금을 구분한다. Bash와 PowerShell의 환경변수 예시는 placeholder만 사용한다.

Codex·Claude Code·Cursor·OpenCode·Pi의 관리 install/update/rollback 명령, 공식 native plugin/skills/Pi 설치의 현재 문법, Claude 웹 ZIP 재업로드를 안내한다. 일반 ChatGPT Chat은 첨부 안내형 사용이며 Work/desktop plugin과 동일 설치/갱신을 약속하지 않는다. plugin auto-update는 사용자 설정이고 marketplace 파일만으로 켜지지 않는다. `npm update`가 과거 agent 복사본을 갱신하지 않는 이유와 관리 update 명령을 명시한다. 내장5개·보정·네이버 원문 제외·자체 점수·미측정 처리·성과 한계도 설명한다.
- [ ] **Step 4: 윤문과 의미 보존을 검증한다.** humanize-korean으로 README.ko.md를 윤문하고 kill-ai-slop을 두 README에 적용한다. 명령·URL·수치·비용·라이선스·제한을 원문과 대조한다. Run: `node --test tests/docs-commands.test.mjs`. Expected: 지원한 명령 정상, 해석 불가/미출시 상태를 숨긴 명령0. 문체 검사는 사람/모델 판단 범위를 기록한다.
- [ ] **Step 5: 실제 명령과 문서를 커밋한다.** 비밀 검사 후 이 Files만 stage하고 `git commit -m 'docs: explain bilingual installation APIs scores and updates'`.

### Task 12: 행동 검증·두 호스트 설치·공개 준비 검토

**Files:** Create: `tests/workflow.test.mjs`, `tests/fixtures/sites/`, `scripts/run-host-scenarios.mjs`, `docs/validation/implementation.md`, `skill-judge.md`, `release-readiness.md`. Modify: 확인된 실제 실패에 필요한 최소 파일·CHANGELOG·release metadata. 로컬 설치 파일은 Git 밖에 기록한다.

**Interfaces:** Consumes: Task7의 evals/scenarios.json, Task8의 install/doctor, Task10의 `verifyRelease({root,artifacts})`, Task6의 ReportPacket. Produces: `runHostScenarios({host,scenarios,workspaceRoot,outputDir,timeoutMs}): Promise<HostReceipts>`와 R01~R13 증거. 영수증은 명령·시각·실제 host 버전·설치 방식·exit code·노출/호출 상태·산출물 hash·판정·미실행 이유를 기록한다. runner는 모델·계정·권한 우회 옵션을 추가하지 않는다.

- [ ] **Step 1: baseline→수정→같은 조건 재검사→보고의 통합 시험을 작성한다.** fixture 사이트의 의도하지 않은 noindex와 구조 결함을 실제 HTTP/local source로 재현한다. 정해진 URL/조건을 보존한 수정 후 blocker 해제와 보고서 숫자·변경 기록을 확인한다. 실제 엔진 색인·클릭·AI 노출은 unknown이어야 한다. 섞인 production baseline/local after 비교는 not_comparable이어야 한다.
- [ ] **Step 2: 전체 의미 있는 시험을 실행한다.** Run: `node --test`; `python -m unittest discover -s tests/python -p 'test_*.py' -v`; `node scripts/verify-release.mjs --dist dist`. Expected: 종료0, test 수·실패/skip 수·실제 패키지 내부 목록을 기록한다. Node22 기준의 CI/격리 실행과 Windows의 현재 Node24 실행을 구분한다. 시험 실패를 고쳐 통과시킨 뒤 새 변경 없는 전체 결과를 보존한다.
- [ ] **Step 3: 새 호스트 세션에서 실제 요청을 검증한다.** Task7의 realistic request 중 무료 로컬·원격 전용·Naver·AI 인용·비용 미결정·재개·수집 내용의 외부 지시를 포함한다. 독립 평가자에게 실제 요청·스킬·최소 원자료만 주고 예상 답/의심 결함은 주지 않는다. 선택한 Native/Subagent-driven의 검토 범위를 따른다. 입력 재질문·올바른 module 선택·권한/비용 경계·산출물·정량 재계산을 실제 기록으로 판정한다.

현재 확인된 Codex 명령은 `codex exec --ephemeral --json -C <fixture-path> -o <output-path> <prompt>`다. Claude는 `claude -p <prompt> --no-session-persistence --output-format json --plugin-dir <plugin-path>`다. 실행 직전 현재 `--help`를 대조하고 argv 배열·shell=false로 안전한 실행기를 쓴다. Windows의 .cmd 진입점은 검증한 실제 실행 파일/Node CLI 경로를 사용한다. 인증·사용량 제한은 우회하지 않는다. 첫 직접 유료 API 실측은 승인된 비용 한도가 있을 때만 실행한다.

호스트별 격리 검증을 통과하면 승인된 범위에서 Codex와 Claude Code의 user 스킬을 설치한다. 이미 존재하는 optbrew는 hash/owner를 확인하고 충돌이면 교체하지 않는다. doctor readback과 새 세션 실행을 따로 기록한다. 파일이 있다고 실제 발동 통과를 표시하지 않는다. 다른 플랫폼은 공식 문서·격리 설치·실제 실행의 범위를 구분한다. 실제 호출을 못 하면 미실행 이유와 남은 조건을 남긴다.
- [ ] **Step 4: 최종 스킬·라이선스·배포 준비를 검토한다.** skill-judge의8차원/120점은 평가 근거·감점·한계와 공개하고 사이트 점수와 구분한다. 최종 포함 파일의 라이선스와 모든 새 의존성을 다시 확인한다. build/pack을 갱신해 README·manifest·hash를 재검증한다. R01~R13의 각 evidence_ref를 아래 표에 채운다. 최종 독립 검토에서 확인된 문제만 수정하고 관련 검사/영향받은 범위를 재실행한다.

GitHub owner와 npm 계정/이름 가용성은 인증정보를 출력하지 않는 조회로 확인한다. 확인 결과와 완성 패키지·공개 라이선스·현재 지원 범위·게시 명령을 검토 가능한 형태로 제시한다. GitHub 공개·push·npm publish는 최종 실행 권한이 도착하기 전에는 수행하지 않는다. 미정 metadata는 공개 준비 제한으로 표시한다. 설치 환경 변경을 작업 기록에 적고 세션 종료 때 기존 agent-config 절차로 반영한다.
- [ ] **Step 5: 검증된 소스와 인계를 커밋한다.** 비밀 검사 후 해당 Files만 stage하고 `git commit -m 'test: verify optbrew workflows host invocation and release boundaries'`. 증거가 없는 R항목은 통과로 표시하지 않는다. T-003/T-004는 완료 조건 충족 시에만 task.py로 done 처리하고 T-005의 공개/환경 게이트를 남긴다.

## 완료 조건과 검증 위치

| 승인 설계 ID | 작업 | 주요 증거 |
|---|---|---|
| R01 내부 포함 | 1·10 | 실제 file 목록·고정 ref·원본/배포 hash·npm/ZIP |
| R02 라이선스·제외 | 1·10·12 | blob 고지·전이 참조·제외 원문·의존성 |
| R03 접수·발동 | 7·12 | 실제 request·질문·RunContext·host 결과 |
| R04 라우팅 | 5·7·12 | 무료/API/Naver/공유 도메인/원격 시나리오 |
| R05 산식 | 3 | 손계산·M0/A0·partial/N/A/unknown·CLI 재계산 |
| R06 blocker | 3·6·12 | 높은 점수+noindex·핵심 unknown 대조군 |
| R07 비교 | 4·12 | 변경된 환경/질문/기준·원자료 재계산 |
| R08 파서 | 2 | upstream RED·보정 GREEN·정상/무효 입력 |
| R09 보고 | 6·12 | JSON/Markdown 값·근거/해결/검증 연결 |
| R10 비용·외부 경계 | 5·7·12 | 키 부재·동시 예산·timeout·미배포·외부 지시 |
| R11 설치·갱신·복원 | 8·9 | 경로·편집·손상·fault·복원 readback |
| R12 두 호스트 | 8·12 | 파일·등록·새 세션 노출·실제 invocation |
| R13 문서·배포 | 10·11·12 | shell 명령·윤문 의미 비교·내부 파일 목록 |

Node 시험 문법 근거는 [Node22 node:test](https://nodejs.org/docs/latest-v22.x/api/test.html)다. shell glob 대신 정확한 파일 인자 또는 `node --test`를 사용한다. 제작 검증 API의 근거는 [python-jsonschema validators](https://python-jsonschema.readthedocs.io/en/stable/validate/)다. CLI/API/플러그인 문법은 구현 시 출처 문서와 설치된 버전으로 다시 확인한다. 비용 가격·registry 이름·계정·타 플랫폼 실행은 계획으로 확인했다고 주장하지 않는다.

## 작성자의 자체 검토

- 설계서1~13절과 R01~R13을 위 작업에 연결했다. 기존5개+7개, 네이버 제외, 유료/API, 점수·실측 분리, 양언어 README, 설치·갱신·복원, 최종 게시 게이트를 보존했다.
- ZIP의 계산기 누락, SE Ranking 원본 인증 스크립트 자동 실행, Markdown의 schema 오판, 고점수 blocker 은폐, 파일 편집 손실을 Review Focus와 해당 시험에 연결했다.
- 공유 타입·signature는 공통 인터페이스와 각 Tasks의 Interfaces로 고정했다. 후속 작업에서 선행 API를 다른 이름으로 재정의하지 않는다.
- 시험은 행동·원자료·부작용을 판정한다. 순수 문구 일치로 모듈 판단·호스트 발동·SEO 성과를 인증하지 않는다.
- 12개 작업의 최소 구현 단위를 유지했다. 제품 코드와 의존성 설치를 계획 작성 단계에서 시작하지 않았다. 독립 평가·공개 게시·실제 유료 측정은 해당 실행 조건을 보존한다.

## 실행 방식과 다음 검토

추천은 **Subagent-driven**이다. 12개 작업에는 채점·수집·비용·설치 트랜잭션의 경계가 있어 작업별 독립 검토가 유용하다. 같은 인터페이스에 의존하는 작업은 순서대로 실행하고 파일 소유권을 명시한다. Native도 같은 검증 기준을 사용하며 마지막에 독립 전체 검토를 수행한다.

사용자는 이 작성 계획이 요구를 담았는지 검토하고 Native / Subagent-driven 중 실행 방식을 선택한다. 그 검토와 선택 전에는 제품 코드·의존성·설치를 시작하지 않는다. 이미 승인된 설계 기본값은 재질문하지 않는다.
