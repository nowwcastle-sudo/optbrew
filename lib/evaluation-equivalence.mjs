import { readFileSync } from 'node:fs';

/**
 * Prose scoring contract files (`scoring.md`, `measurement.md`) are hashed by the updater, so a title or version sentence
 * fix changes the hash even when no rule changed (PR #46 did this to every managed 0.4.0 install). A reviewer lists in
 * `evaluation-equivalence.json`, per evaluation version, the hashes of every text that states the same evaluation
 * (the 0.4.0 text and the text after #46 for evaluation 0.6.0).
 * The updater accepts a difference only when both bundles carry the same evaluation version and both hashes are listed.
 * Any other change to these files, and every change to a rule file or to the evaluation version, still needs a migration.
 * `tests/update-same-evaluation.test.mjs` fails when the files of this checkout are not listed for its evaluation version.
 */
const listed = JSON.parse(readFileSync(new URL('./evaluation-equivalence.json', import.meta.url), 'utf8'));

export function isSameEvaluationText({ evaluationVersion, nextEvaluationVersion, name, previousHash, nextHash }) {
  if (!evaluationVersion || evaluationVersion !== nextEvaluationVersion) return false;
  const known = listed[evaluationVersion]?.[name];
  return Boolean(known?.includes(previousHash) && known.includes(nextHash));
}
