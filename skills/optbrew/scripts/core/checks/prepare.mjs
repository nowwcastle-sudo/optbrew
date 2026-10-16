import { auditCollected } from '../../../modules/naver-searchadvisor/scripts/audit.mjs';
import { alternateLinks, decodeEntities } from '../html.mjs';
import { declaredRobotsIndex } from '../collector.mjs';
import { compareFacts, pageFacts } from '../facts.mjs';
import { canonicalUrl, findOrphans, linkGraph } from '../link-graph.mjs';

const SKIP_REASONS = ['depth_limit', 'url_limit', 'request_limit'];
const normalizeTitle = title => title.toLowerCase().replace(/\s+/g, ' ').trim();

/** The declared sitemaps among the collected artifacts: every listed url, whether one is an index, and the unusable ones. */
function readSitemaps(artifacts, declared, textOf) {
  const sitemaps = { urls: new Set(), index: false, broken: [] };
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
 * declared sitemaps. `alternates` maps a page url (as requested and as finally served) to `{ urls, alternates }`, the hreflang
 * links of every collected HTML page. `renders` are the stored render records, `renderTextOf(record)` the final DOM of one, and
 * `chrome` is `{ found, reason }` for the run's Chrome, or null when the run recorded none. `cwv` stays empty until the
 * field-data stage exists.
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
  for (const row of pageRows) if (row.titleKey !== null) titleCounts.set(row.titleKey, [...titleCounts.get(row.titleKey) ?? [], row]);
  const facts = pageRows.map(row => ({ url: row.url, row, facts: pageFacts(row.html) }));
  const htmlRows = artifacts.filter(x => x.capability === 'raw_html' && x.status === 200)
    .map(artifact => ({ url: artifact.normalized_url, artifact, html: textOf(artifact) }));
  const graph = linkGraph(htmlRows, artifacts);
  const alternates = new Map();
  for (const { artifact, html } of htmlRows) {
    const entry = { urls: [...new Set([artifact.normalized_url, artifact.final_url].map(canonicalUrl))], alternates: alternateLinks(html, artifact.final_url) };
    for (const key of entry.urls) alternates.set(key, entry);
  }
  const sitemaps = readSitemaps(artifacts, declared('sitemap'), textOf);
  const complete = !collection.limit_reached && !(collection.skipped ?? []).some(x => SKIP_REASONS.includes(x.reason));
  return { context, artifacts, textOf, planned, selected, pageRows, titleCounts, facts, comparison: compareFacts(facts), sitemaps,
    linkGraph: graph, orphans: findOrphans({ pageRows, rows: htmlRows, graph, sitemaps, complete }), alternates, renders, renderTextOf, chrome, cwv };
}
