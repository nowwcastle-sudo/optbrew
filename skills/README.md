# optbrew

A search-readiness audit skill. optbrew checks a website for Google, Naver and AI answer engines, fixes only the local files you approve, checks again under the same conditions, and writes a scored report built from evidence you can replay.

It covers five profiles: SEO, NEO (Naver), AEO, GEO and LLMO. Five pinned audit guide bundles are merged into 22 check families, so an issue that several guides report is counted once. When less than 80% of the applicable checks could be measured, the report shows the measured part and its bounds instead of one headline score.

## How to use it

Start a session and ask, for example: "Run optbrew on https://example.com. Goal: show up in Naver and get cited in AI answers." optbrew first asks for anything it needs: the site URL, the goal, the pages in scope, and which local changes you allow.

## What it runs, reads and sends

- **Site collection.** It fetches only the URLs inside the scope you declare: at most 50 requests by default (pages, redirects and robots or sitemap files together), depth 3, two at a time. Private network addresses are fetched only when you declare a local target. Every response is stored with its hash under `.optbrew/runs` in your project.
- **Local scripts.** The skill tells Claude to run the Node.js and Python scripts bundled in this folder for collection, scoring, comparison and reports. They need Node.js 22 or later; Python 3.10 or later is optional.
- **Local changes.** It edits only local files you approve, after keeping a backup copy. It does not deploy, publish, or submit a site to a search engine.
- **Optional paid APIs.** Nothing requires an account. If you choose to use the Anthropic API, the bundled adapter reads your `ANTHROPIC_API_KEY` environment variable and sends it only to `api.anthropic.com`, and only after you approve a budget and a stop condition. The SE Ranking guides describe SE Ranking's own API and MCP with your own SE Ranking key, sent only to SE Ranking. Keys never go into a report.
- **No other network use.** The plugin has no hooks, MCP servers or background tasks, and it does not download or run code at install time.

## License

MIT for optbrew's own code. The bundled guides keep their own licenses, listed in `optbrew/THIRD_PARTY_NOTICES.md`. Source and documentation: https://github.com/nowwcastle-sudo/optbrew
