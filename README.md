# optbrew

[한국어](README.ko.md)

Optbrew is a local skill and CLI for checking a site's search readiness, making approved local changes, and comparing evidence before and after. It combines five pinned source bundles—mblode SEO, Naver Search Advisor, Firecrawl SEO Audit, Magnus SEO, and SE Ranking SEO—with seven selected marketing guides. One top-level `SKILL.md` routes to the included guides. The bundle works from its pinned files; it does not fetch a moving upstream revision during a run.

The CLI can calculate a score and write a report from stored JSON without an API account. A site audit needs a declared target and scope. Publication, search engine submission, remote site changes, and paid calls require separate authority. Read [platform support](docs/platforms.md) for the difference between installing a file and confirming that a host invoked it.

## Install

Requires Node.js 22 or later. The internal Python audit utilities need Python 3.10 or later; missing Python leaves those utilities unrun. From this checkout, first inspect the targets in an isolated project directory named `site`:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --dry-run --json
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --json
node bin/optbrew.mjs doctor --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --json
```

Create `site` first and run these commands from the repository root. `--strategy link` is the default; `copy` also works when links are unavailable. The managed record lives under that project's `.optbrew/install`. For one host, replace the comma-separated list with its exact ID: `codex`, `claude-code`, `cursor`, `opencode`, or `pi`. Use `--scope user` only when you intend to install into user-level host directories. The install command checks the bundle manifest and refuses to replace an unmanaged target.

To get the checkout, clone `https://github.com/nowwcastle-sudo/optbrew` and run the commands above from its root. `npm install -g optbrew` installs the same CLI as an `optbrew` command; replace `node bin/optbrew.mjs` with `optbrew` in the commands above. Native host distribution and the ZIP path are described in [platform support](docs/platforms.md).

## First use

Ask the host to use optbrew with the target URL, goal, site ownership or access, allowed local changes, and available evidence. For a local audit, declare the URL scope before collection. The default collection ceilings are 50 URLs, depth 3, and concurrency 2; private addresses need an explicit local target. The workflow records raw evidence, readiness observations, local changes, and follow-up checks. It does not infer a site's production result from a passing local test.

The examples below replay bundled synthetic fixtures. They make no provider call. Run them from the checkout root and choose fresh output paths:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs score --input ./before.json --output ./score.json
node bin/optbrew.mjs compare --before ./before.json --after ./after.json --output ./comparison.json
node bin/optbrew.mjs report --input ./remote-only.json --output-dir ./report-output
```

For those literal commands, copy `tests/fixtures/scoring/before.json` and `after.json` into the current directory, and copy `tests/fixtures/reports/remote-only.json` plus its sibling evidence files into the current directory. For real work, pass your own validated `ScoreInput` or `ReportPacket` paths. See [scoring](skills/optbrew/references/scoring.md), [measurement](skills/optbrew/references/measurement.md), and [report evidence](skills/optbrew/references/report.md) for the contracts.

## Score and report

The five optbrew readiness profiles are SEO, NEO when Naver is a target, AEO, GEO, and LLMO. The 22 unique check families are counted once even when several guides find the same issue. An unknown applicable check remains in the denominator; an evidenced `not_applicable` check is excluded. The result includes score, measured coverage, missing-data bounds, blockers, and unresolved core checks. The 80% coverage threshold is an optbrew rule, not a search engine standard. A high readiness score does not prove indexing, traffic, citations, accuracy, conversions, or revenue.

The report keeps readiness, remedies, actual outcomes, and remaining work in separate tables. Actual outcomes need owner exports or a fixed AI question panel. A normal outcome comparison uses two complete, adjacent 28-day windows with matching definitions and filters. A local edit remains local until deployment and a production observation have their own evidence.

## APIs and cost

API access is optional. A Claude or Claude Code subscription does not supply Anthropic API billing. To use a direct API key, follow the [official key guide](https://platform.claude.com/docs/en/get-api-key): Console → Settings → API keys. Put the key in the `ANTHROPIC_API_KEY` environment variable in your own shell or secret manager; never put a real value in a report. A key spanning multiple Anthropic workspaces may require an `anthropic-workspace-id` header. The direct adapter introduced in v0.1.0 still does not set that header, so use a compatible key or a separately approved host capability.

The direct adapter accepts only text `{model,max_tokens,messages}` requests for the exact model IDs `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. `max_tokens` cannot exceed 128,000. Each attempt needs one token reservation of at least `1,000,000 + max_tokens`, a matching ledger budget, and an approval reference. This is a worst-case capacity bound, not a bill estimate. Record the current price source, estimated spend, and approved stop condition before the first paid call. Extra fields, tools, search, non-text input, unknown models, or currency-only bounds make zero direct calls. See [API boundaries](skills/optbrew/references/api.md).

SE Ranking has its own [API](https://seranking.com/api.html), [MCP instructions](https://seranking.com/api/integrations/mcp), account plan, and credits. Its [HTTP MCP endpoint](https://api.seranking.com/mcp) uses its documented OAuth or direct-token path, independently of `ANTHROPIC_API_KEY`. Available tools depend on the subscription. Neither connection is required for offline scoring. Use actual account prices and credits when deciding whether to run a paid capability; no price is built into this README.

## Update and rollback

For a managed project installation, rebuild or obtain a verified newer optbrew bundle before updating. From the checkout root:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs check-updates --json
node bin/optbrew.mjs update --scope project --project ./site --json
node bin/optbrew.mjs rollback --scope project --project ./site --release-version 0.1.0 --json
```

`check-updates --package optbrew` reads the latest version from the npm registry; without `--package` it reports `local_only`. `update` uses the current CLI bundle, verifies it, and updates all targets in that install record; it does not silently replace local edits. `rollback` needs that version in the record's retained prior releases. The shown rollback will therefore fail on a fresh 0.1.1 install and applies to a managed installation that retains local 0.1.0. `npm update -g optbrew` updates npm's package files after release; it does not rewrite a copy already placed in an agent skills directory. Run the managed `update` command again after updating the CLI. Native plugin and Pi package update paths are in [platform support](docs/platforms.md).

## Support and license

Managed install, doctor, update, and rollback cover Codex, Claude Code, Cursor, OpenCode, and Pi at the documented default paths. Custom host directories, project trust, and session reload rules can change discovery. Ordinary ChatGPT chat uses attached files and instructions; it is not the same installation path as Codex or a Work/desktop plugin. Claude web requires manual ZIP upload and re-upload for updates. Host discovery and a successful real invocation require separate checks.

The Naver bundle retains an index of official [Search Advisor guides](https://searchadvisor.naver.com/guide). It excludes the 55 original Naver article bodies, so full offline article lookup is unavailable. Follow the official links while online. Included source licenses and changes are listed in [third-party notices](skills/optbrew/THIRD_PARTY_NOTICES.md); optbrew's own code is [MIT licensed](LICENSE). Service access and API data rights are separate from those code licenses. Release packaging and verification are in [release instructions](docs/release.md).
