> optbrew distribution note: The upstream notice below is preserved for attribution. This bundle excludes all 55 Naver article bodies and the article-fetch tool. Its statements about the upstream repository's contents and workflow do not describe this package.

# 저작권 및 출처 고지 (NOTICE)

## 원문 자료

`references/guide/` 아래 55개 Markdown 문서는 **네이버 서치어드바이저 웹마스터 가이드**
(<https://searchadvisor.naver.com/guide>)의 공개 문서를 Markdown으로 변환한 것입니다.

- **저작권자: 네이버 주식회사 (NAVER Corp.)**
- 본 저장소는 네이버(주)와 아무런 관련이 없으며, 공식 제공물이나 승인을 받은 배포물이 아닙니다.
- 문서 본문에는 어떠한 수정·요약·재해석도 가하지 않았습니다. HTML → Markdown 형식 변환만 수행했습니다.
- 각 파일은 front matter에 원문 URL(`source`)과 네이버가 명시한 수정일(`updated`)을 보존합니다.
- 수집 시점: 2026년 7월. 이후 원문이 변경되었을 수 있으므로, **정확한 최신 내용은 항상 `source`의 원문을 확인하십시오.**

재배포 목적은 AI 에이전트가 오프라인에서 정확한 근거 자료를 참조하도록 하는 것입니다.
AI가 네이버 SEO를 추측이나 구글 SEO 지식으로 답하는 것을 막으려면 원문 접근이 필요하며,
요약본을 쓰면 그 과정에서 정보가 왜곡되므로 원문을 그대로 두었습니다.

**네이버(주)의 요청이 있을 경우 `references/guide/` 전체를 즉시 삭제하고,
사용자가 `tools/fetch-guide.mjs`로 직접 내려받는 방식으로 전환합니다.**
이슈 또는 저장소 소유자에게 연락 주시기 바랍니다.

## 이 저장소가 직접 작성한 부분

다음은 이 프로젝트의 창작물이며 MIT 라이선스를 따릅니다 ([LICENSE](../../licenses/naver-searchadvisor.txt)).

- `SKILL.md` — 스킬 지침, 라우팅 표, 워크플로
- `scripts/audit.mjs` — 진단 스크립트
- `tools/fetch-guide.mjs` — 수집 스크립트
- `README.md`, `NOTICE.md`, `references/INDEX.md`

## 상표

NAVER, 네이버, 서치어드바이저, Yeti는 네이버 주식회사의 상표입니다.
이 저장소에서는 식별 목적으로만 사용합니다.

---

# Copyright Notice (English)

The 55 Markdown documents under `references/guide/` are Markdown conversions of the publicly
available **NAVER Search Advisor Webmaster Guide** (<https://searchadvisor.naver.com/guide>).

- **Copyright: NAVER Corporation**
- This repository is **not** affiliated with, endorsed by, or approved by NAVER Corporation.
- Document bodies are unmodified — only HTML-to-Markdown format conversion was applied.
- Each file preserves the original URL (`source`) and NAVER's stated revision date (`updated`)
  in its front matter. Snapshot taken July 2026 — always verify against the `source` URL.

Redistribution serves to give AI agents offline access to accurate primary sources, preventing
them from answering Naver SEO questions with guesswork or Google SEO knowledge.

**If NAVER Corporation requests removal, `references/guide/` will be deleted immediately** and
replaced with a fetch-it-yourself flow via `tools/fetch-guide.mjs`.

Original work in this repository (`SKILL.md`, `scripts/`, `tools/`, docs) is MIT licensed.
NAVER, Search Advisor, and Yeti are trademarks of NAVER Corporation, used here for
identification purposes only.
