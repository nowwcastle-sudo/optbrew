# Seeded-defect detection, version 0.1.2

The 0.1.1 review seeded 61 defects and 16 clean control pages on five local sites (SEO 16, NEO 13, AEO 12, GEO 11, LLMO 9). The answer key was frozen before any run (sha256 `ba11fe0d2ac20fc1e2131166ed272b29daa64ee25b92f89fd66b33617f1d6833`, unchanged). This page records the same key run against 0.1.2 through the documented flow (`audit.mjs` → `cli.mjs score` → `cli.mjs report`, which replays every collector verdict from the hashed evidence). Agent judgment from the guides was not exercised, so guide-only items count as undetected.

A defect counts as detected (D) only when a scripted observation fails on the correct unit and the finding reaches `report.json`. M means the signal exists only in module output. Two choices differ from the 0.1.1 run and are stated so the numbers are not over-read: the AEO and GEO runs declare the AI engines (`chatgpt`, `claude`, `perplexity`) in `protocol.engines`, because only declared engines have `search-crawl-policy` units; and the analysis rules gained cases for the new families.

| Discipline | Seeded | D in 0.1.1 | M in 0.1.1 | D in 0.1.2 | M in 0.1.2 | Guide-only | Owner data | Script gap | By design |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SEO | 16 | 5 | 2 | 10 | 0 | 6 | 0 | 0 | 0 |
| NEO | 13 | 4 | 1 | 9 | 0 | 1 | 1 | 2 | 0 |
| AEO | 12 | 1 | 3 | 2 | 2 | 8 | 0 | 0 | 0 |
| GEO | 11 | 1 | 0 | 2 | 0 | 9 | 0 | 0 | 0 |
| LLMO | 9 | 0 | 0 | 5 | 0 | 0 | 3 | 0 | 1 |
| Total | 61 | 11 | 6 | 28 | 2 | 24 | 4 | 2 | 1 |

The first round-two numbers were 31 detected (SEO 11, LLMO 7); the review showed that two of those relied on heuristics that failed on ordinary pages, and the table above is the corrected result. Each row sums to its seeded count (an incidental signal that does not name its defect counts as guide-only). Script gap means a check that is scoped but not built; the 0.1.1 dead-code items NEO-05, NEO-09, NEO-10, NEO-12 and NEO-14 are now detected.

## What changed the result

- SEO: duplicate titles, canonical target, redirect chain, Googlebot access to a disallowed path, JSON-LD parse error. The orphan page (SEO-12) was detected before the round-two review and is `unknown` now: the seeded site has script-built navigation (a JS shell and a pseudo-link page), and a page with scripts and no anchors makes the link graph unknowable, so discovery no longer fails.
- NEO: Open Graph tags, description, relative canonical, title keyword repetition, a stylesheet blocked for Yeti.
- AEO: JSON-LD parse error.
- GEO: PerplexityBot blocked. GPTBot, ClaudeBot and Google-Extended are training tokens; the design rule gives them no score, so blocking them is not a failure. GEO-01 is therefore detected for its search-bot part only.
- LLMO: address, phone, a JSON-LD telephone that disagrees with the visible text, a missing Organization entity on the home page and Organization JSON-LD without `sameAs`. The name variant (LLMO-01) and founding year (LLMO-04) were detected before the round-two review, when prose sentences were read as facts; that extraction produced false failures on ordinary pages and was removed.

## What is still not detected

SEO-05 (vague title), SEO-13 and NEO-13 (a sitemap or a robots Sitemap line is a site fact with no per-page unit), SEO-14 (JavaScript-only navigation), SEO-16 (hreflang), NEO-06 (og:image size needs another request), NEO-07 (owner data), SEO-12 (script-built navigation makes discovery unknown), LLMO-01 and LLMO-04 (stated in prose only), LLMO-08 (`llms.txt`, unscored by design), LLMO-09 (shipping threshold: two pages disagree, so no reference value exists and the check stays unknown), AEO-01 to AEO-07, AEO-09, AEO-10 and AEO-12 (guide-only or module-only signals), and GEO-02 to GEO-09, GEO-11 and GEO-12.

## Controls and coverage

No clean control page fails a check for its own content. The three GEO control pages carry a `search-crawl-policy` failure for `perplexity` because the seeded GEO-01 robots file blocks PerplexityBot for the whole site; that is the defect's real effect, not a false positive. The advisory "no question-shaped heading" warning from the Magnus module still appears on 14 of 16 clean pages.

Coverage rose from 4–17% to 24–45% of the applicable weight and every run prints `insufficient coverage` instead of a bare score. The LLMO site that scored 100 at 4% coverage in 0.1.1 now reports a measured-subset score of 55.2 at 35.5% coverage.

## Caveats added in the round-two review

- GEO-01 is counted as detected for its PerplexityBot part only; GPTBot, ClaudeBot and Google-Extended are training tokens and unscored by design. The run also declares the AI engines in the protocol.
- The LLMO checks are conservative heuristics, tuned to labelled contact fields and Organization JSON-LD. The seeded LLMO site states its name and founding year in prose, which the checks no longer read, so LLMO-01 and LLMO-04 are no longer detected; sites that publish facts in other forms get `unknown`, not a verdict. The numbers above come from one synthetic set of sites and do not predict detection on real sites.
