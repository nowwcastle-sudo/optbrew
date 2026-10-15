# optbrew

[![npm](https://img.shields.io/npm/v/optbrew.svg)](https://www.npmjs.com/package/optbrew)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[한국어](README.ko.md)

A search-readiness audit skill for coding agents. optbrew checks a site for Google, Naver and AI answer engines, fixes the local files you approve, checks again under the same conditions, and writes a scored report built from replayable evidence.

- One skill for five profiles: **SEO**, **NEO** (Naver), **AEO**, **GEO** and **LLMO**.
- Five pinned audit guide bundles merged into 22 check families. An issue that several guides report is counted once.
- Every verdict in the report can be recomputed from the raw responses that were collected and hashed.
- No headline score when the evidence is thin: below 80% coverage the report shows the measured part and its bounds.
- Works with Codex, Claude Code, Cursor, OpenCode and Pi. Scoring and reports need no API account.

## Why optbrew

Being found now means three different things: ranking in Google, showing in Naver, and being cited in AI answers. Each has its own guides, and the guides overlap and disagree. An agent asked to "improve SEO" usually picks one checklist, edits files, and reports success without proof.

optbrew gives the agent one workflow and one scoring rule for all five profiles. It counts what it measured, marks what it could not measure as unknown instead of passing it, and keeps a local fix separate from a production result. A high readiness score is not a promise of traffic or citations, and the report says so.

## How it works

1. **Audit.** You give the URL, the goal and the scope. A collector fetches up to 50 URLs (depth 3, two at a time) and stores every response with its hash.
2. **Fix.** The agent proposes changes to local files. Nothing is edited, deployed or submitted without your approval.
3. **Re-check.** The same collection runs again under the same conditions, so the before and after are comparable.
4. **Report.** A score per profile with its coverage, blockers, open core checks, and separate tables for readiness, fixes, real outcomes and remaining work.

What the script measures by itself, and what still needs the guides and the agent's judgment:

| Profile | Target | Measured by the script | Left to judgment |
|---|---|---|---|
| SEO | Google and web search | Fetch status, `noindex` in meta and `X-Robots-Tag`, titles, robots.txt for Googlebot, canonical, redirect chains, discovery through links and sitemap, JSON-LD syntax | Content quality and intent fit |
| NEO | Naver | robots.txt for Yeti, Open Graph, description, canonical, viewport, title repetition, blocked CSS or JS | Naver-specific content guidance |
| AEO, GEO | Answer engines and AI search | robots.txt for the AI search bots in [ai-crawlers.md](skills/optbrew/references/ai-crawlers.md) (training bots are never scored) | Answer structure, claims, authorship, freshness |
| LLMO | How models describe you | Whether name, address, phone and founding year agree across pages | Whether those facts are true |

The scoring rule is in [scoring.md](skills/optbrew/references/scoring.md). The 80% coverage threshold is optbrew's own rule, not a search engine standard.

## Install

Requires [Node.js](https://nodejs.org) 22 or later. Python 3.10 or later is optional; without it, the internal Python audit utilities stay unrun. Pick one of the five methods. The examples install for Codex and Claude Code at user level; the agent IDs are `codex`, `claude-code`, `cursor`, `opencode` and `pi`.

### 1. npm

```bash
npm install -g optbrew@0.1.3
optbrew install --agents codex,claude-code --scope user --dry-run
optbrew install --agents codex,claude-code --scope user
optbrew doctor --agents codex,claude-code --scope user
```

The dry run prints the folders it will write. `doctor` checks the files and their hashes.

### 2. npx

Runs the same CLI without a global install:

```bash
npx optbrew@0.1.3 install --agents codex,claude-code --scope user
npx optbrew@0.1.3 doctor --agents codex,claude-code --scope user
```

In Windows PowerShell, if `npx` or `optbrew` reports that running scripts is disabled, call `npx.cmd` or `optbrew.cmd` instead.

### 3. PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.1.3/install.ps1 | iex
```

The script is pinned to this release. It checks Node.js, shows the target folders, installs for Codex and Claude Code, and stops with an error if `doctor` finds a problem. To read it first, or to choose agents or a project folder:

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.1.3/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Agents codex,claude-code,cursor
```

Add `-Scope project -Project C:\path\to\site` to install into one project.

### 4. Plugin

Claude Code:

```bash
claude plugin marketplace add nowwcastle-sudo/optbrew
claude plugin install optbrew@optbrew
```

Codex:

```bash
codex plugin marketplace add nowwcastle-sudo/optbrew
codex plugin add optbrew@optbrew
```

Plugins follow this repository's `main` branch and update through the host's plugin commands.

### 5. Ask your agent

Paste this into Codex, Claude Code or another coding agent:

```text
Install the optbrew skill for me. Read https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.1.3/AGENT_INSTALL.md and follow it step by step. Ask me which agents and which scope to use, and show me the planned changes before you install.
```

[AGENT_INSTALL.md](AGENT_INSTALL.md) gives the agent a command and a pass check for each step, and the cases where it must stop and ask you.

Installing from a source checkout, the Agent Skills CLI, Pi packages and Claude web uploads are covered in [platform support](docs/platforms.md).

## Quick start

Start a new agent session and ask, for example:

```text
Run optbrew on https://example.com. Goal: show up in Naver and get cited in AI answers.
```

optbrew asks for anything it is missing: site ownership or access, which local changes are allowed, and which evidence you already have. Raw evidence goes to `.optbrew/runs`. Private network addresses are fetched only when you declare a local target.

## Update

```bash
npm install -g optbrew@latest
optbrew update --scope user
```

With npx, run `npx optbrew@latest update --scope user`. `optbrew check-updates --package optbrew` compares your install with npm without changing anything. `npm update` alone does not touch copies already placed in agent folders; the `update` command does.

An install from 0.1.2 or earlier stops with `migration_required`, because 0.1.3 scores with a new evaluation version. Scores from different evaluation versions are not comparable. Follow [Reinstall after a migration_required update](docs/platforms.md#reinstall-after-a-migration_required-update); the steps delete only paths that a read-only check printed and never touch your audit evidence.

## APIs and cost

Nothing here requires a paid account. A direct Anthropic API call or an [SE Ranking](https://seranking.com/api.html) call needs your approval, a recorded budget and a stop condition first; a Claude subscription does not include API billing. Keys stay in your environment variables and never go into a report. Details: [API boundaries](skills/optbrew/references/api.md).

## Documentation

- [Platform support](docs/platforms.md): install paths per agent, checkout commands, reinstall steps
- [Scoring](skills/optbrew/references/scoring.md), [measurement](skills/optbrew/references/measurement.md) and [report evidence](skills/optbrew/references/report.md)
- [Changelog](CHANGELOG.md) and [release process](docs/release.md)

## Contributing

Contributions are welcome: bug reports, false positives from a real site, guide updates, translations and code. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

optbrew's own code is [MIT licensed](LICENSE). The bundled guides keep their own licenses, listed in [third-party notices](skills/optbrew/THIRD_PARTY_NOTICES.md). The Naver bundle keeps an index of the official [Search Advisor guides](https://searchadvisor.naver.com/guide) but not the 55 article bodies; follow the official links while online.
