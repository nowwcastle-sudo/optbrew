# Changelog

## 0.1.1 — local release candidate

- Verified a real localhost noindex/title baseline, backed-up local edit, same-condition rescan and evidence-bound JSON/Markdown report. The collector emits pass or fail observations for completed index checks, a fail for a missing title and unknown for a present one (uniqueness and descriptiveness need separate evidence), and the report replays title, index and crawl-policy verdicts from the preserved raw bytes.
- Final review fixes: index directives ignore commented or script text and follow the target engine's meta and X-Robots-Tag scope; report replay accepts permitted redirects and header-only noindex findings and re-derives robots verdicts; a byte-hash receipt alone no longer marks a fix verified locally; redirect hops count against the 50-request budget; native path mappings match whole path segments; the release verifier rejects unextractable ZIP layouts.
- Bound runtime scoring to the installed evaluation/protocol source hashes and versions. The evaluation and observation protocol versions remain 0.1.0. Root notice links resolve to the packaged skill licenses.
- Fixed direct audit and calculation entrypoints invoked through managed Windows junctions or Unix symlinks. Ordinary imports remain inert.
- The report separates baseline and after blocker counts. Locally verified fixes now lead to production deployment/reobservation work instead of repeating the original edit instruction.
- One fresh Codex bare invocation completed on the local 0.1.0 install. Broader native behavior and Claude Code invocation remain unverified for this corrected release.

## 0.1.0 — local prepublication install

- Added one pinned optbrew skill source with five selected source bundles and seven marketing guides. Retained notices and modification records; excluded 55 Naver original guide articles while keeping official index links.
- Added local collection boundaries, evidence-based readiness scoring, before/after comparison, and report generation. Scores distinguish unknown checks, blockers, and actual outcomes.
- Added managed install, doctor, update, and rollback paths for Codex, Claude Code, Cursor, OpenCode, and Pi; added host plugin and Pi package metadata.
- Added a text-only direct Anthropic adapter with exact model and token-bound checks. API use remains optional and requires an approved cost decision.
- Added English and Korean usage, API, platform, and release instructions. This initial local install did not establish public npm/GitHub publication or native host invocation.
