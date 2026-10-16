import { canonicalUrl } from '../link-graph.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'discovery';
const ORPHAN = 'discovery.orphan';
const SITEMAP_UNUSABLE = 'discovery.orphan-sitemap-unusable';

/** A page listed in a declared sitemap or linked from another collected page passes; a proven orphan fails. */
export const discovery = {
  family_id: FAMILY,
  message_keys: [ORPHAN, SITEMAP_UNUSABLE],
  derive({ pageRows, linkGraph, orphans, sitemaps }) {
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
      }
    }
    return out;
  },
};
