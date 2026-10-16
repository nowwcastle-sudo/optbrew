# Third-party notices

The files below retain their upstream copyright and permission notices. Service accounts, API data and Naver guide article bodies are outside these code licenses.

- **mblode-seo** — mblode/agent-skills at 872bc83bdb6dd54a9ff456fbf1181beea6db7875; MIT; Git license blob c5a1d56c6d623c72d077f8aab56b31d7dc371cbb; exact notice: [licenses/mblode-seo.txt](licenses/mblode-seo.txt). Exclusions: Unselected agent skills in the upstream repository.
- **naver-searchadvisor** — JaceProgramming/naver-searchadvisor-expert at cd95f6281090416b3dfbf15fb0f66f0ffa67a19c; MIT (limited scope); Git license blob 4434edf30edce0a41c07fbc776b0d5cebd044547; exact notice: [licenses/naver-searchadvisor.txt](licenses/naver-searchadvisor.txt). Exclusions: references/guide/*.md: 55 Naver copyrighted article bodies outside MIT scope; official URLs retained in INDEX; README.md: documents upstream offline corpus and is not a runtime guide; tools/fetch-guide.mjs: would retrieve excluded articles; tools/fix-index.mjs and tools/package.json: authoring tools, not runtime.
- **firecrawl-seo-audit** — firecrawl/firecrawl-workflows at 94cc91229d6cedc0613f140d3d013b150bc8e1b0; ISC; Git license blob ee221a2151d63ddc1db9857f9c5d346a3de9d816; exact notice: [licenses/firecrawl-seo-audit.txt](licenses/firecrawl-seo-audit.txt). Exclusions: Unselected Firecrawl workflows.
- **magnus-seo** — magnus919/agent-skills at 2e8fb962819b2b01b270620f92f0cc7213d77ef1; MIT; Git license blob 9745e19f4b20d77c134964ae1bf0af0ace5c4db7; exact notice: [licenses/magnus-seo.txt](licenses/magnus-seo.txt). Exclusions: Unselected agent skills.
- **seranking-seo** — seranking/seo-skills at fd6d1408f2e6a06454d81c07c29e0f04342eb9ba; MIT; Git license blob ca6b9a33c8234bf47cdcfb2dc157b308195845c5; exact notice: [licenses/seranking-seo.txt](licenses/seranking-seo.txt). Exclusions: extensions/google/install.sh and extensions/firecrawl/install.sh: upstream installers disabled; scripts/google_auth.py and root scripts: upstream authentication and provider execution disabled; optbrew capability adapters replace active commands; Unselected campaign, ad, social and other upstream skills.
- **marketing-search** — coreyhaines31/marketingskills at 5b2c0007766c6a1cf1d53fd8fc73e979e0821022; MIT; Git license blob 7c48dd638a9ebed49a8ef0c0c4eea90105381cdf; exact notice: [licenses/marketing-search.txt](licenses/marketing-search.txt). Exclusions: Unselected marketing skills, installers and authoring utilities.

## Borrowed text

These two works are not vendored code. SKILL.md, section "진행 보고", adapts the output rules of caveman. The top sections of the HTML report follow the approach of eli5 (big picture, few words).

### caveman

Source: https://github.com/JuliusBrussee/caveman, `skills/caveman/SKILL.md`, version 4.0.1 (installed copy). License: Apache License, Version 2.0, https://www.apache.org/licenses/LICENSE-2.0. Changes: the rules were translated into Korean, shortened, and rewritten for progress sentences during an audit; SKILL.md marks the paragraph "변경함". The upstream NOTICE file follows word for word.

```text
Caveman
Copyright 2026 Julius Brussee

Before Caveman 3.0.0, the parts of this repository outside the Engine-linked
runtime were licensed under the MIT License (see LICENSING.md). Contributions
made to those parts before 3.0.0 were received under the MIT License and remain
available under it. Its copyright and permission notice is retained in
LICENSE-MIT.

This product includes third-party software:

- engine/pixel/ is a Go port of pxpipe (https://github.com/teamchong/pxpipe),
  used under the MIT License.
  Copyright (c) 2026 claude-image-proxy contributors

- The glyph atlases embedded in engine/pixel/assets/ are rasterized from:
  - Spleen 5x8, Copyright (c) 2018-2026, Frederic Cambus.
    BSD 2-Clause License.
  - GNU Unifont 16.0.04, dual-licensed under the SIL Open Font License 1.1 and
    the GNU GPL version 2 (or later) with the GNU font-embedding exception.

- browse/ links these MIT-licensed Go modules:
  - github.com/chromedp/chromedp, Copyright (c) 2016-2025 Kenneth Shaw
  - github.com/chromedp/cdproto, Copyright (c) 2016-2025 Kenneth Shaw
  - github.com/chromedp/sysutil, Copyright (c) 2016-2017 Kenneth Shaw

- The runtime binaries and the container image link third-party Go modules
  under the MIT, BSD-3-Clause and Apache-2.0 licenses. Their license texts, and
  the Go runtime's, ship with every binary release as
  THIRD_PARTY_GO_LICENSES.tar.gz and in the image under /licenses/third_party/.

- packages/cli/src/index.ts contains a port, with changes, of Qwen Code
  0.22.3's MCP server and permission-rule matchers and its tool-name
  normalization (https://github.com/QwenLM/qwen-code), used under the Apache
  License, Version 2.0.
  Copyright 2025 Google LLC
  Copyright 2025 Qwen

- The @caveman-ai/cli package bundles MIT-licensed npm packages
  (@clack/prompts, @clack/core, sisteransi, fast-string-width,
  fast-string-truncated-width, fast-wrap-ansi); see packages/cli/NOTICE.

- extension/fonts/ holds the Geist and Geist Mono fonts,
  Copyright (c) 2023 Vercel, in collaboration with basement.studio,
  under the SIL Open Font License 1.1.

Full license texts: engine/pixel/NOTICE, engine/pixel/assets/SPLEEN_LICENSE.txt,
engine/pixel/assets/UNIFONT_LICENSE.txt, browse/NOTICE, packages/cli/NOTICE, and
extension/fonts/GEIST_LICENSE.txt.
```

### eli5

Source: the `eli5` plugin version 1.0.0 by Thariq Shihipar, from the claude-community plugin marketplace. Its `plugin.json` declares `"license": "MIT"`; the plugin ships no separate license file and states no copyright year. Use: only the approach "big pictures, few words" is followed; no upstream text is copied. The MIT License:

```text
MIT License

Copyright (c) Thariq Shihipar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
