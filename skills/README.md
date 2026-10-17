# optbrew

A search-readiness audit skill. optbrew checks a website for Google, Naver and AI answer engines, fixes only the local files you approve, checks again under the same conditions, and writes a scored report built from evidence you can replay.

It covers five profiles: SEO, NEO (Naver), AEO, GEO and LLMO. Five pinned audit guide bundles are merged into 22 check families, so an issue that several guides report is counted once. When less than 80% of the applicable checks could be measured, the report shows the measured part and its bounds instead of one headline score.

## How to use it

Start a session and ask, for example: "Run optbrew on https://example.com. Goal: show up in Naver and get cited in AI answers." optbrew reads the site and your setup, then sends all its start questions in one message: guidance level, goal, search questions, site facts, page limit and optional extras. The questions, guides and report are in Korean. Answer by number, or reply "시작" (start) to take the defaults.

The audit then runs in one go. It writes `report.html`, `report.md` and `report.json` to an `optbrew-audit` folder in your working folder. Open `report.html` first. The report text is in Korean. Each problem has one fix with the number of pages it affects, and each blank has a numbered list of steps that fill it. Missing extras, such as a Google key or Chrome, never stop the audit.

## What it runs, reads and sends

- **Site collection.** It fetches only URLs on your site's own address and its `www` or `https` twin: pages from the sitemap and from links on the start page, up to a limit of 50 requests by default (up to 200 if you raise it), counting pages, redirects and robots or sitemap files together, two at a time. It follows a redirect to the `www` or `https` twin of your address and says so in the report. Private, internal and local addresses (such as `localhost`) are refused, so audit the public address of the site. Every response is stored with its hash in the `optbrew-audit` folder.
- **Chrome.** To see text that scripts draw, it renders up to 10 pages, one of each kind, in a headless Chrome of its own with a temporary profile, and closes it when the audit ends. Your own Chrome is never reused. The pages it renders may load files from other public hosts, such as fonts and scripts; optbrew fetches those only from public addresses. Without Chrome the audit still runs and the render checks stay blank.
- **Speed data.** To get the Core Web Vitals of real visitors, it asks Google's Chrome UX Report and PageSpeed Insights about your site's address. If you saved a Google API key, it is sent to Google only in a request header. The key is never written to a report, a log or the evidence. Without a key, those cells can stay blank.
- **Google key file.** `optbrew key set google` (or `node <skill folder>/scripts/key.mjs set google`), run by you in your own terminal, saves the key in `.optbrew/credentials.json` in your home folder. The environment variable `OPTBREW_GOOGLE_API_KEY` takes priority. The skill never asks for the key in the chat.
- **Your export files.** If you give the path of a Search Console zip or a Naver Search Advisor text file, the audit reads that file from disk. It sends nothing from it.
- **Local scripts.** The skill tells Claude to run the Node.js and Python scripts bundled in this folder for collection, scoring, comparison and reports. They need Node.js 22 or later; Python 3.10 or later is optional.
- **Local changes.** It edits only local files you approve, after keeping a backup copy. It does not deploy, publish, or submit a site to a search engine.
- **Optional paid APIs.** Nothing requires an account. If you choose to use the Anthropic API, the bundled adapter reads your `ANTHROPIC_API_KEY` environment variable and sends it only to `api.anthropic.com`, and only after you approve a budget and a stop condition. The SE Ranking guides describe SE Ranking's own API and MCP with your own SE Ranking key, sent only to SE Ranking. Keys never go into a report.
- **No other network use.** The plugin has no hooks, MCP servers or background tasks, and it does not download or run code at install time.

## License

MIT for optbrew's own code. The bundled guides keep their own licenses, listed in `optbrew/THIRD_PARTY_NOTICES.md`. Source and documentation: https://github.com/nowwcastle-sudo/optbrew
