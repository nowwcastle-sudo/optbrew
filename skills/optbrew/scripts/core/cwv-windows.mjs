import { CWV_FAMILIES } from './checks/cwv-field.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = text => typeof text === 'string' && DAY.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? Date.parse(`${text}T00:00:00Z`) : null;

/** The collection period a field verdict records in `measurement.collection_period`; null unless both dates read as days and the first is not after the last. */
function periodOf(observation) {
  const period = observation.measurement?.collection_period;
  const first = dayOf(period?.first_date), last = dayOf(period?.last_date);
  return first !== null && last !== null && first <= last ? { first_date: period.first_date, last_date: period.last_date, first, last } : null;
}

/** The field-data verdicts of one run by unit; the first of a unit stands. */
const fieldVerdicts = input => {
  const result = new Map();
  for (const obs of input.observations)
    if (CWV_FAMILIES.includes(obs.family_id) && obs.measurement && !result.has(obs.unit_key)) result.set(obs.unit_key, obs);
  return result;
};

const dates = period => period && { first_date: period.first_date, last_date: period.last_date };

/**
 * The days the field data of each unit both runs measured was collected in. Field data (CrUX) is a rolling window, so a later window
 * that shares a day with the earlier one still holds days from before the fix: its pass proves nothing about the fix (`overlap`).
 * Windows that do not touch are `separate`. A window that is missing, null or unreadable (old evidence, a PageSpeed answer) cannot
 * be checked, which is `unverifiable` and never a reason to refuse. A unit only one run measured has no pair and is not listed.
 */
export function cwvWindows(before, after) {
  const earlier = fieldVerdicts(before), later = fieldVerdicts(after);
  return [...earlier.keys()].filter(key => later.has(key)).sort().map(unit_key => {
    const old = periodOf(earlier.get(unit_key)), now = periodOf(later.get(unit_key));
    const state = !old || !now ? 'unverifiable' : now.first <= old.last && old.first <= now.last ? 'overlap' : 'separate';
    return { unit_key, before: dates(old), after: dates(now), state };
  });
}
