import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport } from '../../skills/optbrew/scripts/core/report.mjs';
import { composeReport } from '../../skills/optbrew/scripts/core/report-compose.mjs';

const fixtureRoot = path.resolve('tests/fixtures/reports');

/** The remote-only report packet, pointing at its evidence folder. */
export const fixturePacket = () => ({ ...JSON.parse(readFileSync(path.join(fixtureRoot, 'remote-only.json'), 'utf8')), evidence_root: fixtureRoot });

/** What buildReport hands the composer, rebuilt from the report JSON of the remote-only fixture; `over` replaces fields. */
export function verifiedOf(over = {}) {
  const { json } = buildReport(fixturePacket());
  return { ...json, outcome_rows: json.tables.actual_outcomes, lab_cwv: null, answered_runbooks: [], ...over };
}

/** The headline the composer gives one score result of the first profile, in a phase that was audited, was not (false) or has no `audited` field (null). */
export function headlineOf(result, { audited = true } = {}) {
  const verified = verifiedOf();
  const context = { ...verified.baseline.input.run_context };
  delete context.audited;
  const input = { ...verified.baseline.input, run_context: audited === null ? context : { ...context, audited } };
  return composeReport({ ...verified, baseline: { input, scores: [result] } }).completeness[0].before.headline;
}
