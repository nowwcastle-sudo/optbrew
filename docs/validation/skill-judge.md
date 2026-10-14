# optbrew skill review, version 0.1.1 (final round, 2026-10-15)

This round asks one question: can optbrew run a meaningful audit for SEO, NEO (Naver search optimization), AEO, GEO and LLMO? It combines two independent checks on `main` at `e09de7f`:

1. A `skill-judge` review of the whole package, including the vendored module guides (120 points).
2. A seeded-defect test: five local sites with 61 planted defects and 16 clean control pages, run through the documented flow (`audit.mjs` → `cli.mjs score` → `cli.mjs report`). The answer key was frozen before any run (sha256 `ba11fe0d2ac20fc1e2131166ed272b29daa64ee25b92f89fd66b33617f1d6833`). Agent judgment from the guides was not exercised, so guide-only items are counted as undetected.

The previous review scored 97/120 on `SKILL.md` and the core references only. This round scores the full package.

## skill-judge score: 85/120 (C, 70.8%)

| Dimension | Score | Max | Main evidence |
| --- | ---: | ---: | --- |
| D1 Knowledge delta | 13 | 20 | Core measurement guidance is expert-level (`references/measurement.md`). Bundled guides still carry vendor statistics and a factual error about GPTBot (`modules/marketing-search/skills/ai-seo/references/platform-ranking-factors.md:131`). |
| D2 Mindset and procedures | 11 | 15 | Six-step flow is sound (`SKILL.md:10-15`). No rule maps a named discipline ("GEO audit") to checks or modules. |
| D3 Anti-patterns | 12 | 15 | `references/policies.md` is strong; some module guides contradict it (`modules/seranking-seo/skills/seo-geo/GUIDE.md:55,60`). |
| D4 Specification | 14 | 15 | Valid frontmatter with Korean and English triggers. |
| D5 Progressive disclosure | 9 | 15 | `scoring.md`, `measurement.md`, `check-registry.json` and `profiles.json` are not linked from the entry path. |
| D6 Freedom calibration | 11 | 15 | Score input for 22 families must be assembled by hand. |
| D7 Pattern recognition | 7 | 10 | 25 module guides keep their own personas and output conventions. |
| D8 Practical usability | 8 | 15 | A fresh public clone fails 4 of 200 tests (missing maintainer source mirror). A 4%-coverage run shows a headline of 100. |

## Detection test

| Discipline | Seeded | Detected in report | Module-only signal | Guide-only | Dead code | Needs owner data | False positives on clean pages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SEO | 16 | 5 | 2 | 9 | 0 | 0 | 0/3 |
| NEO | 13 | 4 | 1 | 1 | 6 | 1 | 0/3 |
| AEO | 12 | 1 | 3 | 8 | 0 | 0 | 0/4 |
| GEO | 11 | 1 | 0 | 9 | 0 | 0 | 0/3 |
| LLMO | 9 | 0 | 0 | 3 | 0 | 5 | 0/3 |
| Total | 61 | 11 (18%) | 6 | 30 | 6 | 6 | 0/16 |

No clean page produced a fail verdict. Advisory warnings ("no question-style heading") appeared on 14 of 16 clean pages.

## Verdict per discipline

| Discipline | Verdict | Why |
| --- | --- | --- |
| SEO | Meaningful, limited to access and indexing gates | Scripts catch noindex (meta and header), missing title and 4xx/5xx. Duplicate titles, canonical, redirect chains, sitemap, orphan pages and hreflang are guide-only. |
| NEO | Meaningful, limited to Yeti access and indexing | Yeti robots and noindex work. Naver markup checks (OG, description, canonical, title repetition, Sitemap line) sit in `modules/naver-searchadvisor/scripts/audit.mjs` `audit()` (line 175), which calls a `get()` that always throws; optbrew uses only `auditCollected()`. |
| AEO | Readiness only | Shares GEO's check list. FAQ markup, answer structure, unsupported claims and question coverage have no scripted signal. |
| GEO | Readiness only | No GEO-specific defect detected. AI crawler blocks (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) are not judged. Citation measurement needs paid SE Ranking or owner exports. |
| LLMO | Not possible with scripts alone | 0/9. Cross-page entity mismatches (name, address, phone, year) are not compared. `fact-consistency` needs an owner-approved fact list; the accuracy panel needs a paid API budget. |

The five profiles weight the same 22 families (`references/profiles.json`). Only `naver-markup` is discipline-specific. Scripts produce observations for 4 families: `fetch-response`, `document-title` (presence), `index-policy`, `search-crawl-policy` (Naver only). The C and E axes carry 50% of AEO, 55% of GEO and 80% of LLMO weight and have no scripted observation.

## Recommended fixes, ranked

1. `tests/vendor.test.mjs:12`: skip the 4 maintainer-only vendor tests with a clear message when `OPTBREW_SOURCES_ROOT` is absent, so a public clone passes `npm test`.
2. Show coverage next to the headline and withhold a single number when coverage is below a threshold, so a 4% run cannot read as 100.
3. Move the Naver markup checks from `audit()` into `auditCollected()` (recovers 6 NEO defects in the test).
4. Add scripted checks on data the collector already gathers: duplicate titles, canonical target, redirect chain length, sitemap status, AI crawler rules in robots.txt for GEO targets.
5. Add a cross-page entity fact comparison for LLMO (name, address, phone, dates from visible text and Organization JSON-LD).
6. Let module-only signals (JSON-LD parse errors) reach the report as observations.
7. Correct or annotate stale vendor claims (GPTBot role, FID thresholds, FAQ/HowTo rich results, vendor percentages) and link `scoring.md`/`measurement.md` from `SKILL.md`.

Evidence: `.superpowers/sdd/2026-10-15-skill-judge-final/` (git-ignored) holds `skill-judge-report.md` and `detection/` with the answer key, runs and `results.md`.
