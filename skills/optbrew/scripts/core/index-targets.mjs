import { indexingDirectives } from '../../modules/naver-searchadvisor/scripts/audit.mjs';
import { decodeEntities } from './html.mjs';
import { canonicalUrl } from './link-graph.mjs';
import { sameSite } from './page-select.mjs';
import { assertUrlInScope } from './scope.mjs';

/** The decision a page gets when the site itself shows it is not meant to be in the index (R89). */
const NOT_INDEX_CONDITION = 'not_public_index_target';
/** The reason text is fixed: replay tells a decision the code derived from one an owner approved by this text. */
const NOT_INDEX_REASON = 'noindex and not listed in the sitemap';
const SITEMAP_FILE = /\.xml(?:\.gz)?$/i;
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
/** A declared sitemap that answers with one of these is read, and it lists nothing. Any other answer that is not a parsed 2xx is missing evidence. */
const ABSENT = [404, 410];

const xRobotsOf = artifact => Array.isArray(artifact.header_lines) ?
  artifact.header_lines.filter(line => line.name === 'x-robots-tag').map(line => line.value) : [];

/** Whether a decision is the one this module derives (and replay derives again), not an approved one that an intake record backs. */
export const isDerivedIndexDecision = decision => decision?.condition === NOT_INDEX_CONDITION && decision.reason === NOT_INDEX_REASON;

/**
 * An address as the run's own page selection writes it, folded to one spelling of the site: `www.` and http/https of the run's host
 * become the run's origin, a trailing slash goes, and the rest is the product's normalizer (scope check, fragment, `index.html`).
 * Null for an address of another site.
 */
function foldedUrl(value, base, scope) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !sameSite(url, base)) return null;
  url.protocol = base.protocol;
  url.host = base.host;
  let href = url.href;
  try { href = assertUrlInScope(href, scope).href; } catch { /* an address outside the scope is still compared by its folded form */ }
  const key = canonicalUrl(href);
  if (key === null) return null;
  const folded = new URL(key);
  if (folded.pathname.length > 1) folded.pathname = folded.pathname.replace(/\/+$/, '') || '/';
  return folded.href;
}

/**
 * What the declared sitemaps say, or that the evidence is incomplete (R96, R97). `complete` is false unless every declared sitemap is
 * read: a 2xx whose body parses as a sitemap, or a 404/410 (absent). A 5xx, a timeout, a connection error, a body that is no sitemap,
 * or a sitemap that was never fetched is missing evidence. A sitemap index counts only when every child it names is itself a declared
 * sitemap that was read, and the entries of an index are never pages. `pages` are the folded same-site addresses the sitemaps list;
 * an entry that is a sitemap file or belongs to another site lists no page.
 */
function sitemapEvidence({ context, artifacts, textOf }) {
  const base = new URL(context.target);
  const { scope } = context;
  const declared = (context.protocol.auxiliary_resources ?? []).filter(resource => resource.kind === 'sitemap').map(resource => resource.normalized);
  const byUrl = new Map(artifacts.map(artifact => [artifact.normalized_url, artifact]));
  const readable = new Set();
  const pages = new Set();
  const children = [];
  let complete = true;
  for (const url of declared) {
    const artifact = byUrl.get(url);
    if (!artifact) { complete = false; continue; }
    if (ABSENT.includes(artifact.status)) { readable.add(foldedUrl(url, base, scope)); continue; }
    const body = artifact.status >= 200 && artifact.status < 300 ? String(textOf(artifact) ?? '') : '';
    const index = /<sitemapindex\b/i.test(body);
    if (!index && !/<urlset\b/i.test(body)) { complete = false; continue; }
    readable.add(foldedUrl(url, base, scope));
    for (const match of body.matchAll(LOC)) {
      const loc = decodeEntities(match[1]);
      if (index) children.push(loc);
      else if (!SITEMAP_FILE.test(loc.split(/[?#]/)[0])) {
        const key = foldedUrl(loc, base, scope);
        if (key !== null) pages.add(key);
      }
    }
  }
  // Every child an index names must be a sitemap the run declared and read; one beyond the declared list could list the page.
  for (const child of children) {
    const key = foldedUrl(child, base, scope);
    if (key === null || !readable.has(key)) complete = false;
  }
  return { complete, pages };
}

/**
 * The selected pages the site deliberately keeps out of the index: a page that (a) carries noindex in its raw response for the target
 * engines, (b) is not the home page, and (c) is listed in no sitemap the run read, while (d) the sitemaps list other pages of the same
 * site and every declared sitemap was read in full (R96, R97). Such a page is a contact form or a thank-you page, not a page that lost
 * its place by mistake. Where the evidence is incomplete or ambiguous, a noindex stays a failure and a blocker.
 * `artifacts` carry `evidence_ref`, `status`, `capability`, `final_url` and `header_lines`; `textOf(artifact)` gives the body. The audit
 * calls this once after collection and report replay calls it again over the stored bytes. Returns `[{ url, evidence_ref }]` by address.
 */
export function notIndexTargets({ context, artifacts, textOf }) {
  const { protocol, scope } = context;
  const sitemaps = sitemapEvidence({ context, artifacts, textOf });
  if (!sitemaps.complete || !sitemaps.pages.size) return [];
  const base = new URL(context.target);
  const home = foldedUrl(context.target, base, scope);
  const selected = new Set(protocol.page_types.flatMap(type => type.urls.map(url => url.normalized)));
  const found = [];
  for (const artifact of artifacts) {
    if (!selected.has(artifact.normalized_url) || artifact.capability !== 'raw_html' || artifact.status !== 200) continue;
    const keys = [artifact.normalized_url, artifact.final_url ?? artifact.normalized_url].map(url => foldedUrl(url, base, scope));
    if (keys.includes(home) || keys.some(key => key !== null && sitemaps.pages.has(key))) continue;
    if (!indexingDirectives({ html: textOf(artifact) ?? '', xRobotsTag: xRobotsOf(artifact), engines: protocol.engines }).blocked) continue;
    found.push({ url: artifact.normalized_url, evidence_ref: artifact.evidence_ref });
  }
  return found.sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** The context with the pages of `targets` marked as not public index targets (in the page types and in the render pages), each with its decision. */
export function withIndexTargets(context, targets) {
  if (!targets.length) return context;
  const decision = new Map(targets.map(({ url, evidence_ref }) => [url, { condition: NOT_INDEX_CONDITION, reason: NOT_INDEX_REASON, evidence_ref }]));
  const mark = url => decision.has(url.normalized) ? { ...url, public_indexing: false, indexing_decision: decision.get(url.normalized) } : url;
  const { protocol } = context;
  return { ...context, protocol: { ...protocol,
    page_types: protocol.page_types.map(type => ({ ...type, urls: type.urls.map(mark) })),
    ...(protocol.render ? { render: { ...protocol.render, pages: protocol.render.pages.map(mark) } } : {}) } };
}
