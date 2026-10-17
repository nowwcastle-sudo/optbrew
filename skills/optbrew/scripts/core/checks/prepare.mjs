import { auditCollected } from '../../../modules/naver-searchadvisor/scripts/audit.mjs';
import { alternateLinks, decodeEntities } from '../html.mjs';
import { declaredRobotsIndex } from '../collector.mjs';
import { compareFacts, pageFacts } from '../facts.mjs';
import { canonicalUrl, findOrphans, linkGraph } from '../link-graph.mjs';
import { selectRenderPages } from '../render.mjs';

const SKIP_REASONS = ['depth_limit', 'url_limit', 'request_limit'];
const NOT_COLLECTED = 'not_collected';
const normalizeTitle = title => title.toLowerCase().replace(/\s+/g, ' ').trim();
/** The pages the run renders: the ones its protocol fixed (none when rendering is off), else, before render plans existed, the default sample. */
const renderPlan = protocol => protocol.render ? (protocol.render.enabled ? protocol.render.pages : []) : selectRenderPages(protocol.page_types);

/**
 * The declared sitemaps among the collected artifacts: every listed url, whether one is an index, the unusable ones, and the ones the
 * run never fetched (`unread`, each with the reason the collector skipped it, else `not_collected`).
 */
export function readSitemaps(artifacts, declared, textOf, skipped) {
  const sitemaps = { urls: new Set(), index: false, broken: [], unread: [] };
  const fetched = new Set(artifacts.map(artifact => artifact.normalized_url));
  for (const url of declared) if (!fetched.has(url)) sitemaps.unread.push({ url, reason: skipped.find(x => x.url === url)?.reason ?? NOT_COLLECTED });
  for (const artifact of artifacts) {
    if (!declared.has(artifact.normalized_url)) continue;
    if (artifact.status >= 200 && artifact.status < 300) {
      const body = String(textOf(artifact) ?? '');
      // Child sitemaps of an index are not fetched, so pages missing from the index prove nothing.
      if (/<sitemapindex\b/i.test(body)) sitemaps.index = true;
      for (const match of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) sitemaps.urls.add(canonicalUrl(decodeEntities(match[1])));
    } else sitemaps.broken.push(`${artifact.normalized_url} (${artifact.status ?? artifact.error ?? 'no response'})`);
  }
  return sitemaps;
}

/**
 * The values several check blocks share, computed once from the collected evidence.
 * `pageRows` are the selected pages with a 200 raw HTML body, each with its module audit (`info`), its declared robots
 * artifact and its normalized title key. `titleCounts` maps a title key to the rows that carry it. `facts` and `comparison`
 * are the cross-page entity facts. `linkGraph` and `orphans` come from every collected HTML page, `sitemaps` from the
 * declared sitemaps; `crawlComplete` is false when the crawl was cut short and `htmlPages` counts the collected HTML pages. `alternates` maps a page url (as requested and as finally served) to `{ urls, alternates }`, the hreflang
 * links of every collected HTML page. `renderSample` holds the canonical urls of the pages the run renders: the protocol's fixed render pages, or for a run from before the render plan the first URL of each page type. `renders` are the stored render records, `renderTextOf(record)` the final DOM of one, and
 * `chrome` is `{ found, reason }` for the run's Chrome, or null when the run recorded none. `cwv` holds the stored
 * field-data answers, each `{ source, origin, status, body | error, evidence_ref }`, empty when the run collected none.
 */
export function prepare({ context, artifacts, collection = {}, textOf, renders = [], renderTextOf = () => '', chrome = null, cwv = [] }) {
  const { protocol } = context;
  const planned = new Set(protocol.families.filter(x => x.applicable).map(x => x.family_id));
  const selected = new Map(protocol.page_types.flatMap(type => type.urls).map(url => [url.normalized, url]));
  const declared = kind => new Set((protocol.auxiliary_resources ?? []).filter(x => x.kind === kind).map(x => x.normalized));
  const declaredRobots = declared('robots');
  const pageRows = [];
  for (const artifact of artifacts) {
    const url = artifact.normalized_url;
    if (!selected.has(url) || artifact.capability !== 'raw_html' || artifact.status !== 200) continue;
    const html = textOf(artifact);
    const robotsIndex = declaredRobotsIndex(artifacts, declaredRobots, artifact.final_url);
    const robots = robotsIndex < 0 ? null : artifacts[robotsIndex];
    const info = auditCollected({ artifact, html, engines: protocol.engines,
      robotsArtifact: robots?.status === 200 ? { ...robots, body: textOf(robots) } : null });
    pageRows.push({ url, artifact, html, info, robots, publicIndexing: selected.get(url).public_indexing !== false,
      titleKey: info.title ? normalizeTitle(info.title) : null });
  }
  const titleCounts = new Map();
  // A title shared with a page that is not meant to be indexed is no duplicate: only indexed pages compete for a title.
  for (const row of pageRows) if (row.titleKey !== null && row.publicIndexing) titleCounts.set(row.titleKey, [...titleCounts.get(row.titleKey) ?? [], row]);
  const facts = pageRows.map(row => ({ url: row.url, row, facts: pageFacts(row.html, [row.url, row.artifact.final_url]) }));
  const htmlRows = artifacts.filter(x => x.capability === 'raw_html' && x.status === 200)
    .map(artifact => ({ url: artifact.normalized_url, artifact, html: textOf(artifact) }));
  const graph = linkGraph(htmlRows, artifacts);
  const alternates = new Map();
  for (const { artifact, html } of htmlRows) {
    const entry = { urls: [...new Set([artifact.normalized_url, artifact.final_url].map(canonicalUrl))], alternates: alternateLinks(html, artifact.final_url) };
    for (const key of entry.urls) alternates.set(key, entry);
  }
  const sitemaps = readSitemaps(artifacts, declared('sitemap'), textOf, collection.skipped ?? []);
  const complete = !collection.limit_reached && !(collection.skipped ?? []).some(x => SKIP_REASONS.includes(x.reason));
  return { context, artifacts, textOf, planned, selected, pageRows, titleCounts, facts, comparison: compareFacts(facts), sitemaps,
    linkGraph: graph, orphans: findOrphans({ pageRows, rows: htmlRows, graph, sitemaps, complete }), crawlComplete: complete, htmlPages: htmlRows.length, alternates,
    renderSample: new Set(renderPlan(protocol).map(page => canonicalUrl(page.normalized))), renders, renderTextOf, chrome, cwv };
}
