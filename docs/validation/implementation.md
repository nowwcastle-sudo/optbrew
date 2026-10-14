# Implementation evidence, version 0.1.1

This table distinguishes local technical proof from host behavior and public outcomes. The evidence references are repository paths. Raw account-host logs stay outside the package.

| ID | Status | Evidence reference and boundary |
| --- | --- | --- |
| R01 | Verified locally | `tests/vendor.test.mjs`, `tests/skill-bundle.test.mjs`, `tests/release.test.mjs`; pinned source lock, selected file hashes, npm and ZIP closure. |
| R02 | Verified locally | `skills/optbrew/THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES.md`, `docs/validation/SCHEMA_NOTICE.md`, `tests/vendor.test.mjs`; MIT/ISC source notices and Apache-2.0 portable schema notice. Service and article rights are separate. |
| R03 | Partly verified | `skills/optbrew/SKILL.md`, `evals/scenarios.json`; a fresh Codex user-installed literal `optbrew 실행해` call read the skill and asked for the missing URL and goal. The other scenario decisions await independent evaluation; Claude Code behavior is unavailable at its weekly limit. |
| R04 | Partly verified | `skills/optbrew/references/routing.md`, `tests/capabilities.test.mjs`, `tests/collector.test.mjs`; deterministic routes and scope checks pass. Fresh host choices remain unverified. |
| R05 | Verified locally | `tests/scoring.test.mjs`, `tests/workflow.test.mjs`; 22 families, unknown denominator, blocker, profile arithmetic, engine/origin unit splits, and runtime evaluator source identity are checked. |
| R06 | Verified locally | `tests/scoring.test.mjs`, `tests/workflow.test.mjs`; real localhost noindex and missing title block baseline; changed raw HTML clears those observed failures. Unobserved families remain unknown. |
| R07 | Verified locally | `tests/compare.test.mjs`, `tests/workflow.test.mjs`; same URL and conditions compare, while production/local mixing returns `not_comparable`. |
| R08 | Verified locally | `tests/parsers.test.mjs`, `tests/python/test_magnus.py`; parser controls cover valid and adverse inputs. |
| R09 | Verified locally | `tests/report.test.mjs`, `tests/workflow.test.mjs`; report generation replays title and noindex from bound raw HTML and saved response headers. Jointly forged module and observation positives are rejected. Local change hashes and unknown external outcomes remain explicit. Installed junction and physical direct entrypoints produce matching audit/score output. |
| R10 | Verified locally with external limits | `tests/cost-ledger.test.mjs`, `tests/adapters.test.mjs`, `tests/collector.test.mjs`, `skills/optbrew/references/api.md`; no directly billed API call or settlement was measured. |
| R11 | Verified locally; user refresh pending | `tests/install.test.mjs`, `tests/update.test.mjs`, `tests/rollback.test.mjs`, `tests/doctor.test.mjs`; managed install/update/recovery behavior. The Codex and Claude Code user targets passed doctor on the earlier local 0.1.0 bundle. The corrected release is 0.1.1; user-target update awaits final review. Same-version different-byte updates remain refused. |
| R12 | Earlier 0.1.0 bare invocation observed; 0.1.1 native workflow incomplete | `scripts/run-host-scenarios.mjs` and `tests/host-runner.test.mjs` bound timeout finalization and preserve running logs, incomplete receipts and unknown exit codes. The separate 0.1.1 local native attempt stopped after baseline artifacts without an edit, after scan or report; its exact command output and baseline executable source were not captured. A global 0.1.0 alias was observed for one ineffective CLI call while a project 0.1.1 bundle was present. The user targets remain on 0.1.0 pending reviewed update. Claude Code returned weekly HTTP 429. |
| R13 | Verified locally; publication pending | `tests/docs-commands.test.mjs`, `tests/release.test.mjs`, `scripts/verify-release.mjs`, `docs/release.md`; commands, manifest, licenses and distributed file list. Public repository/npm readback and local tag are pending. |

The localhost workflow is a synthetic site served through real HTTP. Its score change establishes local readiness arithmetic only. It establishes no search indexing, traffic, ranking or AI citation result.
