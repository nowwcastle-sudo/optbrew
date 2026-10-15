# Seeded-defect detection, version 0.1.3

The 0.1.1 review seeded 61 defects and 16 clean control pages on five local sites (SEO 16, NEO 13, AEO 12, GEO 11, LLMO 9). The answer key was frozen before any run (sha256 `ba11fe0d2ac20fc1e2131166ed272b29daa64ee25b92f89fd66b33617f1d6833`, unchanged since 0.1.1) and the sites are the same bytes. This page records the same key run against 0.1.3 through the documented flow (`audit.mjs` → `cli.mjs score` → `cli.mjs report`, which replays every collector verdict from the hashed evidence). Agent judgment from the guides was not exercised, so guide-only items count as undetected.

A defect counts as detected (D) only when a scripted observation fails on the correct unit and the finding reaches `report.json`. M means the signal exists only in module output. As in 0.1.2, the AEO and GEO runs declare the AI engines (`chatgpt`, `claude`, `perplexity`) in `protocol.engines`, because only declared engines have `search-crawl-policy` units.

| Discipline | Seeded | D in 0.1.2 | M in 0.1.2 | D in 0.1.3 | M in 0.1.3 | Guide-only | Owner data | Script gap | By design |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SEO | 16 | 10 | 0 | 11 | 0 | 5 | 0 | 0 | 0 |
| NEO | 13 | 9 | 0 | 9 | 0 | 1 | 1 | 2 | 0 |
| AEO | 12 | 2 | 2 | 2 | 2 | 8 | 0 | 0 | 0 |
| GEO | 11 | 2 | 0 | 2 | 0 | 9 | 0 | 0 | 0 |
| LLMO | 9 | 5 | 0 | 5 | 0 | 0 | 3 | 0 | 1 |
| Total | 61 | 28 | 2 | 29 | 2 | 23 | 4 | 2 | 1 |

Each row sums to its seeded count (an incidental signal that does not name its defect counts as guide-only).

## What changed against 0.1.2

- SEO-12, the orphan page, is detected again. The 0.1.2 rule made every unlinked page `unknown` while any collected page had scripts and no anchors, and the seeded site has a script-only page. In 0.1.3 an unlinked page is an orphan unless a collected page's own bytes name its path or a script file that could build the link was not collected; the seeded site's script pages do neither, so the orphan fails.
- Everything else is unchanged: no detected defect was lost and no control page gained a failure.

## What is still not detected

SEO-05 (vague title), SEO-13 and NEO-13 (a sitemap or a robots Sitemap line is a site fact with no per-page unit), SEO-14 (JavaScript-only navigation), SEO-16 (hreflang), NEO-06 (og:image size needs another request), NEO-07 (owner data), LLMO-01 and LLMO-04 (stated in prose only), LLMO-08 (`llms.txt`, unscored by design), LLMO-09 (two pages disagree, so no reference value exists and the check stays unknown), AEO-01 to AEO-07, AEO-09, AEO-10 and AEO-12 (guide-only or module-only signals), and GEO-02 to GEO-09, GEO-11 and GEO-12.

## Controls

No clean control page fails a check for its own content. The three GEO control pages carry a `search-crawl-policy` failure for `perplexity` because the seeded GEO-01 robots file blocks PerplexityBot for the whole site; that is the defect's real effect. The advisory "no question-shaped heading" warning from the Magnus module still appears on clean pages.

## Limits of this number

The 0.1.3 changes to phone reading (spaced national numbers, 15xx, 16xx and 18xx representative numbers) and to branch pages (structure instead of a title word) are covered by their own tests; the seeded sites use neither form, so they do not move this table. The numbers come from one synthetic set of sites and do not predict detection on real sites. An inline script that builds a link from pieces of a URL can still hide that link from the orphan check and give a false orphan.
