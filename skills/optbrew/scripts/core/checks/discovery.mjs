import { canonicalUrl } from '../link-graph.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'discovery';
const ORPHAN = 'discovery.orphan';
const SITEMAP_UNUSABLE = 'discovery.orphan-sitemap-unusable';

// A declared sitemap that was never fetched may list the page, so its absence from the sitemaps that were read proves nothing.
const unreadReason = unread => `declared sitemap not read: ${[...new Set(unread.map(x => x.reason))].join(', ')}; not linked from a collected page, and the evidence cannot show that nothing else leads to it`;

const UNPROVEN = 'Not in a read sitemap and not linked from a collected page, but the evidence cannot show that nothing else leads to it';

/** A page listed in a declared sitemap or linked from another collected page passes; a proven orphan fails; the rest is unknown. */
export const discovery = {
  family_id: FAMILY,
  message_keys: [ORPHAN, SITEMAP_UNUSABLE],
  derive({ pageRows, linkGraph, orphans, sitemaps, crawlComplete, htmlPages }) {
    const out = [];
    for (const row of pageRows) {
      if (!row.publicIndexing) continue;
      const { url, artifact } = row;
      const keys = [canonicalUrl(url), canonicalUrl(artifact.final_url)];
      const inSitemap = keys.some(key => sitemaps.urls.has(key));
      const observe = (state, reason) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref }));
      if (inSitemap || keys.some(key => linkGraph.inbound(key))) observe('pass', inSitemap ? 'Listed in a declared sitemap' : 'Linked from another collected page');
      else if (orphans.has(url)) {
        const unlinked = 'Not linked from any collected page and not in a sitemap';
        const broken = sitemaps.broken.join(', ');
        out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: 'fail', evidence_ref: artifact.evidence_ref,
          problems: [broken ? problem(`${unlinked}; declared sitemap unusable: ${broken}`, SITEMAP_UNUSABLE, { broken }) : problem(unlinked, ORPHAN)] }));
      } else {
        // Reaching a page because the run selected it is not discoverability, and an orphan is only proven on complete evidence
        // (see findOrphans). A page neither listed nor linked that cannot be proven an orphan is unknown, and says what leaves it open.
        out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: 'unknown', evidence_ref: artifact.evidence_ref,
          reason: sitemaps.unread.length ? unreadReason(sitemaps.unread) : UNPROVEN,
          extra: { measurement: { crawl_complete: crawlComplete, sitemap_index_unread: sitemaps.index, script_gap: linkGraph.scriptGap, collected_pages: htmlPages,
            ...(sitemaps.unread.length ? { sitemap_unread: sitemaps.unread } : {}) } } }));
      }
    }
    return out;
  },
};
