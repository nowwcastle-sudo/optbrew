import { blocks } from './checks/index.mjs';
import { prepare } from './checks/prepare.mjs';
import { publicOnlyFamily } from './config.mjs';

/**
 * Every collector verdict, derived from collected responses alone. The audit writes these observations and the
 * report replays this same function over hashed raw evidence, so a producer and a verifier cannot disagree.
 * `artifacts` carry the collection record fields plus evidence_ref; `textOf(artifact)` returns the raw body text.
 * One shared `prepare` step computes what the blocks have in common; each planned family's block then judges it.
 * A family that only matters for indexed pages (`public_only` in the registry) sees only the pages meant to be indexed.
 */
export function deriveObservations(input) {
  const prepared = prepare(input);
  const publicOnly = { ...prepared, pageRows: prepared.pageRows.filter(row => row.publicIndexing) };
  return blocks.filter(block => prepared.planned.has(block.family_id))
    .flatMap(block => block.derive(publicOnlyFamily(block.family_id) ? publicOnly : prepared));
}
