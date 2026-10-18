import { ContractError } from './contracts.mjs';
import { versions } from './config.mjs';

/** Evidence an older optbrew made: one plain sentence that says what is old and what to do. */
export class MigrationRequired extends ContractError {
  constructor(what, detail) {
    super(`migration_required: this ${what} ${detail}; run the audit again with optbrew ${versions().release} in a new output folder`);
  }
}

const numbers = version => typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null;

function isOlder(found, current) {
  const left = numbers(found), right = numbers(current);
  if (!left || !right) return false;
  const at = left.findIndex((part, i) => part !== right[i]);
  return at !== -1 && left[at] < right[at];
}

/**
 * The first version label of an input (a ScoreInput, a ReportPacket or a RunContext) that is older than the one this release
 * uses, as `{ name, found }`; null when none is. The protocol is named first because it is what a comparison reports.
 */
export function olderVersion(input) {
  const context = input?.run_context ?? input;
  const now = versions();
  const checks = [['audit protocol', context?.protocol_version, now.protocol], ['evaluation', context?.evaluation_version, now.evaluation],
    ['contract', input?.schema_version, now.contract_schema], ['contract', context?.schema_version, now.contract_schema]];
  const hit = checks.find(([, found, current]) => isOlder(found, current));
  return hit ? { name: hit[0], found: hit[1] } : null;
}

/** Refuse evidence an older optbrew made, in one sentence, before any schema check can turn it into a stack trace. */
export function assertCurrentEvidence(input, what) {
  const older = olderVersion(input);
  if (older) throw new MigrationRequired(what, `comes from an older optbrew (${older.name} ${older.found})`);
}
