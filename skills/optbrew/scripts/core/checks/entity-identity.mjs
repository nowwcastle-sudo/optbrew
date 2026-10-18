import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'entity-identity';
const NAME_DIFFERS = problem('Entity identity: the business name differs between pages', 'entity-identity.name-differs');
const NO_SAME_AS = problem('Entity identity: Organization JSON-LD lacks sameAs on some pages', 'entity-identity.no-same-as');
const NO_HOME_ORGANIZATION = problem('Entity identity: no Organization or LocalBusiness JSON-LD on the home page', 'entity-identity.no-home-organization');

/** One site-level verdict: Organization JSON-LD with sameAs on the home page, and one name across pages. */
export const entityIdentity = {
  family_id: FAMILY,
  message_keys: [NAME_DIFFERS, NO_SAME_AS, NO_HOME_ORGANIZATION].map(item => item.message_key),
  derive({ facts, comparison }) {
    if (!facts.length) return [];
    const problems = [];
    const home = facts.find(x => new URL(x.row.artifact.final_url).pathname === '/') ?? facts[0];
    const orgPages = facts.filter(x => x.facts.orgs.length && !comparison.separate.has(x.url));
    const nameReference = comparison.references.name;
    const nameDeviants = facts.filter(x => (comparison.deviations.get(x.url) ?? []).some(text => text.startsWith('name ')));
    // The sentences are fixed; which names and pages they concern travel in the measurement.
    const withoutSameAs = orgPages.filter(page => page.facts.orgs.some(org => !org.sameAs));
    if (nameDeviants.length) problems.push(NAME_DIFFERS);
    if (withoutSameAs.length) problems.push(NO_SAME_AS);
    if (orgPages.length && !home.facts.orgs.length) problems.push(NO_HOME_ORGANIZATION);
    const measurement = { name_reference: nameReference?.label ?? null, name_differs_on: nameDeviants.map(x => x.url),
      without_same_as_on: withoutSameAs.map(x => x.url), home_page: home.url };
    const observe = (state, stated, evidence_ref) => [makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, 'site'), state, evidence_ref, ...stated, extra: { measurement } })];
    if (problems.length) return observe('fail', { problems }, (nameDeviants[0] ?? home).row.artifact.evidence_ref);
    if (orgPages.length) return observe('pass', { reason: 'Organization JSON-LD with name and sameAs is present on the home page and names agree' }, home.row.artifact.evidence_ref);
    return [];
  },
};
