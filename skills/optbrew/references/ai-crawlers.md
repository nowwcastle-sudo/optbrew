# Search and AI crawler tokens (checked 2026-10-15)

`search-crawl-policy` (Google and Naver) and `ai-crawler-policy` (ChatGPT, Claude and Perplexity) judge whether the robots.txt token that governs a target engine may fetch each selected public page. Both use one derivation; only the engines differ. Tokens come from `ai-crawlers.json`. Each row below was read from the vendor's official page on the checked date; vendors change these pages, so re-read the source before relying on a token.

| Protocol engine | robots.txt token | Role | Vendor statement (summary) |
| --- | --- | --- | --- |
| `google`, `google_ai` | Googlebot | search | Google's AI features need no extra technical requirement: a page must be indexed and snippet-eligible, and "robots.txt directives for Googlebot is the control for site owners" ([AI features](https://developers.google.com/search/docs/appearance/ai-features)). |
| `naver` | Yeti | search | Naver Search Advisor robots guidance ([robots.txt guide](https://searchadvisor.naver.com/guide/seo-basic-robots)): its robots.txt examples use `User-agent: Yeti`. Read again on 2026-10-15 (HTTP 200, page text sha256 `ff8ddc85c5dd42e0d1133abae6928fb9b42f67f35d1b2c89b40378009571ed49`). |
| `chatgpt` (alias `openai`) | OAI-SearchBot | search | Sites opted out of OAI-SearchBot are not shown in ChatGPT search answers ([OpenAI bots](https://developers.openai.com/api/docs/bots)). |
| `claude` (alias `anthropic`) | Claude-SearchBot | search | Blocking stops indexing for Claude search and may reduce visibility ([Anthropic](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)). |
| `perplexity` | PerplexityBot | search | Surfaces and links sites in Perplexity results and is not used for foundation-model training ([Perplexity](https://docs.perplexity.ai/guides/bots)). |

Tokens that are never scored, as the design rule "allowing training bots earns no score" requires. Blocking them is a content-licensing choice, not a failure:

| Token | Role | robots.txt controls it |
| --- | --- | --- |
| GPTBot | OpenAI model training | yes |
| ChatGPT-User | user-initiated visits | OpenAI: robots.txt rules may not apply |
| ClaudeBot | Anthropic model training | yes |
| Claude-User | user-initiated retrieval | yes |
| Perplexity-User | user-initiated fetch | generally ignores robots.txt |
| Google-Extended | Gemini training and grounding | yes; it "does not impact a site's inclusion in Google Search" |

Only engines present in `run_context.protocol.engines` have units, and each family keeps to the engines its registry entry lists. A goal that names AI citation (AI, 답변, 인용, GEO, AEO, LLM and the like; `scripts/core/goals.mjs`) adds `chatgpt`, `claude` and `perplexity` to the engines. `ai-crawler-policy` sits on the T axis: a blocked AI search token costs score but is not a blocker and never makes readiness `blocked`. An engine id not listed above gets no scripted observation and stays `unknown`. The verdict uses the declared `robots` auxiliary resource only. A robots file answered with a 4xx status other than 429 allows every path (RFC 9309 2.3.1.3, "Unavailable"); a 429, a 5xx, a redirect away from `/robots.txt` or no answer yields no observation.
