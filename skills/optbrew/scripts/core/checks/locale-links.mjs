import { canonicalUrl } from '../link-graph.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'locale-links';
const X_DEFAULT = 'x-default';

const points = (href, page) => page.urls.includes(canonicalUrl(href));

/**
 * A page that declares hreflang alternates needs an x-default and a return link from every alternate it names; a page that
 * another page lists as its alternate must list that page in turn. An alternate that was not collected cannot be checked,
 * so the page is unknown rather than passed. A page with no hreflang, or only one that names itself, that no page lists belongs to a single-locale site.
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
      if (mine.every(alternate => points(alternate.href, self)) && !listedBy.length) {
        const reason = 'No hreflang link on this page and no collected page lists it as an alternate';
        observe('not_applicable', reason, { applicability_decision: { condition: 'single_locale', reason, evidence_ref: artifact.evidence_ref } });
        continue;
      }
      // Fixed sentences; which pages are meant travels in the measurement.
      const problems = new Set();
      const noReturn = [], listedWithoutReturn = [];
      if (mine.length && !mine.some(alternate => alternate.hreflang === X_DEFAULT)) problems.add('No x-default alternate is declared');
      let unchecked = 0;
      for (const alternate of mine) {
        if (points(alternate.href, self)) continue;
        const target = alternates.get(canonicalUrl(alternate.href));
        if (!target) unchecked += 1;
        else if (!target.alternates.some(back => points(back.href, self))) { problems.add('An alternate page does not link back to this page'); noReturn.push(target.urls[0]); }
      }
      for (const other of listedBy) if (!mine.some(alternate => points(alternate.href, other))) { problems.add('A page that lists this page as an alternate is not listed back'); listedWithoutReturn.push(other.urls[0]); }
      const measurement = { alternates_without_return_link: noReturn, pages_listing_this_page_without_return: listedWithoutReturn, unchecked_alternates: unchecked };
      if (problems.size) observe('fail', [...problems].join('; '), { measurement: { ...measurement, problems: [...problems] } });
      else if (unchecked) observe('unknown', 'Some alternate pages were not collected, so their return links are unchecked', { measurement });
      else observe('pass', 'An x-default alternate is declared and every alternate links back', { measurement });
    }
    return out;
  },
};
