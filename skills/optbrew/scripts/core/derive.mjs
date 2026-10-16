import { blocks } from './checks/index.mjs';
import { prepare } from './checks/prepare.mjs';

/**
 * Every collector verdict, derived from collected responses alone. The audit writes these observations and the
 * report replays this same function over hashed raw evidence, so a producer and a verifier cannot disagree.
 * `artifacts` carry the collection record fields plus evidence_ref; `textOf(artifact)` returns the raw body text.
 * One shared `prepare` step computes what the blocks have in common; each planned family's block then judges it.
 */
export function deriveObservations(input) {
  const prepared = prepare(input);
  return blocks.filter(block => prepared.planned.has(block.family_id)).flatMap(block => block.derive(prepared));
}
