import { canonicalUrl } from '../link-graph.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'locale-links';
const X_DEFAULT = 'x-default';

const points = (href, page) => page.urls.includes(canonicalUrl(href));

/**
 * A page that declares hreflang alternates needs an x-default and a return link from every alternate it names; a page that
 * another page lists as its alternate must list that page in turn. An alternate that was not collected cannot be checked,
 * so the page is unknown rather than passed. A page with no hreflang that no page lists belongs to a single-locale site.
 */
export const localeLinks = {
  family_id: FAMILY,
  derive({ pageRows, alternates }) {
    const pages = new Set(alternates.values());
    const out = [];
    for (const { url, artifact } of pageRows) {
      const self = alternates.get(canonicalUrl(artifact.normalized_url));
      const mine = self.alternates;
      const listedBy = [...pages].filter(other => other !== self && other.alternates.some(alternate => points(alternate.href, self)));
      const observe = (state, reason, extra = {}) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref, extra }));
      if (!mine.length && !listedBy.length) {
        const reason = 'No hreflang link on this page and no collected page lists it as an alternate';
        observe('not_applicable', reason, { applicability_decision: { condition: 'single_locale', reason, evidence_ref: artifact.evidence_ref } });
        continue;
      }
      const problems = [];
      if (mine.length && !mine.some(alternate => alternate.hreflang === X_DEFAULT)) problems.push('No x-default alternate is declared');
      let unchecked = 0;
      for (const alternate of mine) {
        if (points(alternate.href, self)) continue;
        const target = alternates.get(canonicalUrl(alternate.href));
        if (!target) unchecked += 1;
        else if (!target.alternates.some(back => points(back.href, self))) problems.push(`${target.urls[0]} does not link back to this page`);
      }
      for (const other of listedBy) if (!mine.some(alternate => points(alternate.href, other)))
        problems.push(`${other.urls[0]} lists this page as an alternate but this page does not list it back`);
      if (problems.length) observe('fail', problems.join('; '));
      else if (unchecked) observe('unknown', `${unchecked} alternate page(s) were not collected, so their return links are unchecked`);
      else observe('pass', 'An x-default alternate is declared and every alternate links back');
    }
    return out;
  },
};
