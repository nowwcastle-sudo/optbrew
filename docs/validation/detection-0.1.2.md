# Seeded-defect detection, version 0.1.2

The 0.1.1 review seeded 61 defects and 16 clean control pages on five local sites (SEO 16, NEO 13, AEO 12, GEO 11, LLMO 9). The answer key was frozen before any run (sha256 `ba11fe0d2ac20fc1e2131166ed272b29daa64ee25b92f89fd66b33617f1d6833`, unchanged). This page records the same key run against 0.1.2 through the documented flow (`audit.mjs` → `cli.mjs score` → `cli.mjs report`, which replays every collector verdict from the hashed evidence). Agent judgment from the guides was not exercised, so guide-only items count as undetected.

A defect counts as detected (D) only when a scripted observation fails on the correct unit and the finding reaches `report.json`. M means the signal exists only in module output. Two choices differ from the 0.1.1 run and are stated so the numbers are not over-read: the AEO and GEO runs declare the AI engines (`chatgpt`, `claude`, `perplexity`) in `protocol.engines`, because only declared engines have `search-crawl-policy` units; and the analysis rules gained cases for the new families.

| Discipline | Seeded | D in 0.1.1 | M in 0.1.1 | D in 0.1.2 | M in 0.1.2 | Guide-only | Owner data | Script gap | By design |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SEO | 16 | 5 | 2 | 11 | 0 | 5 | 0 | 0 | 0 |
| NEO | 13 | 4 | 1 | 9 | 0 | 1 | 1 | 2 | 0 |
| AEO | 12 | 1 | 3 | 2 | 2 | 8 | 0 | 0 | 0 |
| GEO | 11 | 1 | 0 | 2 | 0 | 9 | 0 | 0 | 0 |
| LLMO | 9 | 0 | 0 | 7 | 0 | 0 | 1 | 0 | 1 |
| Total | 61 | 11 | 6 | 31 | 2 | 23 | 2 | 2 | 1 |

Each row sums to its seeded count (an incidental signal that does not name its defect counts as guide-only). Script gap means a check that is scoped but not built; the 0.1.1 dead-code items NEO-05, NEO-09, NEO-10, NEO-12 and NEO-14 are now detected.

## What changed the result

- SEO: duplicate titles, canonical target, redirect chain, orphan page, Googlebot access to a disallowed path, JSON-LD parse error.
- NEO: Open Graph tags, description, relative canonical, title keyword repetition, a stylesheet blocked for Yeti.
- AEO: JSON-LD parse error.
- GEO: PerplexityBot blocked. GPTBot, ClaudeBot and Google-Extended are training tokens; the design rule gives them no score, so blocking them is not a failure. GEO-01 is therefore detected for its search-bot part only.
- LLMO: name variant, address, phone, founding year, a JSON-LD telephone that disagrees with the visible text, a missing Organization entity on the home page and Organization JSON-LD without `sameAs`.

## What is still not detected

SEO-05 (vague title), SEO-13 and NEO-13 (a sitemap or a robots Sitemap line is a site fact with no per-page unit), SEO-14 (JavaScript-only navigation), SEO-16 (hreflang), NEO-06 (og:image size needs another request), NEO-07 (owner data), LLMO-08 (`llms.txt`, unscored by design), LLMO-09 (shipping threshold: two pages disagree, so no reference value exists and the check stays unknown), AEO-01 to AEO-07, AEO-09, AEO-10 and AEO-12 (guide-only or module-only signals), and GEO-02 to GEO-09, GEO-11 and GEO-12.

## Controls and coverage

No clean control page fails a check for its own content. The three GEO control pages carry a `search-crawl-policy` failure for `perplexity` because the seeded GEO-01 robots file blocks PerplexityBot for the whole site; that is the defect's real effect, not a false positive. The advisory "no question-shaped heading" warning from the Magnus module still appears on 14 of 16 clean pages.

Coverage rose from 4–17% to 24–45% of the applicable weight and every run now prints `insufficient coverage` instead of a bare score. The LLMO site that scored 100 at 4% coverage in 0.1.1 now reports a measured-subset score of 48.8 at 35.5% coverage.