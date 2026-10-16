import { thresholds } from '../config.mjs';
import { anchorTexts } from '../html.mjs';
import { canonicalUrl } from '../link-graph.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'internal-navigation';
const percent = ratio => `${Math.round(ratio * 100)}%`;

/** Same-origin links of a page to other pages, each with its anchor label. */
function internalAnchors({ artifact, html }) {
  const { origin } = new URL(artifact.final_url);
  return anchorTexts(html, artifact.final_url).filter(({ href }) => {
    const target = new URL(href);
    return /^https?:$/.test(target.protocol) && target.origin === origin && canonicalUrl(href) !== canonicalUrl(artifact.final_url);
  });
}

/**
 * A page that is too many clicks from the home page, or whose internal links are mostly empty or generic anchors, fails. A page
 * nothing links to has no click depth: it is left to `discovery`, so it is judged on its anchors only. A site whose pages carry
 * no internal link is not link based, unless a script that was not collected could be building the links.
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
      const depth = linkGraph.depthOf(url);
      const weak = anchors.filter(({ label }) => !label || generic.has(label.toLowerCase())).length;
      const problems = [];
      if (depth !== null && depth > max_click_depth) problems.push(`The home page reaches this page in ${depth} clicks; the limit is ${max_click_depth}`);
      if (anchors.length && weak / anchors.length > empty_anchor_ratio)
        problems.push(`${weak} of ${anchors.length} internal links have an empty or generic anchor; at most ${percent(empty_anchor_ratio)} is allowed`);
      if (problems.length) observe('fail', problems.join('; '));
      else if (depth !== null || anchors.length)
        observe('pass', `${depth === null ? 'Click depth not measured (left to discovery)' : `Reached in ${depth} clicks (limit ${max_click_depth})`}; ${weak} of ${anchors.length} internal links have an empty or generic anchor`);
    }
    return out;
  },
};
