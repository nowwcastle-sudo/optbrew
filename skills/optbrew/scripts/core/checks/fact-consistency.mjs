import { FACT_MESSAGE_KEYS, confirmedDeviations, confirmedReferences } from '../facts.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'fact-consistency';
const PREFIX = 'Cross-page fact comparison (no approved fact list): ';
const NO_FACTS = 'The page has no labelled, marked-up or tel: contact fact (name, phone number, address, founding year) that this check can compare';
const states = (page, type) => page.facts.visible[type].size > 0 || page.facts.linked[type].size > 0 || (type === 'phone' && page.facts.tel.phone.size > 0);

/**
 * Contact facts compared with the facts the owner confirmed at the start (`protocol.confirmed_facts`) and across pages. A confirmed
 * value is the reference of its type, so a page that differs from it fails and the cross-page vote is not taken for that type. Other
 * types are compared across pages, where agreement is consistency, not accuracy. A branch page is never compared.
 */
export const factConsistency = {
  family_id: FAMILY,
  message_keys: Object.values(FACT_MESSAGE_KEYS),
  derive({ context, facts, comparison }) {
    const confirmed = confirmedReferences(context.protocol.confirmed_facts ?? []);
    const confirmedTypes = new Set(confirmed.keys());
    const out = [];
    for (const page of facts) {
      if (comparison.separate.has(page.url)) continue;
      const stated = comparison.deviation_messages.get(page.url) ?? [];
      const crossPage = (comparison.deviations.get(page.url) ?? []).map((text, index) => ({ text, ...stated[index] }))
        .filter(item => !(item.message_key === FACT_MESSAGE_KEYS.differs && confirmedTypes.has(item.message_values.type)));
      const problems = [
        ...confirmedDeviations(page, confirmed).map(values => problem(`Confirmed fact comparison: ${values.type} "${values.found}" differs from the confirmed "${values.confirmed}"`,
          FACT_MESSAGE_KEYS.confirmed, values)),
        ...crossPage.map(item => problem(`${PREFIX}${item.text}`, item.message_key, item.message_values))];
      const againstConfirmed = [...confirmedTypes].some(type => states(page, type));
      const comparable = againstConfirmed || Object.keys(comparison.references).some(type => states(page, type));
      // A page that states no contact fact has nothing to compare. A page that states one but has no reference to meet stays unknown:
      // a missing reference is a missing fact list, not an inapplicable page.
      const stating = Object.keys(page.facts.visible).some(type => states(page, type));
      const observe = (state, judged) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, page.url), state, evidence_ref: page.row.artifact.evidence_ref, ...judged }));
      // Each conflict is its own problem: the values are the problem itself (R63), so a page with two conflicts has two fixes.
      if (problems.length) observe('fail', { problems });
      else if (comparable) observe('pass', { reason: againstConfirmed ? 'Facts on this page match the confirmed facts and the cross-page reference values'
        : 'Facts on this page match the cross-page reference values (no approved fact list; consistency is not accuracy)' });
      else if (!stating) observe('not_applicable', { reason: NO_FACTS, extra: { measurement: { facts_found: 0 },
        applicability_decision: { condition: 'no_evaluable_facts', reason: NO_FACTS, evidence_ref: page.row.artifact.evidence_ref } } });
    }
    return out;
  },
};
