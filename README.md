# optbrew

[![npm](https://img.shields.io/npm/v/optbrew.svg)](https://www.npmjs.com/package/optbrew)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[한국어](README.ko.md)

A search-readiness audit skill for coding agents. optbrew checks a site for Google, Naver and AI answer engines, fixes the local files you approve, checks again under the same conditions, and writes a scored report built from replayable evidence.

- One skill for five profiles: **SEO**, **NEO** (Naver), **AEO**, **GEO** and **LLMO**.
- One call for a beginner: answer one set of start questions, then the agent runs the whole audit and hands you an HTML report.
- Five pinned audit guide bundles merged into 22 check families. An issue that several guides report is counted once.
- Every verdict in the report can be recomputed from the raw responses that were collected and hashed.
- No headline score when the evidence is thin: below 80% coverage the report shows the measured part and its bounds.
- Works with Codex, Claude Code, Cursor, OpenCode and Pi. Scoring and reports need no API account.

## Why optbrew

Being found now means three different things: ranking in Google, showing in Naver, and being cited in AI answers. Each has its own guides, and the guides overlap and disagree. An agent asked to "improve SEO" usually picks one checklist, edits files, and reports success without proof.

optbrew gives the agent one workflow and one scoring rule for all five profiles. It counts what it measured, marks what it could not measure as unknown instead of passing it, and keeps a local fix separate from a production result. A high readiness score is not a promise of traffic or citations, and the report says so.

## How it works

1. **Ask.** You give the URL. optbrew reads the start page, the sitemap and your setup (Chrome, a Google key, network access). Then it sends one message with the start questions: your guidance level, the goal, the questions people search for, the facts it read from the site, and the page limit. Reply with an answer for each number, or just "start" to take the defaults. If one thing blocks the audit, such as a network that is closed, you get one setup guide first. Up to three more guides appear as one-line offers; you open one by answering with its word.
2. **Audit.** One command collects the pages, renders them in a headless Chrome of its own, measures speed and runs the code checks. It audits pages from the sitemap and from links on the start page, up to your limit: 50 pages by default, up to 200 if you raise it. The limit counts every request, so redirects and the robots and sitemap files use part of it. It follows a redirect to the `www` or `https` twin of your address and says so in the report. It stores every response with its hash.
3. **Judge.** The agent reads the page text that code cannot judge, such as claims, answer clarity and freshness. It cites the sentences it relied on. A second call of the same command checks that the cited text exists in the evidence, then scores.
4. **Report.** You get three files with the same content: `report.html` (open this one; it is a single self-contained file), `report.md` and `report.json`. The text is in Korean. Each problem has one fix with the number of pages it affects. A numbered list of steps tells you how to fill each blank, such as a missing Google key. Blanks are shown as unknown, never as a pass.
5. **Fix and re-check (optional).** The agent proposes changes to local files. Nothing is edited, deployed or submitted without your approval. After you deploy, the same collection runs again under the same conditions, so the before and after are comparable.

What the script measures by itself, and what still needs the guides and the agent's judgment:

| Profile | Target | Measured by the script | Left to judgment |
|---|---|---|---|
| SEO | Google and web search | Fetch status, `noindex` in meta and `X-Robots-Tag`, titles, robots.txt for Googlebot, canonical, redirect chains, discovery through links and sitemap, JSON-LD syntax | Content quality and intent fit |
| NEO | Naver | robots.txt for Yeti, Open Graph, description, canonical, viewport, title repetition, blocked CSS or JS | Naver-specific content guidance |
| AEO, GEO | Answer engines and AI search | robots.txt for the AI search bots in [ai-crawlers.md](skills/optbrew/references/ai-crawlers.md) (training bots are never scored) | Answer structure, claims, authorship, freshness |
| LLMO | How models describe you | Whether name, address, phone and founding year agree across pages, and whether the pages describe one business | Whether those facts are true |
| All | Speed and scripts | Whether the text still shows after JavaScript runs in Chrome. Field Core Web Vitals (LCP, INP, CLS) from Google's Chrome UX Report and PageSpeed Insights | Nothing. The Chrome lab values are shown as a run condition and are never scored |

Engine-specific checks run for the engines you name as targets. Name the AI answer engines you care about, such as ChatGPT, Claude or Perplexity. Naver is added on its own when the goal, an export or the site's language points to it. The scoring rule is in [scoring.md](skills/optbrew/references/scoring.md). The 80% coverage threshold is optbrew's own rule, not a search engine standard.

## Install

Requires [Node.js](https://nodejs.org) 22 or later. Python 3.10 or later is optional; without it, the internal Python audit utilities stay unrun. Pick one of the five methods. The examples install for Codex and Claude Code at user level; the agent IDs are `codex`, `claude-code`, `cursor`, `opencode` and `pi`.

In Windows PowerShell, if `npx` or `optbrew` reports that running scripts is disabled, type `npx.cmd` or `optbrew.cmd` instead.

### 1. npm

```bash
npm install -g optbrew@0.2.0
optbrew install --agents codex,claude-code --scope user --dry-run
optbrew install --agents codex,claude-code --scope user
optbrew doctor --agents codex,claude-code --scope user
```

The dry run prints the folders it will write. `doctor` checks the files and their hashes.

### 2. npx

Runs the same CLI without a global install:

```bash
npx optbrew@0.2.0 install --agents codex,claude-code --scope user
npx optbrew@0.2.0 doctor --agents codex,claude-code --scope user
```

### 3. PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/install.ps1 | iex
```

The script is pinned to this release. It checks Node.js, shows the target folders, installs for Codex and Claude Code, and stops with an error if `doctor` finds a problem. To read it first, or to choose agents or a project folder:

```powershell
irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/install.ps1 -OutFile install.ps1
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

claude.ai, Claude Desktop and Cowork: open Customize > Plugins, choose Add > Add marketplace, enter `nowwcastle-sudo/optbrew`, then add `optbrew`.

Plugins follow this repository's `main` branch and update through the host's plugin commands or marketplace sync.

### 5. Ask your agent

Paste this into Codex, Claude Code or another coding agent:

```text
Install the optbrew skill for me. Read https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.2.0/AGENT_INSTALL.md and follow it step by step. Ask me which agents and which scope to use, and show me the planned changes before you install.
```

[AGENT_INSTALL.md](AGENT_INSTALL.md) gives the agent a command and a pass check for each step, and the cases where it must stop and ask you.

Installing from a source checkout, the Agent Skills CLI, Pi packages and Claude web uploads are covered in [platform support](docs/platforms.md).

## Quick start

Start a new agent session and ask, for example:

```text
Run optbrew on https://example.com. Goal: show up in Naver and get cited in AI answers.
```

optbrew then checks your setup and sends the start questions in one message. Answer each number, or reply "start" to accept the defaults. A missing Google key, Chrome or export file does not stop the audit. The blank is listed in the report with the steps to fill it.

The audit takes a few minutes. Everything it writes goes to `optbrew-audit/<site>-<date>` in your working folder: the evidence (every response with its hash) and the three reports. Open `report.html` first. The same name with a number added (`-2`, `-3`) is used when the folder already exists. Private network addresses are fetched only when you declare a local target.

### Google API key (optional)

A free Google API key fills the speed scores that real visitors get (LCP, INP, CLS). When optbrew offers it, answer "key" to see how to get one. Then save it from your own terminal, never in the chat. In Codex and Claude Code cloud, the key guide shows where to save it instead.

```bash
optbrew key set google
optbrew key status
optbrew key remove google
```

`set` asks for the key with hidden input. `status` shows only whether a key exists and the first 8 characters of its hash. `remove` deletes it. Without the npm CLI, the skill folder has the same command: `node <skill folder>/scripts/key.mjs set google`. The key is saved in `.optbrew/credentials.json` in your home folder, outside every project, and the environment variable `OPTBREW_GOOGLE_API_KEY` takes priority if it is set. optbrew sends the key to Google only in a request header, and never writes it to a report, a log or the evidence.

## Update

```bash
npm install -g optbrew@latest
optbrew update --scope user
```

With npx, run `npx optbrew@latest update --scope user`. `optbrew check-updates --package optbrew` tells you, without changing anything, whether npm has a newer release than the CLI you are running; `optbrew doctor --json` shows the `release_version` installed in your agent folders. `npm update` alone does not touch copies already placed in agent folders; the `update` command does.

### Upgrading from 0.1.x

0.2.0 changes the evaluation version (0.4.0), the audit protocol (0.2.0) and the contract schema (2.0.0). So:

- A managed install of any 0.1.x release stops with `migration_required`, and `optbrew update` changes nothing. Follow [Reinstall after a migration_required update](docs/platforms.md#reinstall-after-a-migration_required-update); the steps delete only paths that a read-only check printed and never touch your audit evidence.
- A plugin install (Claude Code, Codex, claude.ai) follows `main`, so the plugin update commands of your host work as before.
- An output folder or evidence packet from a 0.1.x run is refused with one sentence: run the audit again in a new folder. Scores from different evaluation versions are not comparable, so `compare` reports `not_comparable` against a 0.1.x baseline. Run the baseline audit again with 0.2.0.

## APIs and cost

Nothing here requires a paid account. A direct Anthropic API call or an [SE Ranking](https://seranking.com/api.html) call needs your approval, a recorded budget and a stop condition first; a Claude subscription does not include API billing. The Google key above is your own, and the Google speed services it calls are free. Keys stay in your environment variables or the key file and never go into a report. Details: [API boundaries](skills/optbrew/references/api.md).

## Documentation

- [Platform support](docs/platforms.md): install paths per agent, checkout commands, reinstall steps
- [Scoring](skills/optbrew/references/scoring.md), [measurement](skills/optbrew/references/measurement.md) and [report evidence](skills/optbrew/references/report.md)
- [Changelog](CHANGELOG.md) and [release process](docs/release.md)

## Contributing

Contributions are welcome: bug reports, false positives from a real site, guide updates, translations and code. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

optbrew's own code is [MIT licensed](LICENSE). The bundled guides keep their own licenses, listed in [third-party notices](skills/optbrew/THIRD_PARTY_NOTICES.md). The Naver bundle keeps an index of the official [Search Advisor guides](https://searchadvisor.naver.com/guide) but not the 55 article bodies; follow the official links while online.
