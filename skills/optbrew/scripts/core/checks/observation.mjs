import { createHash } from 'node:crypto';
import { validateEntity } from '../contracts.mjs';
import { versions } from '../config.mjs';
import { messageOf } from '../messages.mjs';

const FIXED_Q = { pass: 1, fail: 0 };

/** Identity of one judged unit: the family, the engine when the family is judged per engine, and the url. */
export const unitKey = (family_id, url, engine = null) => `${family_id}|${engine ? `${engine}|` : ''}${url}`;

/**
 * One problem a failed check states: its English sentence (the grouping key, never translated), the catalog key of its Korean
 * sentence, and the page-specific values that sentence fills.
 */
export const problem = (text, message_key, message_values = {}) => ({ text, ...messageOf(message_key, message_values) });

/** What a failed verdict records for the problems it states: the joined reason, the list when there are several, and each problem's Korean key. */
function statedProblems(problems, extra) {
  const texts = problems.map(item => item.text);
  const measurement = texts.length > 1 && !extra.measurement?.problems ? { ...extra.measurement, problems: texts } : extra.measurement;
  return { reason: texts.join('; '), extra: { ...extra, ...(measurement ? { measurement } : {}),
    problem_messages: problems.map(({ message_key, message_values }) => messageOf(message_key, message_values)) } };
}

/**
 * One code-judged CheckObservation. `observation_id` is the sha256 of `unit_key`, as in 0.1.4. `q` follows the state
 * (pass 1, fail 0, anything else null) unless a block passes its own; `check_id` defaults to the family. A failed verdict
 * passes the `problems` it states (see `problem`) instead of a reason: the reason is their texts joined, and
 * `problem_messages` lines up with them for the report's Korean text.
 */
export function makeObservation({ family_id, check_id = family_id, unit_key, state, q = FIXED_Q[state] ?? null, reason, evidence_ref,
  partial_basis = null, problems = null, extra = {} }) {
  const stated = problems ? statedProblems(problems, extra) : { reason, extra };
  return validateEntity('CheckObservation', { schema_version: versions().contract_schema,
    observation_id: createHash('sha256').update(unit_key).digest('hex'), check_id, family_id, unit_key,
    state, q, partial_basis, reason: stated.reason, evaluator_type: 'code', source_ref: 'optbrew:collector', evidence_ref, ...stated.extra });
}
