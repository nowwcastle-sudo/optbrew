# Naver Search Advisor source guide

Adapted from the pinned upstream SKILL.md. Naver's 55 article bodies are excluded because their copyright is outside the upstream MIT license. The source routing tables below identify topics only. Find each document in [the official document index](references/INDEX.md) and read its current official URL before using a policy or numeric claim. If the page cannot be read, mark that claim unknown. A site: search is not complete indexing proof; IndexNow is a notification, not confirmed indexing. The local audit script gathers evidence only and must not submit to Naver.

The upstream instructions to read local article bodies, search those bodies, or fetch them into this package do not apply to optbrew.

## Optbrew audit input

Run `node skills/optbrew/scripts/audit.mjs --context <run-context.json> --modules naver-searchadvisor --output-dir <run-dir>`. The optbrew collector checks the declared origin, path and resolved IP at each redirect. This module reads only collector-preserved HTML, response headers and any in-scope robots.txt artifact. Its original direct URL CLI is disabled. A Yeti User-Agent response, when supplied, is a bot-specific response observation; it does not prove that a Naver bot visited the site. Module warnings are evidence to review, not automatic optbrew score deductions.

## 라우팅 표 — 요청 → 읽을 문서

| 사용자가 이런 걸 물으면 | 읽을 파일 (`official URLs in references/INDEX.md`) |
|---|---|
| 네이버 SEO 처음 시작, 뭐부터? | `01-seo-basic-intro.md`, `12-seo-help.md` |
| 사이트 등록, 소유확인 | `55-faq-start-register.md` |
| robots.txt 작성·응답코드·Yeti 허용 | `03-seo-basic-robots.md` |
| 검색로봇 IP 확인, 방화벽에 막힘 | `07-seo-basic-firewall.md` |
| 리다이렉트, URL 변경, 사이트 이전 | `04-seo-basic-redirect.md`, `05-seo-basic-migration.md` |
| HTTP 상태코드 해석 | `08-seo-basic-http.md` |
| 사이트 폐쇄·종료 절차 | `06-seo-basic-close.md` |
| SPA/React/Vue가 색인 안 됨 | `09-seo-advanced-javascript.md` |
| URL 구조 설계 | `10-seo-advanced-url.md` |
| 색인 효율, 크롤 예산 | `11-seo-advanced-indexing.md` |
| CSS/JS/이미지 리소스 차단 문제 | `13-resource-and-link.md` |
| 스팸으로 분류될까? 페널티 사유 | `14-content-abusing.md` |
| 콘텐츠 어떻게 써야 하나, AI 글 써도 되나 | `15-content-basic.md` |
| canonical, noindex, nofollow, nosourceinfo | `16-markup-structure.md` |
| title, description, 오픈그래프, og:image 규격 | `17-markup-content.md` |
| 모바일 대응, viewport | `18-markup-mobile.md` |
| 파비콘이 검색결과에 안 나옴 | `19-markup-favicon.md` |
| 수집요청, 검색제외 요청 | `20-request-crawl.md` |
| 사이트맵·RSS 제출 | `21-request-feed.md` |
| 사이트 간단 체크 / URL 검사 도구 | `22-diagnose-site.md`, `23-url-inspection.md` |
| 서치어드바이저 리포트 해석 | `24`~`28-*.md` (노출/클릭, 진단, 최적화, 수집현황, 사이트상태) |
| 구조화된 데이터 개념·JSON-LD 형식 | `29-structured-data-intro.md` |
| 특정 타입 마크업 (식당/리뷰/레시피 등) | 아래 **구조화된 데이터 표** 참조 |
| 대량 색인 API 연동 | `44-crawl-request-api.md` |
| IndexNow 도입 | `45`~`48-indexnow-*.md` |
| 검색에 안 나와요 | `52-faq-serpmissing.md` → `22-diagnose-site.md` |
| 검색에서 빼고 싶어요 | `53-faq-serpremove.md` |
| 검색결과 제목/설명이 이상해요 | `51-faq-serpedit.md` |
| 서브링크가 안 나와요 | `54-faq-sublink.md` |

전체 목록은 `references/INDEX.md`.

## 구조화된 데이터 타입 표

**자가 적용 가능** — 마크업만 하면 되는 타입:

| 타입 | 필수 속성 | 문서 |
|---|---|---|
| `Restaurant` | name, openingHours | `39-structured-data-restaurant.md` |
| `Review` | reviewBody | `38-structured-data-review.md` |
| `AggregateRating` | ratingValue | `36-structured-data-rating.md` |
| `Recipe` | recipeInstruction | `37-structured-data-recipe.md` |
| `HowTo` | text | `34-structured-data-howto.md` |
| `BreadcrumbList` | name | `33-structured-data-breadcrumb.md` |
| `ListItem` (캐러셀) | image | `35-structured-data-carousel.md` |
| `PostalAddress` | streetAddress | `32-structured-data-address.md` |
| `Movie` | name, actor | `41-structured-data-movie.md` |
| `TVSeries` | name, actor | `40-structured-data-tvseries.md` |
| `SoftwareApplication` | name, applicationCategory | `42-structured-data-software.md` |
| `Organization`/`Person` (연관채널) | name, url, sameAs | `30-structured-data-channel.md` |

**제휴(협의) 필요** — 마크업만으로는 노출되지 않는다. 사용자에게 반드시 알릴 것:

| 타입 | 조건 | 문서 |
|---|---|---|
| `JobPosting` (채용정보) | 네이버 제휴제안 + 수집요청 API 연동 필수 | `31-structured-data-job.md` |
| `VideoObject` (동영상) | 동영상콘텐츠 제휴 + Push 방식 수집 | `43-structured-data-video.md` |

권장 형식은 **JSON-LD 또는 Microdata** (출처: `structured-data-intro`). 검증은 <https://validator.schema.org/>.
