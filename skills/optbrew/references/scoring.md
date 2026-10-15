# optbrew readiness scoring contract (evaluation 0.3.0)

This is a readiness audit. It does not predict indexing, rank, AI citations, accuracy, or revenue. `check-registry.json` holds the 22 unique families. `profiles.json` holds the five optbrew axis weight sets. Those weights, the middle-band CWV `q=0.5`, the score bands and the 80% coverage threshold are **optbrew rules**, not search engine weights or official sufficiency tests. `source_refs` names match the official references in `docs/superpowers/specs/2026-10-13-optbrew-sources.md` in the source repository.

## Fixed input

`ScoreInput` is `{schema_version:"1.0.0",run_context:RunContext,observations:CheckObservation[]}`. The JSON Schema in `schemas/contract.schema.json` names this and the nine persisted entities. `validateEntity(typeName,value)` returns the value or throws `ContractError`. `freezeProtocol(run_context)` returns `{protocol,protocol_hash}`. Its hash covers the selected URLs and page types, indexing intent, family condition codes, engines, location/language, panel and surface/model/search settings, browser/device, target, environment and separate evaluation/protocol versions. It excludes `run_id`, evidence paths, collection times and explanatory decision text. Changing a comparison condition requires re-evaluation from preserved raw data or `not_comparable`.

Every `run_context.protocol.families` entry is `{family_id,applicable,urls?,engines?,applicability_decision?}`. A `ScoreInput` must explicitly decide all 22 entries. False requires `{condition,reason,evidence_ref}` with a condition allowed for that family in `check-registry.json`; true forbids a decision. The reason and evidence reference must be nonempty. Unknown facts or missing collection data leave applicable units `unknown`; they do not remove denominator weight. `urls` and `engines`, when supplied, must equal the entire applicable selected set. To exclude one optional unit, submit an evidence-backed `not_applicable` observation for that unit. A subset in a family plan is rejected. NEO is reported only for a Naver target.

Every selected URL is a public audit target and always gets `fetch-response`. Its optional `public_indexing` defaults to true. An intentional non-index target sets `public_indexing:false` and supplies `indexing_decision:{condition:"not_public_index_target",reason,evidence_ref}`. Public-index targets automatically get `index-policy` and `discovery`; target engines also get `search-crawl-policy`. Naver as a target automatically activates `naver-markup`. Bare flags cannot turn these families off. A selected URL still gets `fetch-response` if intentionally non-indexed. An unreachable, uncollected or unclear check is `unknown`, never N/A.

`check-registry.json` fixes every family's `verdict_mode` and `na_conditions`. The family-level exclusion and unit N/A condition codes are:

| Family | Allowed condition codes |
|---|---|
| fetch-response | none |
| search-crawl-policy | `no_public_index_target`, `no_target_engine` (whole family only) |
| index-policy, discovery | `no_public_index_target` (whole family only) |
| render-content | `not_render_dependent` |
| document-title | `not_html` |
| canonical-consistency | `no_representative_url_policy` |
| internal-navigation | `not_link_based` |
| structured-data-truth | `markup_not_used_or_selected` |
| locale-links | `single_locale` |
| naver-markup | `naver_not_target` (whole family only), `not_html` (unit) |
| lcp-field, inp-field, cls-field | `outside_performance_scope` |
| question-coverage | `no_fixed_questions` (whole family only) |
| claim-support | `no_material_claims` |
| answer-clarity | `no_matching_questions` |
| original-value | `simple_contact_or_support` |
| entity-identity | `no_identified_entity` (whole family only) |
| fact-consistency | `no_evaluable_facts` |
| freshness-truth | `no_date_or_currentness` |
| source-transparency | `not_required_for_purpose` |

These codes identify a condition and point to evidence; the reference alone does not verify the evidence's truth. The collecting agent must preserve the actual evidence. A missing approved fact list for `fact-consistency`, or missing field performance data, is `unknown`, not an exclusion.

`question_panel` contains fixed `{id,question,category,goal?}` entries. Category is `brand` or `non_brand`; IDs are unique. `question-coverage` and `answer-clarity` require a nonempty panel. A partial `question-coverage` ratio uses the fixed panel length as its denominator.

Each page type has a stable ID and an array of `{original,normalized}` HTTP(S) URLs. Normalized URLs must be unique across types. Unit keys are deterministic:

| Unit scope | Key | Examples |
|---|---|---|
| URL | `family_id\|normalized_url` | `index-policy\|https://example.com/` |
| Engine and URL | `family_id\|engine\|normalized_url` | `search-crawl-policy\|google\|https://example.com/` |
| Origin | `family_id\|origin` | `lcp-field\|https://example.com` |
| Site | `family_id\|site` | `question-coverage\|site` |

`CheckObservation.check_id` equals its registered `family_id` in this evaluation version. Multiple modules can submit the same unit and verdict; it counts once. An unregistered unit or conflicting verdict is a contract error. For `pass` and `fail`, `q` is exactly 1 and 0. For `unknown` and `not_applicable`, `q` and `partial_basis` are null. Unit N/A also requires `applicability_decision:{condition,reason,evidence_ref}`; core policy units and fixed site/public units cannot use N/A. A confirmed noindex or target crawler block is `fail`, `q=0`, and a blocker. Missing policy evidence is `unknown`.

The 14 binary families do not accept partial; their applicable units use pass, fail or unknown. Optional units may use N/A only under the allowed condition decision above. `lcp-field`, `inp-field`, `cls-field`, `answer-clarity` and `original-value` accept `partial_basis:{kind:"threshold_half"}` with `q=0.5`. `question-coverage`, `claim-support` and `fact-consistency` accept `partial_basis:{kind:"ratio",numerator:int,denominator:positive_int}` with a matching interior ratio. `question-coverage` also requires denominator equal to the fixed panel length. A CWV verdict requires `measurement:{value,percentile:75,source_type:"field",unit}`; use `ms` for LCP/INP and `unitless` for CLS. An absent field measurement is `unknown`, not N/A.

## Weight and status calculation

`compileUnits(input,profile)` divides positive axis weight by applicable families, then engines, then fixed page types and URLs. Each nonempty page type gets equal share; URLs within a type get equal share. Site and origin units do not multiply with page count. Units marked `not_applicable` are removed and the remaining units in that family are renormalized. If a whole family has no units, it is removed from its axis. If an axis has no applicable families, the remaining positive axes are renormalized to 100. LLMO's P axis has zero weight. A weighted unit is `{key,family_id,engine,url,weight,state,q}`.

`scoreWeighted(units)` returns raw weighted totals `A` (applicable), `M` (measured) and `N` (measured credit), plus one-decimal display percentages: `score=100N/M`, `coverage=100M/A`, `missing_bounds=[100N/A,100(N+A-M)/A]`. `score` is null when `M=0`; `coverage` and `missing_bounds` are null when `A=0`. The bounds are all-missing-fail and all-missing-pass extremes, not a confidence interval. Internal comparisons use raw values with `1e-9` tolerance; display rounds only at the end.

`score(input)` returns ordered `ScoreResult[]` for SEO, optional NEO, AEO, GEO and LLMO. SEO is the default aggregate and is calculated directly, never from the mean of profile scores. Each result includes `{schema_version,evaluation_version,profile,A,M,N,score,coverage,missing_bounds,band,readiness_status,blockers,unknown_core,source_ref}`. Bands are `focus_improvement` (0–59), `major_improvement` (60–79), `additional_improvement` (80–94), and `remaining_review` (95–100). Status precedence is `not_applicable` for `A=0`, then `blocked` for confirmed access/crawl/noindex failures or an explicit severe-fact blocker, then `unverified` for unknown applicable access/index core units, then `provisional` below 80% measured coverage, else `measured`. `measured` means only that this optbrew readiness audit has enough measured coverage by its own rule.

Run a stored input without service access: `node skills/optbrew/scripts/cli.mjs score --input input.json --output score.json`. The output is the same JSON `ScoreResult[]` as the library call. The CLI validates before writing.
