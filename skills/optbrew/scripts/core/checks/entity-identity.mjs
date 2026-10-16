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
    if (nameDeviants.length) reasons.push(`name differs from "${nameReference.label}" on ${nameDeviants.map(x => x.url).join(', ')}`);
    for (const page of orgPages) if (page.facts.orgs.some(org => !org.sameAs)) reasons.push(`Organization JSON-LD without sameAs on ${page.url}`);
    if (orgPages.length && !home.facts.orgs.length) reasons.push(`no Organization or LocalBusiness JSON-LD on ${home.url}`);
    const observe = (state, reason, evidence_ref) => [makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, 'site'), state, reason, evidence_ref })];
    if (reasons.length) return observe('fail', `Entity identity: ${reasons.join('; ')}`, (nameDeviants[0] ?? home).row.artifact.evidence_ref);
    if (orgPages.length) return observe('pass', 'Organization JSON-LD with name and sameAs is present on the home page and names agree', home.row.artifact.evidence_ref);
    return [];
  },
};
