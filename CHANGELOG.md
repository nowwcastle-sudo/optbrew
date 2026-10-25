# Changelog

## 0.3.2

Fixes from a `skill-judge` review of the 0.3.1 skill (101/120). Each item was checked against the code first; only real problems were changed. No verdict, score or report output changes.

- **SKILL.md no longer names release 0.2.0 in step 10.** The note about change records said "0.2.0 보고서는 …". The behavior is the same in this release (the report still reads no change record, `verification` stays `pending`, `backup_ref` is a file path), so the note now states it without a version.
- **The `anthropic-api-key` runbook is removed.** It said the key turns on a feature where optbrew calls the Claude API directly, but no audit step and no `cli.mjs` command calls that adapter, and SKILL.md says the flow has no paid call. `api.md` now says so too. The guarded adapter and its tests stay. The `seranking` runbook stays: SKILL.md now says to open it only when the user asks for SE Ranking and approves.
- **SKILL.md says when to read each reference.** `scoring.md`, `measurement.md`, `ai-crawlers.md` and `api.md` each get a one-line condition, and `bundle-manifest.json` and `source-lock.json` are marked as install files that an audit does not read. The two JSON files stay in the skill folder: `score.mjs` and the installer read them there.
- **The progress-language rule is in one place.** It stood in three places (지킬 것, the borrowed caveman paragraph, 진행 문장의 언어); it now stands once under 진행 보고. The caveman source and change notice above that paragraph stays, because Apache-2.0 asks for a notice on a changed file.
- **`references/report.md` and `api.md` break long paragraphs at sentence ends.** report.md had a 6,251-character line, and some read tools cut a line at 2,000 characters. The words are unchanged; only line breaks were added.

### Versions

Release 0.3.2, evaluation 0.5.0, audit protocol 0.3.0, contract schema 2.0.0. No evaluation source changed, so the evaluation hash is the same as 0.3.1, a managed 0.3.1 install updates in place, and a 0.3.1 output folder is still accepted.

## 0.3.1

Fixes from a real 0.3.0 audit of a public Korean care-facility site in a Claude Code cloud session.

- **Chrome renders behind an environment proxy.** A direct (pinned) launch now passes `--no-proxy-server`. Before, a proxy named in `https_proxy` took over, the host rules sent Chrome to the wrong address for it, and every rendered page failed with `net::ERR_PROXY_CONNECTION_FAILED`. The render checks stayed unknown, and the SEO profile could fall under its coverage floor.
- **The Playwright Chromium of cloud containers is found.** `findChrome` also looks for the older `chrome-linux/chrome` layout (and `chrome-win`, `chrome-mac`) under `PLAYWRIGHT_BROWSERS_PATH`.
- **A Korean address in the other order is the same address.** `fact-consistency` no longer fails "경기도 가상시 예시읍 샘플로 12-34" against a confirmed "예시읍 샘플로 12-34, 가상시, 경기도" (the JSON-LD order). 시/도 endings are dropped on both sides before the order-free comparison. `facts.mjs` and `messages.ko.json` are evaluation sources, so the evaluation hash changes.
- **The date fix shows a placeholder date.** The freshness fix said 「2026년 10월 17일 기준」, a fixed day that reads wrong on any other day. It now says 「○○○○년 ○월 ○일 기준」.
- Lab CLS in 실행 조건 is shown to three decimals (it printed `0.000861425586819861`).
- A particle typo in the `cwv-site-collection` runbook (페이지을 → 페이지를).

From the site team's review of that audit:

- **A Korean PostalAddress is offered in Korean order.** The confirmed-fact candidate built from JSON-LD `streetAddress`, `addressLocality` and `addressRegion` read "예시읍 샘플로 12-34, 가상시, 경기도" (the English order with commas). When the parts are in Hangul it is now "경기도 가상시 예시읍 샘플로 12-34", the way the page prints it, so no fix asks the owner to rewrite a correct address. An English address keeps its commas.
- **An organization's own operating facts are not unsourced claims.** `claim-support` (judging.md) no longer counts what the organization says about itself: hours, capacity, current number of users, contact, address, its own price list. The organization is the first-hand source of these facts, and `freshness-truth` checks when they were true. Effects, comparisons and figures taken from others still count.
- **An empty-list notice is not a time-sensitive fact.** `freshness-truth` no longer fails a page only for 「아직 올린 지난 식단이 없어요」, and the cited text must be the changeable fact itself (hours, dates, 「지금 31명 이용 중」), because the report shows it as 「해당 글」.
- report.md says under the scores, as report.html does, that a score is the pass rate within the checked range, not search ranking or traffic.

Examples in judging.md, code comments, tests and design notes now use made-up names, addresses and numbers instead of a real organization's.

### Versions

Release 0.3.1, evaluation 0.5.0, audit protocol 0.3.0, contract schema 2.0.0. The evaluation version stays 0.5.0, so a managed 0.3.0 install updates in place and a 0.3.0 output folder is still accepted. The evaluation hash changed: `fact-consistency` now passes an address that 0.3.0 failed only for its order, so a `compare` against a 0.3.0 baseline can show that one change as a gain.

### Not checked here

- A site's own field Core Web Vitals collection (for example a web-vitals endpoint) is not read. Field CWV comes only from the Chrome UX Report with a Google key or from a Search Console export, so such a site still shows the field values as missing.

## 0.3.0

Fixes what a real audit conversation showed: text the user never saw, a judgments file that kept filling with placeholders, and a plain report page.

### What you see

- **Runbooks are shown, not just read.** `cli.mjs runbook --ids <id> --level <level>` prints the runbook as Markdown to paste into the reply; the export answer prints Search Console and Naver Search Advisor together. SKILL.md now says the user sees only the last message of a turn, so start questions and runbooks go there whole, with no status recap after them.
- **One judgments file per page.** The first call writes `judge-queue/site.json` and `judge-queue/p001.json`… in place of the single `judge-queue.json`, and its JSON names the folder (`judge_pages`) and the page count (`pages`). The `judge_queue` field is gone. The agent writes `judgments/p001.json`… as it goes, and `--judgments` takes that folder. A page left out, or an entry that is a stand-in (`…`, `TODO`, `나머지 동일`, a missing field), is refused by file name and position before anything is merged.
- **Smaller files for the model to read.** A page file keeps the address, the evidence reference and hash, the units to judge, and for each span only `span_id` and `text` (plus `site_chrome` on a line most pages repeat). The hash and byte range of a span stay in the stored queue, where the merge reads them. The files are compact JSON with no indentation. A page of 30 Korean spans went from 10,340 to 5,436 bytes, and a 31-page audit from 51,376 bytes in one file to 30,303 bytes across the folder.
- **A report page that reads by importance.** Bold type, a new palette, the conclusion largest, the first three fixes as large cards; the same problem on several pages is one card with each page under it, and the fix method shows on the card. Profiles sit in one grid with the excluded-units note said once. Visible focus, theme colour, tabular numbers; all text pairs at 4.5:1 or more in both themes.
- **Goals choose the checks.** The goals of the start questions are read through one word table (`goals.mjs`) into five ids: `search`, `naver`, `ai_citation`, `brand_facts` and `conversion`. 문의, 예약, 상담 and 전화 mean conversion. The ids go into the audit protocol as `protocol.goals`, so a change of goals makes `compare` report `goals_changed`.
- **AI search crawlers have their own check.** With the AI answer citation goal (one of the default goals), ChatGPT, Claude and Perplexity become target engines. The new `ai-crawler-policy` family reads robots.txt for OAI-SearchBot, Claude-SearchBot and PerplexityBot. A blocked AI bot lowers the score and is never a blocker. `search-crawl-policy` now covers Google and Naver only. In both families a robots.txt that answers 4xx (except 429) allows every path, as RFC 9309 says; 429, 5xx and an unanswered request stay undecided.
- **A contact route when the goal is conversion.** The new `conversion-path` family passes when an audited page, raw or rendered, offers one way to get in touch: a `tel:`, `sms:` or `mailto:` link, a phone number shown as text, a KakaoTalk channel or open chat, Naver TalkTalk, Naver booking, or a same-site link to an inquiry, consultation or booking page. With none it fails, or stays unknown when the site shows its content only after rendering. Without the conversion goal it is not applicable.
- **Confirmed facts are the reference.** The facts you confirm in the start questions go into the protocol as `protocol.confirmed_facts`. `fact-consistency` fails a page whose name, phone, address or founding year differs from them, with its own message (`fact-consistency.confirmed-differs`). A confirmed type is no longer voted on across pages, and one audited page alone can now be judged. A mobile `tel:` link beside a confirmed landline still passes.
- **Naver ownership is remaining work, not a score.** When Naver is a target, no Naver export was read and the start page has no `naver-site-verification` meta tag, the report adds one row under 남은 일. It points to steps 1 to 4 of the Search Advisor runbook. A site verified by an uploaded HTML file loses nothing.
- **Every problem has its own fix.** Each message a check can state now has its own method, check, effort and place in `messages.ko.json` (`<key>.mechanism`, `.validation`, `.effort`, `.location_hint`). A missing title and a duplicate title no longer share one sentence. A test fails when a check block declares a message key without all four. The catalog in `remediations.json` still supplies the cost and the official source beside the method, and the Korean text it carried is now only the fallback for a finding whose key has no steps. The 36 methods are written as steps an owner can follow: one fact per sentence, short active sentences, placeholders kept.
- **`fixes.md` beside the report.** The report step writes `fixes.md`: every open fix with its `finding_id`, all the pages it affects, the problem, the method, how to check it and where to fix it. It is built from `composed.fixes`, so a replay of an old packet gives the same list, and the done JSON names it in `reports.fixes`. The text is escaped as in `report.md`, so a tag such as `<title>` reads `&lt;title&gt;` in the raw file.
- **Fix a file with two commands.** `cli.mjs change start --out <OUT> --root <source folder> --path <file> --finding <id>` copies the file once to `<OUT>/changes/backup/` and notes the change. `change finish --out <OUT> --path <file>` writes the `ChangeRecord` from the hash of that copy and of the file as it is. A path outside the source folder (`..` or a link) is refused, and so are a second start for the same file and a finish when the file did not change. SKILL.md step 10 no longer asks for per-system hash commands or a hand-written record, and the backup no longer sits beside the source file.
- **`cli.mjs` reads its options with `parseArgs`.** The options of `score`, `compare`, `report` and `runbook` may now come in any order. An unknown, repeated, missing or empty option is still refused with the same usage line.

### Versions

Evaluation 0.5.0 (was 0.4.0), audit protocol 0.3.0 (was 0.2.0), contract schema 2.0.0. The registry gains `ai-crawler-policy` and `conversion-path`. Scores of 0.2.x runs are not comparable: `compare` reports `not_comparable` against a 0.2.x baseline, and a 0.2.x output folder is refused with `migration_required`.

### Upgrading from 0.2.x

- A managed 0.2.x install stops `optbrew update` with `migration_required` and changes nothing. Replace it with the blocks in `docs/platforms.md`, "Reinstall after a migration_required update".
- Run the baseline audit again before you compare.

### Known limitations

- `conversion-path` does not see a form with no link to it, a button that opens a chat by script, or a contact route shown only in an image.
- An unlabelled phone number in plain text counts only in a Korean dialling shape (a leading 0 and 9 to 11 digits, or an 8-digit 15xx, 16xx or 18xx number).
- Confirmed facts are compared value by value. A page that writes the business name only in English beside a confirmed Korean name fails.
- A result folder holds one change record per file. A file that already has a finished record cannot be started again, so name every finding that changes a file when you start. `change start` does not check the finding ids against `report.json`.

## 0.2.2

Corrects the 0.2.1 key guidance after a live check, and makes `key status` show where a key came from. The audit itself is unchanged.

### What you see

- **Desktop app: use the key file.** Measured on 2026-10-18 on Windows: in a session the Claude desktop app started (its bundled claude.exe 2.1.299), the plugin's SessionStart hook ran, but `CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY` did not reach the session. A `claude -p` session from terminal `claude` 2.1.302 on the same PC did receive it. Whether the desktop app or version 2.1.299 makes the difference is not separated. `key-set-local` now says first: with the desktop app, use `key set google`. The plugin setting stays as the terminal option.
- **Where `/plugin` is.** The `/plugin` screen (**Installed**, optbrew, **Configure options**) exists in terminal `claude`, not in the desktop app's Code tab. The runbook now says: open a terminal, run `claude`, then `/plugin`.
- **READMEs and `docs/platforms.md`** carry the same desktop-app note, the terminal `/plugin` path and the conditional order.
- **The order is conditional.** The plugin setting comes before `OPTBREW_GOOGLE_API_KEY` and the key file only when its value reaches the session.
- **`key status` names its sources.** A new `google.sources` field shows, without values: `plugin_setting` (true or false), `env` (true or false), `key_file` (`present`, `absent` or `corrupt`), and `used` (`plugin_setting`, `env`, `key_file` or null). `google.present` and `google.sha256_8` are unchanged.
- **The hook leaves a trace.** When no plugin setting reached it, `plugin-key-env.mjs` writes one stderr line and exits 0. Per the Claude Code hooks reference, the stderr of a hook that exits 0 goes to the debug log, not to Claude or the session; stdout stays empty because a SessionStart hook's stdout becomes session context.

### Versions

Release 0.2.2, evaluation 0.4.0, audit protocol 0.2.0, contract schema 2.0.0. Scores from 0.2.0 to 0.2.2 are comparable.

### Not checked here

- The root cause of the desktop-app gap. The new stderr line and `key status` `sources` are the tools to separate it in a later live check.
## 0.2.1

Answers the Claude plugin directory review of 0.2.0. The audit itself is unchanged; evaluation 0.4.0, audit protocol 0.2.0 and contract schema 2.0.0 stay.

### What you see

- **Google key in the Claude plugin settings.** With the Claude Code plugin you can enter the Google API key in `/plugin`, **Installed**, optbrew, **Configure options** instead of running `key set google` in a terminal. Claude Code keeps it in the system credential store. A new session picks it up. The key is optional, as before. The order optbrew reads the key in is now: the plugin setting, then `OPTBREW_GOOGLE_API_KEY`, then `.optbrew/credentials.json`. npm, Codex and the other hosts keep the variable and the key file.
- **Key guides.** `key-set-local` and `google-api-key` name the plugin setting. `key remove google` now says a key is still set outside the key file when the variable or the plugin setting holds one.

### Directory review answers

- `MANIFEST_VERSION_MISSING`: the served `skills/.claude-plugin/plugin.json` now carries the release version. Before, it carried none so that every commit reached marketplace sync; now installed copies move only when a release changes the version. The marketplace entry still carries none (the manifest's version overrides it). The version-consistency test and `verify-release.mjs` check the served manifest.
- `MCP_FORWARDS_CREDENTIAL_ENV`: the served manifest declares `userConfig.google_api_key` (`sensitive: true`). Claude Code gives a sensitive value only to hooks, so a new SessionStart hook (`skills/hooks/hooks.json`, exec form, `node` with `plugin-key-env.mjs`) appends it to `CLAUDE_ENV_FILE` as one single-quoted `CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY` line, and only when the value is letters, digits, `_` and `-`. The hook prints nothing and never echoes the value. Trade-off: the value then sits in the session's env file and in every shell command of the session, like the variable did. The flagged module guides (`seranking-seo` `seo-api` references, `seo-google/GUIDE.md`, `references/api.md`) are documentation only, and each sends a key to its own vendor (SE Ranking, Google, Anthropic); they are unchanged.
- `UNREAD_ASSET_REFERENCED` on `modules/seranking-seo/skills/seo-api/references/api-surface-map.md`: the file names no image or font, and nothing runs it (only `seo-api/GUIDE.md` links it as a reference). Unchanged; it is a pinned vendored file (`source-lock.json`).
- `RUNTIME_FETCH_EXEC` on `modules/magnus-seo/references/ghost-metadata.md`: its three `curl -s … | grep` lines read a page and filter it; nothing is run. Documentation only and pinned; unchanged.

### Versions

Release 0.2.1, evaluation 0.4.0, audit protocol 0.2.0, contract schema 2.0.0. Scores from 0.2.0 and 0.2.1 are comparable.

### Not checked here

- The hook was tested with a fake key and a temporary env file, not in a live Claude Code session with the plugin installed. Check after the merge: set the key in **Configure options**, start a new session, and `node "<skill folder>/scripts/key.mjs" status` shows `"present":true`. Check it on Windows too.
- The Claude Code desktop app's plugin screen for **Configure options** was not seen.

## 0.2.0

The beginner audit in one call. You answer one set of start questions, the agent runs the whole audit, and you get an HTML report in Korean with the fixes in order and the blanks explained.

### What you see

- **One call.** The agent checks your setup (`preflight.mjs`), sends the start questions in one message (one setup guide at most when something blocks the audit, plus up to three one-line offers), runs the audit with one command (`run.mjs`), judges the page text that code cannot judge, runs the same command again with `--judgments`, and hands you three reports: `report.html`, `report.md` and `report.json`. You answer once. The questions, guides and report are in Korean, and "시작" (start) takes every default.
- **Which pages.** The audit takes pages from the sitemap and from links on the start page, up to the limit you choose: 50 pages by default, up to 200. The limit counts every request, including redirects and the robots and sitemap files. The same site gives the same pages every time. An address that redirects to its `www` or `https` twin is followed, and the report says so. A redirect to a different site stops the run with one sentence.
- **Pages the site keeps out of the index.** A page with `noindex` that is not the home page and is missing from the site's own sitemap (a contact form, a thank-you page) is treated as meant that way: it gets no index, sitemap, crawler, title, canonical or Naver markup check and is no blocker. The run conditions list these pages. Without a sitemap that lists pages, a `noindex` stays a blocker.
- **Which engines.** Google is always a target. Naver is a target when a goal names it, when you give a Naver export, or when the site is Korean (`lang="ko"` or an address ending in `.kr`).
- **One fix per problem.** Pages with the same problem are one fix that lists how many pages it affects, instead of one finding per page. The fixes are sorted by what to do first.
- **Fixes the model judged.** A missing date, an unnamed operator or a claim with no source is worded in Korean from the message catalog, one fix per page: the problem (an answer-clarity fail names its question), the page, the text it cites, where to look, what to do, how much work, and how to check. The model's own reason stays in `report.json` as evidence.
- **Questions.** A page may answer several of your start questions, and a line every page repeats (a footer phone number) counts for a question when the model cites it for that question. A question with no answering page reads "not found within the pages read", never "the site lacks it".
- **Korean report.** Every sentence in `report.md` and `report.html` is Korean: the fixes and the remaining work. A few ids in the run conditions stay English, and so do JSON keys and ids. The HTML report is one self-contained file with no script and no outside request. Runbook steps are a plain numbered list. A step shows a screen drawing only where a runbook names the position, and no runbook does yet.
- **Speed scores.** Core Web Vitals of real visitors (LCP, INP, CLS) come from Google's Chrome UX Report and PageSpeed Insights when they have data. A free Google API key makes this work; without one those cells can stay blank, with the steps to get a key in the report. The lab values measured in your Chrome are shown as a run condition and are never scored.
- **Google key command.** `optbrew key set google`, `optbrew key status` and `optbrew key remove google` (or `node <skill folder>/scripts/key.mjs ...`). You run it in your own terminal with hidden input. The key is saved in `.optbrew/credentials.json` in your home folder, outside every project; `OPTBREW_GOOGLE_API_KEY` takes priority. It is sent to Google only in a request header and is never written to a report, a log or the evidence. The agent never asks for it in the chat.
- **Chrome.** The audit renders up to 10 pages, one of each kind, in a headless Chrome of its own, with a temporary profile that it removes at the end. Your running Chrome is never touched. The audit works through a proxy (`HTTPS_PROXY`); proxy credentials are never recorded. Without Chrome the render checks are blank, with the steps to install it.
- **Owner exports.** A Search Console zip and a Naver Search Advisor text file are read when you give their paths. Their numbers appear as actual outcomes and do not enter the score.
- **Setup guides (runbooks).** Step-by-step guides cover what needs your account or your machine: a Google API key and where to save it (your terminal, Codex, Claude Code cloud), Chrome, the two export files, network permission for Codex and Claude Code cloud, collecting visitor speed data inside your site, and the optional Anthropic and SE Ranking connections. The agent shows a full guide unasked only when something blocks the audit; every other guide appears when you ask for it, at the guidance level you picked.
- **Old output folders.** A folder or evidence packet from a 0.1.x run is refused with one sentence: run the audit again in a new folder. A finished folder, or one that holds files the audit did not write, is refused too.

### Versions

Release 0.2.0, evaluation 0.4.0 (was 0.3.0), audit protocol 0.2.0 (was 0.1.0), contract schema 2.0.0. Scores of different evaluation versions are not comparable: `compare` reports `not_comparable` against a 0.1.x baseline.

### Upgrading from 0.1.x

- A managed install of any 0.1.x release (0.1.2 and 0.1.3 were tested) stops `optbrew update` with `migration_required` and changes nothing. Replace it with the blocks in `docs/platforms.md`, "Reinstall after a migration_required update". They run the read-only `optbrew reinstall-plan` first and never touch your evidence.
- A plugin install from the marketplace follows `main`; the plugin update commands of your host are enough.
- Run the baseline audit again with 0.2.0 before you compare.

### Known limitations

- The one-call audit refuses private and local addresses; a local target can no longer be declared from the start questions.
- The fix step writes a change record for each edited file, but the 0.2.0 report does not read it, and a re-check after deploy does not update its `verification`; it stays `pending`. The re-check compares two audits (`cli.mjs compare`) and says what is resolved.
- Core Web Vitals field data can stay unknown: a site with few visitors has no Google data, and the `cwv-site-collection` guide explains how to collect it in the site itself.
- A runbook shows no screen drawing yet. A drawing appears only for a step that carries an explicit position tag.

### Release checks that stay with the owner

- The wording of the eli5 notice in `skills/optbrew/THIRD_PARTY_NOTICES.md`: its licence text was reconstructed because upstream has no licence file and no year. Decide the wording before the release is published. The caveman notice is copied from the installed 4.0.1 package.
- After the merge: the claude.ai copy shows the merge commit (a check that waits for the sync). A directory review result does not block the release.
- The steps in `docs/release.md`: CI on the merge commit, the tag, the GitHub Release and `npm publish` are run by the owner, not by an agent.

### Carried over from the unreleased 0.1.4

- The Claude marketplace now serves the `skills/` folder (new `skills/.claude-plugin/plugin.json`) instead of the repository root, because claude.ai, Claude Desktop and Cowork refuse a plugin with a top-level `bin/` folder and the marketplace sync failed. The marketplace entry and the served manifest pin no version, so every commit is picked up by marketplace sync. Claude Code installs keep the name `optbrew@optbrew` and the skill `/optbrew:optbrew`.
- No `.gitattributes` at the repository root or inside `skills/`. The Claude plugin directory refuses one there whatever its lines say, `* -text` included, so the root file is gone. `tests/` and `docs/` keep their own `* -text`, because the test fixtures, evidence hashes and the documented shell blocks need exact bytes. A test rejects a `.gitattributes` at the root or inside `skills/`, and every file is still committed with LF.
- Bundle hashes ignore the line endings a checkout adds. With `core.autocrlf=true` (the Git for Windows default) a Claude Code plugin install from the marketplace checks the skill out with CRLF. `bundle.mjs` and `score.mjs` now hash a file without a NUL byte as its LF form, so `doctor`, `install` and scoring accept that copy; LF files keep their old hashes and binary files hash as is. The ZIP and npm verifiers still compare exact bytes, so releases are built from a `core.autocrlf=false` clone (`docs/release.md`).
- `docs/release.md` adds two steps: publish a GitHub Release for each tag and read it back, and confirm that the webhook got a push for `refs/heads/main` with the merge commit (a branch deletion is answered `ignored_delete` and does not sync).
- The served `skills/` folder is a complete directory plugin: `skills/README.md` describes what the plugin runs, reads and sends, and `skills/.claude-plugin/plugin.json` adds `displayName`, `homepage`, `repository`, `license`, `keywords` and a 1024 px icon (`skills/.claude-plugin/icon.png`). Submit to the Claude directory with plugin path `skills`, so the scan reads only the plugin and not the repository's CLI, tests and npm files. A test checks the directory's README, license, icon, file-size and file-count rules.

## 0.1.3

Resolves the seven known limitations listed under 0.1.2.

- Evaluation version 0.3.0 (was 0.2.0; protocol stays 0.1.0 because its source files are unchanged). The discovery and fact observations change, so 0.1.2 and 0.1.3 scores are not comparable: `compare()` returns `not_comparable` for a 0.1.2 baseline against 0.1.3 inputs. Run the baseline audit again with 0.1.3.
- A managed install of 0.1.2 cannot be updated to 0.1.3. The updater guard is unchanged, so `optbrew update` stops with `migration_required` and changes nothing. Replace the install with the copy-paste blocks in `docs/platforms.md` ("Reinstall after a migration_required update"; the READMEs link there); they run the read-only `optbrew reinstall-plan` first. Audit evidence from 0.1.2 has no hashed failure records and is refused by 0.1.3 report replay with an "older optbrew release" error.
- The request limit is a hard ceiling again. Every request, each redirect hop included, takes one budget slot immediately before it is sent, so the total never exceeds `max_urls` (the 0.1.2 overshoot of up to concurrency x min(10, `max_urls`) requests is gone). A redirect chain the limit stops leaves its URL as a `request_limit` unknown and keeps the hops it already received. A failed fetch now writes a hashed `<sha256>.failure.json` record (answered redirect hops plus whether one more attempt got no response; listed in `failures` in the audit index), and report replay checks the ledger entry against it. An honest run that reaches the limit inside a redirect chain therefore replays, and a limit claim is accepted only when the recorded requests use the whole limit.
- Report replay rejects a URL that appears in more than one ledger entry, so duplicate failed-fetch entries for already fetched linked URLs can no longer prove a false request limit.
- Orphan pages are decided in steps. An unlinked page is an orphan unless another collected page's own bytes (inline scripts included) name its path as a whole path, or a script-only page loads a same-origin script file that was not collected; a fetched sitemap that lists other pages and leaves the page out still proves the orphan. A script-only widget page that never mentions the orphan no longer hides it.
- Phone extraction reads a national number written with spaces only (`02 555 0142`) and Korean nationwide representative numbers (15xx, 16xx and 18xx plus four digits) in labelled fields, `tel:` links and JSON-LD `telephone`. Prose, dates, fax numbers and a spaced number followed by more digits stay unread.
- A page is a separate entity only on structural evidence: JSON-LD `branchOf`, `parentOrganization` or another `@id`, a branch-list URL path (`/branch/`, `/branches/`, `/locations/`, `/stores/`, `/지점/`), or the word branch, 지점 or 지사 in the title or first heading together with an address of its own. A title word alone no longer hides a wrong phone or address.
- The Naver crawler token `Yeti` is confirmed against Naver's robots.txt guide, read again on 2026-10-15 (page text sha256 `ff8ddc85c5dd42e0d1133abae6928fb9b42f67f35d1b2c89b40378009571ed49`); `ai-crawlers.json` and `ai-crawlers.md` carry the source, the date and the hash.
- Five install routes in the README: npm, npx, a pinned PowerShell installer (`install.ps1`, which reads `doctor` and stops on a failed check), Claude Code and Codex plugins (marketplace `optbrew`, so the plugin is `optbrew@optbrew`; Codex reads `.agents/plugins/marketplace.json`), and a prompt that hands an agent the new step-by-step `AGENT_INSTALL.md`. The READMEs were rewritten around why, how it works and installation; checkout commands and the reinstall blocks moved to `docs/platforms.md`. New `CONTRIBUTING.md`.
- Seeded-defect detection on the frozen answer key: 29 of 61 detected (0.1.2: 28), 2 module-only, no new failure on a clean control page; the orphan page (SEO-12) is detected again. See `docs/validation/detection-0.1.3.md` (repository only).

### Known limitations

- An inline script that builds a URL from pieces can hide the link from the orphan check, so such a page is reported as an orphan although the script links it.
- Report replay checks that evidence files agree with each other and with their hashes. Someone who rewrites the collection, the ledger, the hashed records and the audit index together can still make a coherent false run; the failure-record chain length is bounded (at most eleven answered hops per failed fetch), a URL can appear once, and every failed fetch or skipped URL needs provenance, which limits how far such an edit can pad the request total.
- Phone extraction does not read numbers shorter than nine digits other than the 15xx, 16xx and 18xx representative numbers, nor national numbers separated by spaces outside a label.

## 0.1.2

- The report headline no longer lets a measured score read as a complete one. Each headline score carries its coverage; below the 80% coverage rule the single number is withheld and the report shows `insufficient coverage` with the measured-subset value and the missing-data bounds (`report.json` `headline[]`).
- The audit now observes from collected responses: duplicate titles (`document-title`), canonical target status and redirect-chain length (`canonical-consistency`), link and declared-sitemap discovery (`discovery`), JSON-LD parse errors (`structured-data-truth`), Naver markup moved from the unreachable direct-fetch path into the collected-evidence path (`naver-markup`: Open Graph, description, canonical, viewport, title repetition, CSS or JS blocked for Yeti), `search-crawl-policy` for Googlebot, Yeti and the AI search bots OAI-SearchBot, Claude-SearchBot and PerplexityBot (`references/ai-crawlers.md`; training bots stay unscored), and cross-page name, address, phone and founding-year comparison with an entity-identity check (`fact-consistency`, `entity-identity`).
- `search-crawl-policy` now records a pass as well as a fail for every engine that has a robots token. The collector fetches in-scope canonical targets while the request count is under the limit.
- Report replay derives every collector verdict again from the hashed raw evidence with the same code the audit uses, and rejects a derived observation that is missing, extra or different.
- Evaluation version 0.2.0 (was 0.1.0). The set of observations the audit and report produce changed, so 0.1.1 and 0.1.2 scores are not comparable: `compare()` returns `not_comparable` (`evaluation_version_changed`) for a 0.1.1 baseline against 0.1.2 inputs, and the current bundle refuses to score a 0.1.1 input. Run the baseline audit again with 0.1.2 before comparing. Scoring contracts, profile weights, the check registry and the protocol version (0.1.0, protocol sources unchanged) are unchanged.
- A managed install of 0.1.1 cannot be updated to 0.1.2. The updater guard is unchanged, so `optbrew update` stops with `migration_required` and changes nothing. The message now lists the exact paths to delete and the install and doctor commands for PowerShell and POSIX shells. To replace the install by hand, use the copy-paste blocks for user and project scope in the README and `docs/platforms.md`, "Reinstall after a migration_required update". Each block first runs the new read-only `optbrew reinstall-plan`, which resolves the home directory the way the CLI does and refuses a tampered install record (a target that is not exactly the agent's `skills/optbrew` path, a relative or `..` path, a link that leads elsewhere) before anything is deleted; the shell then deletes only the printed paths, targets first and the managed root last, so the block can be run again after a failure, and never touches `.optbrew/runs`. Updates and rollbacks between releases that keep evaluation version 0.2.0 are unaffected.
- Public clones: the four maintainer-only vendor tests skip with a reason when the upstream source mirror is absent, so `npm test` passes without it.
- Round-two review fixes. Replay also binds `skipped`, `limit_reached` and the request counts to a hashed request ledger (`ledger.json`) and the response records, requires every module the audit lists to have its output, derives every collector family from the collector evidence even when a module did not run, and compares the reason and evaluator of each observation. Fact comparison reads only Organization or LocalBusiness JSON-LD, `tel:` links and labelled contact fields, normalises addresses, and treats branch pages as separate entities. Discovery decodes entity-encoded links, treats `index.html` as its directory, and stays unknown for sitemap indexes and script-built navigation. JSON-LD inside comments is ignored. The headline also needs a verdict on every core check, and 79.95% coverage is never shown as 80%.
- Audit evidence from 0.1.1 has no request ledger or module list and is refused by 0.1.2 report replay with an "older optbrew release" error. Run the audit again with 0.1.2.
- Round-four review fixes. The request ledger rejects a skipped entry that carries requests and binds a failed fetch to the requests it made (`requests_made` in `collection.json`) and its redirect chain, so a forger cannot pad the total to a claimed request limit. Fact comparison: a phone number no longer continues across a line break; a `tel:` link is its own evidence class and counts only on a page with no labelled or JSON-LD phone; addresses compare as whole tokens (`10 Main St` is not `110 Main St`), and a postal code is dropped only in its own position, so a five-digit street number stays part of the address.
- Discovery: while any collected page has scripts and no anchors, an unlinked page is unknown (that page may link it from the browser) unless a fetched sitemap that lists other pages leaves it out; without such a page the link graph decides as before. `build-bundle` writes `bundle-manifest.json` through a temporary file and a rename, so a concurrent reader never sees an empty file.
- Round-five review fixes. Request accounting: a failed fetch has no hashed response record, so it always counts as one request in the ledger and in `request_count`, whatever its redirect chain says; report replay requires exactly that, so a forger cannot pad the total to a claimed request limit. The request limit (`max_urls`, at most 50) now decides only whether a fetch may start, and a redirect chain that has started is completed. A chain follows at most min(10, `max_urls`) redirects, so the requests beyond the limit are at most `concurrency` x min(10, `max_urls`) (20 with the defaults, 10 for `max_urls` 5); report replay applies the same bound. A run that hit the limit while a failed fetch had followed redirects can fall short of the limit in the ledger; replay then rejects the report as unprovable, and the audit has to be run again.
- Phone extraction reads from text in which every tag ends the text before it, so a number in the next span, table cell or list item is never absorbed; a spaced number that is followed by more digits or a bracketed digit is read only up to its dashed or dotted part, and a national number with spaces between its groups is not read at all. The same address words in another order (27 Wausan-ro, Mapo-gu, Seoul and Seoul, Mapo-gu, Wausan-ro 27) are one address.
- `optbrew reinstall-plan` also refuses a scope, target or agent name that contains a line break, tab or other control character, because one printed path per line is what the documented blocks delete.
- A failed fetch or a request-limit skip is only accepted for a URL with provenance: a selected or auxiliary URL of the run, or a URL that a hashed page of the collection links to (anchors and canonical). Report replay rejects fabricated entries for never-linked URLs, which could otherwise pad the request total to a false limit claim and so suppress discovery failures. Duplicate entries for linked URLs are not yet rejected; see Known limitations.
- `build-release` writes `bundle-manifest.json` through the same temporary file and rename as `build-bundle`, and the release tests build on a private copy of the tree.
- Not scripted yet: the `robots.txt` Sitemap line, og:image size, hreflang, JavaScript-only navigation, answer structure, claim support, authorship and freshness.

### Known limitations (all resolved in 0.1.3)

- Report replay does not reject a URL that appears in more than one ledger entry, so adding failed-fetch duplicates of already fetched linked URLs to `collection.json`, `ledger.json` and the audit index can prove a false request limit and turn a discovery failure into `unknown`; this needs deliberate edits to local evidence files.
- A run that reaches the request limit while a failed fetch was following redirects can record fewer requests than the limit, and report replay then refuses it as unprovable; run the audit again.
- While any collected page has scripts and no anchors, an unlinked page stays `unknown` unless a declared sitemap that lists other pages leaves it out, so an orphan page on such a site is not reported.
- Phone extraction skips national numbers written with spaces only (for example `02 555 0142`) and numbers shorter than nine digits (for example `1588-1234`), so a wrong number in those forms is not detected.
- A page whose title or first heading contains "branch", 지점 or 지사 is treated as a separate entity, so a wrong phone or address on such a page stays `unknown`.
- Requests can exceed `max_urls` by up to concurrency × min(10, `max_urls`) because a redirect chain that has started is completed (20 with the defaults, 10 for `max_urls` 5).
- The Naver crawler token `Yeti` was not re-read from Naver's official page during the 0.1.2 review (the page could not be fetched); the other AI and search crawler tokens match the vendors' official pages as checked on 2026-10-15.

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
