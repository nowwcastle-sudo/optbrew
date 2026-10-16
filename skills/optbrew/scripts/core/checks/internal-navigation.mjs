import { thresholds } from '../config.mjs';
import { anchorTexts } from '../html.mjs';
import { canonicalUrl, sameOriginLinks } from '../link-graph.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'internal-navigation';

/** Same-origin links of a page to other pages, each with its anchor label. */
function internalAnchors({ artifact, html }) {
  const anchors = anchorTexts(html, artifact.final_url);
  const internal = new Set(sameOriginLinks(anchors.map(({ href }) => href), artifact.final_url));
  return anchors.filter(({ href }) => {
    const target = new URL(href); target.hash = '';
    return internal.has(target.href) && canonicalUrl(href) !== canonicalUrl(artifact.final_url);
  });
}

/**
 * A page that is too many clicks from the home page, or whose linked pages mostly have no descriptive anchor, fails. A linked page
 * counts as weak only when every anchor to it on the page is empty or generic: an icon or a "more" link beside a descriptive link
 * to the same target is normal navigation. A page nothing links to has no click depth: it is left to `discovery`, so it is judged
 * on its anchors only. A site whose pages carry no internal link is not link based, unless a script that was not collected could be
 * building the links.
 */
export const internalNavigation = {
  family_id: FAMILY,
  derive({ pageRows, linkGraph }) {
    const { max_click_depth, empty_anchor_ratio, generic_anchor_terms } = thresholds(FAMILY);
    const generic = new Set(generic_anchor_terms.map(term => term.toLowerCase()));
    const rows = pageRows.map(row => ({ row, anchors: internalAnchors(row) }));
    const linkBased = rows.some(({ anchors }) => anchors.length > 0);
    const out = [];
    for (const { row: { url, artifact }, anchors } of rows) {
      const observe = (state, reason, extra = {}) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref, extra }));
      if (!linkBased) {
        if (linkGraph.scriptGap) observe('unknown', 'No links in the raw HTML; a script that was not collected may build the navigation');
        else {
          const reason = 'No collected page links to another page of the site';
          observe('not_applicable', reason, { applicability_decision: { condition: 'not_link_based', reason, evidence_ref: artifact.evidence_ref } });
        }
        continue;
      }
      const descriptive = new Map();
      for (const { href, label } of anchors) {
        const target = canonicalUrl(href);
        descriptive.set(target, descriptive.get(target) || (Boolean(label) && !generic.has(label.toLowerCase())));
      }
      const weak = [...descriptive.values()].filter(ok => !ok).length;
      const depth = linkGraph.depthOf(url);
      // The sentences are fixed, so the same problem reads the same on every page; the numbers are page-specific and travel in the measurement.
      const measurement = { click_depth: depth, max_click_depth, weak_anchor_pages: weak, linked_pages: descriptive.size, allowed_weak_ratio: empty_anchor_ratio };
      const problems = [];
      if (depth !== null && depth > max_click_depth) problems.push('The home page reaches this page in more clicks than the limit');
      if (descriptive.size && weak / descriptive.size > empty_anchor_ratio) problems.push('Linked pages have too many empty or generic anchors');
      if (problems.length) observe('fail', problems.join('; '), { measurement: { ...measurement, problems } });
      // A page with no click depth and no internal link has nothing to judge: it gets no observation on purpose (discovery covers it).
      else if (depth !== null || descriptive.size)
        observe('pass', depth === null ? 'Click depth not measured (left to discovery); anchors are within the limit' : 'Reached within the click limit; anchors are within the limit', { measurement });
    }
    return out;
  },
};
