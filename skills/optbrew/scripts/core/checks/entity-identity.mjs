import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'entity-identity';

/** One site-level verdict: Organization JSON-LD with sameAs on the home page, and one name across pages. */
export const entityIdentity = {
  family_id: FAMILY,
  derive({ facts, comparison }) {
    if (!facts.length) return [];
    const reasons = [];
    const home = facts.find(x => new URL(x.row.artifact.final_url).pathname === '/') ?? facts[0];
    const orgPages = facts.filter(x => x.facts.orgs.length && !comparison.separate.has(x.url));
    const nameReference = comparison.references.name;
    const nameDeviants = facts.filter(x => (comparison.deviations.get(x.url) ?? []).some(text => text.startsWith('name ')));
    // The sentences are fixed; which names and pages they concern travel in the measurement.
    const withoutSameAs = orgPages.filter(page => page.facts.orgs.some(org => !org.sameAs));
    if (nameDeviants.length) reasons.push('the business name differs between pages');
    if (withoutSameAs.length) reasons.push('Organization JSON-LD lacks sameAs on some pages');
    if (orgPages.length && !home.facts.orgs.length) reasons.push('no Organization or LocalBusiness JSON-LD on the home page');
    const measurement = { name_reference: nameReference?.label ?? null, name_differs_on: nameDeviants.map(x => x.url),
      without_same_as_on: withoutSameAs.map(x => x.url), home_page: home.url };
    const observe = (state, reason, evidence_ref) => [makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, 'site'), state, reason, evidence_ref, extra: { measurement } })];
    if (reasons.length) return observe('fail', `Entity identity: ${reasons.join('; ')}`, (nameDeviants[0] ?? home).row.artifact.evidence_ref);
    if (orgPages.length) return observe('pass', 'Organization JSON-LD with name and sameAs is present on the home page and names agree', home.row.artifact.evidence_ref);
    return [];
  },
};
