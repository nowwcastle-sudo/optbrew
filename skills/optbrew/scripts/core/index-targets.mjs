import { indexingDirectives } from '../../modules/naver-searchadvisor/scripts/audit.mjs';
import { readSitemaps } from './checks/prepare.mjs';
import { canonicalUrl } from './link-graph.mjs';

/** The decision a page gets when the site itself shows it is not meant to be in the index (R89). */
const NOT_INDEX_CONDITION = 'not_public_index_target';
/** The reason text is fixed: replay tells a decision the code derived from one an owner approved by this text. */
const NOT_INDEX_REASON = 'noindex and not listed in the sitemap';
const SITEMAP_FILE = /\.xml(?:\.gz)?$/i;

const xRobotsOf = artifact => Array.isArray(artifact.header_lines) ?
  artifact.header_lines.filter(line => line.name === 'x-robots-tag').map(line => line.value) : [];

/** Whether a decision is the one this module derives (and replay derives again), not an approved one that an intake record backs. */
export const isDerivedIndexDecision = decision => decision?.condition === NOT_INDEX_CONDITION && decision.reason === NOT_INDEX_REASON;

/**
 * The selected pages the site deliberately keeps out of the index: a page that (a) carries noindex in its raw response for the target
 * engines, (b) is not the home page, and (c) is listed in no sitemap the run read, while (d) the sitemaps the run read list other pages
 * of the site and every sitemap the run declared was read. Such a page is a contact form or a thank-you page, not a page that lost its
 * place by mistake. Without (d) a missing sitemap says nothing about the page, so a noindex stays a failure.
 * `artifacts` carry `evidence_ref`, `status`, `capability`, `final_url` and `header_lines`; `textOf(artifact)` gives the body. The audit
 * calls this once after collection and report replay calls it again over the stored bytes. Returns `[{ url, evidence_ref }]` by address.
 */
export function notIndexTargets({ context, artifacts, textOf, skipped = [] }) {
  const { protocol } = context;
  const declared = new Set((protocol.auxiliary_resources ?? []).filter(resource => resource.kind === 'sitemap').map(resource => resource.normalized));
  const sitemaps = readSitemaps(artifacts, declared, textOf, skipped);
  const listsPages = [...sitemaps.urls].some(url => { try { return !SITEMAP_FILE.test(new URL(url).pathname); } catch { return false; } });
  if (!listsPages || sitemaps.unread.length) return [];
  const home = canonicalUrl(context.target);
  const selected = new Set(protocol.page_types.flatMap(type => type.urls.map(url => url.normalized)));
  const found = [];
  for (const artifact of artifacts) {
    if (!selected.has(artifact.normalized_url) || artifact.capability !== 'raw_html' || artifact.status !== 200) continue;
    const keys = [canonicalUrl(artifact.normalized_url), canonicalUrl(artifact.final_url ?? artifact.normalized_url)];
    if (keys.includes(home) || keys.some(key => sitemaps.urls.has(key))) continue;
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
