# Sandbox validation, version 0.2.0

This file records the beginner-flow validation of the 0.2.0 skill (design §7, C16). A clean Claude Code session ran the skill on two real sites with two user messages and no help. The pass lines come from the design. A run that missed a line went back to the task that caused it and was measured again.

## Session

Each run used a fresh `claude -p` session with no user instructions, no MCP servers, no hooks and the default output style. Only the optbrew plugin and the three built-in plugins loaded; the init event confirmed this on every call.

```
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p "<message>" --setting-sources project,local --strict-mcp-config --mcp-config <empty> --plugin-dir <checkout> --output-format stream-json --verbose --include-hook-events --permission-mode acceptEdits --allowedTools "Bash,PowerShell,Read,Write,Edit,Glob,Grep"
```

The second call resumed the first session. The user wrote exactly two messages:

1. `https://<site> 감사해 줘`
2. `시작. 목표는 「검색과 AI 답변에 우리 기관이 잘 나오게 하고 싶어요」예요. 키와 내보내기 파일은 준비된 게 없어요.`

No API key and no export file were given, so the field-data families (LCP, INP, CLS) stayed unknown. That is the case C16 measures.

## Sites

- **youthdc.com**: a Korean care-facility site (Next.js, server-rendered, Korean text, Naver as a target engine).
- **htmx.org**: an English product documentation site. The goal named search only, so Naver is not a target and the NEO profile does not apply.

## Results

Coverage is the share of weighted units with a pass or fail verdict, without and with the three CWV families. The C16 line is 85% without CWV on every profile that applies.

| Line | Pass line | youthdc.com (run 5) | htmx.org (run 4) |
|---|---|---|---|
| Extra questions after the start question | 0 | 0 | 0 |
| Work the user must do by hand | account runbooks only | 0 | 0 |
| Workaround scripts written by the agent | 0 | 0 (two JSON data files) | 0 (two JSON data files) |
| Start screen runbooks | full ≤1, one-line ≤3 | 0 full, 2 one-line | 0 full, 2 one-line |
| SEO coverage without / with CWV | ≥85 without | 90.8 / 77.1 | 97.1 / 82.5 |
| NEO coverage without / with CWV | ≥85 without | 89.5 / 80.6 | not a target |
| AEO coverage without / with CWV | ≥85 without | 93.5 / 84.1 | 96.5 / 86.8 |
| GEO coverage without / with CWV | ≥85 without | 92.9 / 88.2 | 95.9 / 91.1 |
| LLMO coverage without / with CWV | ≥85 without | 96.0 / 96.0 | 93.7 / 93.7 |
| report.json, report.md and report.html agree | same numbers | 15 of 15 values, same headline | 12 of 12 values, same headline |
| Calls, time and cost | report only | 2 calls, 6.4 min, $3.93 | 2 calls, 6.5 min, $3.42 |

SEO on youthdc shows no headline score: with CWV unknown its coverage is 77.1%, below the 80% line for a score. The report says so and names the missing key.

## Model not-applicable verdicts (R86)

An independent reviewer read the visible text of every page with a model not-applicable verdict and judged it against `references/judging.md`. The line is fewer than 10% wrong per family per site.

| Site | Model N/A | Wrong | Result |
|---|---|---|---|
| youthdc.com (run 5) | 33 of 180 units (18.3%) | 0 in every family | pass |
| htmx.org (run 4) | 137 of 216 units (63.4%) | 0 in every family | pass |

htmx has many not-applicable verdicts because most of its pages are attribute reference pages. The judging rules mark those as not needing an operator name, claims support or a date. Turning every youthdc not-applicable verdict into unknown still leaves every profile at 87.2% or more without CWV.

## What the runs changed

Five runs found problems that tests had not found. Each became a ruling and a task, and the next run measured it.

| Run | Found | Changed in |
|---|---|---|
| 1 | Code checks that never gave a verdict; model not-applicable forced to unknown; spans from attribute text | Task 21b |
| 2 | Declared sitemaps fetched after the page budget ran out; unknown model units on time-sensitive and source pages | Tasks 21c, 21d |
| 3 | A page-wide absence fail while the page showed a date; footer text deciding every page | Task 21d |
| 4 | 8 of 10 headline fixes were not real problems: a year split by HTML comments, a deliberate noindex on form pages, duplicate titles on query variants of one page; news stories judged as making no claims | Task 21e |
| 5 | Fix rows that began with an English reason and gave no fix method; a final message that called answered questions unanswered | Task 21f |

After run 5 the youthdc headline lists 3 fixes, and an independent reading of the live pages found all 3 true. Task 21f changed only the wording of fix rows and question lines, not verdicts or coverage; replaying the run 5 evidence through it gives each fix a Korean problem sentence, the page, the cited text, a fix method, the effort and a check, and the two unanswered questions read "이번에 읽은 페이지에서는 이 질문에 답하는 페이지를 찾지 못했습니다." instead of "없음".

Code measured: runs 4 and 5 used commits a35dc08 and 67c61ca; the release branch adds Task 21f (447b839) on top.

## Not measured here

- Codex: skipped by the owner's decision for this release.
- Claude Code cloud (network block runbook, proxy switch, no Chrome): runs after the branch is pushed.
- Logged-in console screens (Google Cloud, Search Console, Naver): checked by the owner (Task 20 step 2).

Run folders and transcripts stayed on the test machine and are not part of the repository.
