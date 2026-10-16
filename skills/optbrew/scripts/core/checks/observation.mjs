import { createHash } from 'node:crypto';
import { validateEntity } from '../contracts.mjs';
import { versions } from '../config.mjs';

const FIXED_Q = { pass: 1, fail: 0 };

/** Identity of one judged unit: the family, the engine when the family is judged per engine, and the url. */
export const unitKey = (family_id, url, engine = null) => `${family_id}|${engine ? `${engine}|` : ''}${url}`;

/**
 * One code-judged CheckObservation. `observation_id` is the sha256 of `unit_key`, as in 0.1.4. `q` follows the state
 * (pass 1, fail 0, anything else null) unless a block passes its own; `check_id` defaults to the family.
 */
export function makeObservation({ family_id, check_id = family_id, unit_key, state, q = FIXED_Q[state] ?? null, reason, evidence_ref,
  partial_basis = null, extra = {} }) {
  return validateEntity('CheckObservation', { schema_version: versions().contract_schema,
    observation_id: createHash('sha256').update(unit_key).digest('hex'), check_id, family_id, unit_key,
    state, q, partial_basis, reason, evaluator_type: 'code', source_ref: 'optbrew:collector', evidence_ref, ...extra });
}
