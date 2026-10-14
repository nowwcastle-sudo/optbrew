# Changelog

## 0.1.2

- The report headline no longer lets a measured score read as a complete one. Each headline score carries its coverage; below the 80% coverage rule the single number is withheld and the report shows `insufficient coverage` with the measured-subset value and the missing-data bounds (`report.json` `headline[]`).
- The audit now observes from collected responses: duplicate titles (`document-title`), canonical target status and redirect-chain length (`canonical-consistency`), link and declared-sitemap discovery (`discovery`), JSON-LD parse errors (`structured-data-truth`), Naver markup moved from the unreachable direct-fetch path into the collected-evidence path (`naver-markup`: Open Graph, description, canonical, viewport, title repetition, CSS or JS blocked for Yeti), `search-crawl-policy` for Googlebot, Yeti and the AI search bots OAI-SearchBot, Claude-SearchBot and PerplexityBot (`references/ai-crawlers.md`; training bots stay unscored), and cross-page name, address, phone, founding-year and shipping-threshold comparison with an entity-identity check (`fact-consistency`, `entity-identity`).
- `search-crawl-policy` now records a pass as well as a fail for every engine that has a robots token. The collector fetches in-scope canonical targets inside the 50-request budget.
- Report replay derives every collector verdict again from the hashed raw evidence with the same code the audit uses, and rejects a derived observation that is missing, extra or different.
- Scoring contracts, profile weights, the check registry and the evaluation and protocol versions (0.1.0) are unchanged, so a managed install of 0.1.1 updates to 0.1.2 without a migration. A baseline audit made with 0.1.1 produces fewer observations than 0.1.2; run the baseline again with 0.1.2 before comparing.
- Public clones: the four maintainer-only vendor tests skip with a reason when the upstream source mirror is absent, so `npm test` passes without it.
- Not scripted yet: the `robots.txt` Sitemap line, og:image size, hreflang, JavaScript-only navigation, answer structure, claim support, authorship and freshness.

## 0.1.1 — local release candidate

- Verified a real localhost noindex/title baseline, backed-up local edit, same-condition rescan and evidence-bound JSON/Markdown report. The collector emits pass or fail observations for completed index checks, a fail for a missing title and unknown for a present one (uniqueness and descriptiveness need separate evidence), and the report replays title, index and crawl-policy verdicts from the preserved raw bytes.
- Audit evidence produced before the hashed response records existed must be re-collected; the audit evidence format changed during 0.1.1 development, and report replay now rejects older audit output. Report replay also rejects a selected page that is neither collected nor skipped, and a packet that drops its audit snapshot while collector evidence is indexed. A production resolution now names the evaluator type and source of its resolving observation.
- Final review round 2: the collector keeps each X-Robots-Tag header line separate and hashes a response record (final URL, redirect chain, header lines) beside every raw body; report replay binds the final URL and headers to that record, requires every planned collector observation, and accepts `verified_local` only through the production-style observation binding of a collector-produced after observation. Native export paths refuse protocol-relative or other-host URLs, a semicolon separates robots meta directives, and the ZIP verifier refuses Windows case-insensitive and trailing dot or space name collisions.
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
