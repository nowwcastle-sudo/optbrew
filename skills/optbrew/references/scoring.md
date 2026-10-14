# optbrew readiness scoring contract (evaluation 0.1.0)

This is a readiness audit. It does not predict indexing, rank, AI citations, accuracy, or revenue. `check-registry.json` holds the 22 unique families. `profiles.json` holds the five optbrew axis weight sets. Those weights, the middle-band CWV `q=0.5`, the score bands and the 80% coverage threshold are **optbrew rules**, not search engine weights or official sufficiency tests. `source_refs` names match the official references in `docs/superpowers/specs/2026-10-13-optbrew-sources.md` in the source repository.

## Fixed input

`ScoreInput` is `{schema_version:"1.0.0",run_context:RunContext,observations:CheckObservation[]}`. The JSON Schema in `schemas/contract.schema.json` names this and the nine persisted entities. `validateEntity(typeName,value)` returns the value or throws `ContractError`. `freezeProtocol(run_context)` returns `{protocol,protocol_hash}`. Its hash covers the selected URLs and page types, family decisions, engines, location/language, panel and surface/model/search settings, browser/device, target, environment and separate evaluation/protocol versions. It excludes `run_id` and evidence paths. Changing a comparison condition requires re-evaluation from preserved raw data or `not_comparable`.

Every `run_context.protocol.families` entry is `{family_id,applicable,urls?,engines?,reason?}`. A `ScoreInput` must explicitly decide all 22 entries. `applicable:false` means the family does not meet its condition. Missing observations for applicable units are `unknown`; they do not remove denominator weight. `urls` are normalized URLs selected in `page_types`; omit them to use all selected URLs. `engines` must come from `protocol.engines`; omit them to use all selected target engines. `naver-markup` can use only the Naver engine. NEO is reported only for a Naver target.

`question_panel` contains fixed `{id,question,category,goal?}` entries. Category is `brand` or `non_brand`; IDs are unique. `question-coverage` and `answer-clarity` require a nonempty panel. A partial `question-coverage` ratio uses the fixed panel length as its denominator.

Each page type has a stable ID and an array of `{original,normalized}` HTTP(S) URLs. Normalized URLs must be unique across types. Unit keys are deterministic:

| Unit scope | Key | Examples |
|---|---|---|
| URL | `family_id\|normalized_url` | `index-policy\|https://example.com/` |
| Engine and URL | `family_id\|engine\|normalized_url` | `search-crawl-policy\|google\|https://example.com/` |
| Origin | `family_id\|origin` | `lcp-field\|https://example.com` |
| Site | `family_id\|site` | `question-coverage\|site` |

`CheckObservation.check_id` equals its registered `family_id` in this evaluation version. Multiple modules can submit the same unit and verdict; it counts once. An unregistered unit or conflicting verdict is a contract error. For `pass` and `fail`, `q` is exactly 1 and 0. For `unknown` and `not_applicable`, `q` and `partial_basis` are null. For `partial`, `partial_basis` is `{kind:"threshold_half"}` with `q=0.5` or `{kind:"ratio",numerator:int,denominator:positive_int}` with a matching interior ratio. A CWV verdict also requires `measurement:{value,percentile:75,source_type:"field",unit}`; use `ms` for LCP/INP and `unitless` for CLS. An absent field measurement is `unknown`, not `not_applicable`.

## Weight and status calculation

`compileUnits(input,profile)` divides positive axis weight by applicable families, then engines, then fixed page types and URLs. Each nonempty page type gets equal share; URLs within a type get equal share. Site and origin units do not multiply with page count. Units marked `not_applicable` are removed and the remaining units in that family are renormalized. If a whole family has no units, it is removed from its axis. If an axis has no applicable families, the remaining positive axes are renormalized to 100. LLMO's P axis has zero weight. A weighted unit is `{key,family_id,engine,url,weight,state,q}`.

`scoreWeighted(units)` returns raw weighted totals `A` (applicable), `M` (measured) and `N` (measured credit), plus one-decimal display percentages: `score=100N/M`, `coverage=100M/A`, `missing_bounds=[100N/A,100(N+A-M)/A]`. `score` is null when `M=0`; `coverage` and `missing_bounds` are null when `A=0`. The bounds are all-missing-fail and all-missing-pass extremes, not a confidence interval. Internal comparisons use raw values with `1e-9` tolerance; display rounds only at the end.

`score(input)` returns ordered `ScoreResult[]` for SEO, optional NEO, AEO, GEO and LLMO. SEO is the default aggregate and is calculated directly, never from the mean of profile scores. Each result includes `{schema_version,evaluation_version,profile,A,M,N,score,coverage,missing_bounds,band,readiness_status,blockers,unknown_core,source_ref}`. Bands are `focus_improvement` (0–59), `major_improvement` (60–79), `additional_improvement` (80–94), and `remaining_review` (95–100). Status precedence is `not_applicable` for `A=0`, then `blocked` for confirmed access/crawl/noindex failures or an explicit severe-fact blocker, then `unverified` for unknown applicable access/index core units, then `provisional` below 80% measured coverage, else `measured`. `measured` means only that this optbrew readiness audit has enough measured coverage by its own rule.

Run a stored input without service access: `node skills/optbrew/scripts/cli.mjs score --input input.json --output score.json`. The output is the same JSON `ScoreResult[]` as the library call. The CLI validates before writing.
