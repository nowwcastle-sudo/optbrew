import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateEntity, cwvVerdict, ContractError } from './contracts.mjs';
import { versions } from './config.mjs';
import { compileUnits, scoreWeighted } from './weights.mjs';

const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const profiles = JSON.parse(readFileSync(new URL('../../references/profiles.json', import.meta.url)));
const bundleRoot = new URL('../../', import.meta.url);
// Same rule as fileDigest in bundle.mjs: CRLF from a core.autocrlf checkout hashes as the committed LF bytes.
const sourceDigest = bytes => createHash('sha256')
  .update(bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')).digest('hex');

function assertEvaluationIdentity(context) {
  const manifest = JSON.parse(readFileSync(new URL('bundle-manifest.json', bundleRoot), 'utf8'));
  if (!manifest.evaluation_hash || !manifest.protocol_hash ||
      context.evaluation_version !== manifest.evaluation_version ||
      context.protocol_version !== manifest.protocol_version)
    throw new ContractError('evaluation version or protocol identity differs from installed bundle');
  for (const [field, hashField] of [['evaluation_sources', 'evaluation_hash'], ['protocol_sources', 'protocol_hash']]) {
    const sources = manifest[field];
    if (!Array.isArray(sources) || !sources.length ||
        createHash('sha256').update(JSON.stringify(sources)).digest('hex') !== manifest[hashField] ||
        sources.some(source => sourceDigest(readFileSync(new URL(source.path, bundleRoot))) !== source.sha256))
      throw new ContractError(`${field} identity differs from installed bundle`);
  }
}

export { cwvVerdict };

function band(score) {
  if (score === null) return null;
  if (score < 60) return 'focus_improvement';
  if (score < 80) return 'major_improvement';
  if (score < 95) return 'additional_improvement';
  return 'remaining_review';
}

/** Readiness scores are local audit status, never predicted search or AI outcomes. */
export function score(input) {
  validateEntity('ScoreInput', input);
  assertEvaluationIdentity(input.run_context);
  const units = compileUnits(input, 'SEO');
  const coreIds = new Set(registry.families.filter(x => x.core_policy).map(x => x.family_id));
  const blockingIds = new Set(registry.families.filter(x => x.blocker_on_fail).map(x => x.family_id));
  const canonicalObservations = [...input.observations].sort((a, b) => {
    const left = [a.unit_key, a.observation_id, a.source_ref, a.evidence_ref, a.reason].join('\0');
    const right = [b.unit_key, b.observation_id, b.source_ref, b.evidence_ref, b.reason].join('\0');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const observations = new Map();
  for (const obs of canonicalObservations) if (!observations.has(obs.unit_key)) observations.set(obs.unit_key, obs);
  const blockers = [], unknown_core = [];
  for (const unit of units) {
    const obs = observations.get(unit.key);
    if ((blockingIds.has(unit.family_id) || obs?.blocker) && unit.state === 'fail')
      blockers.push({ family_id: unit.family_id, unit_key: unit.key, reason: obs?.reason ?? 'confirmed failure', evidence_ref: obs?.evidence_ref ?? null });
    if (coreIds.has(unit.family_id) && unit.state === 'unknown')
      unknown_core.push({ family_id: unit.family_id, unit_key: unit.key });
  }
  for (const obs of canonicalObservations) if (obs.blocker && obs.state === 'fail' &&
    !blockers.some(x => x.unit_key === obs.unit_key))
    blockers.push({ family_id: obs.family_id, unit_key: obs.unit_key, reason: obs.reason, evidence_ref: obs.evidence_ref });
  blockers.sort((a, b) => a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0);
  const selectedProfiles = Object.keys(profiles.profiles).filter(name => name !== 'NEO' || input.run_context.protocol.engines.includes('naver'));
  return selectedProfiles.map(profile => {
    const weighted = scoreWeighted(compileUnits(input, profile));
    const readiness = weighted.A === 0 ? 'not_applicable' : blockers.length ? 'blocked' :
      unknown_core.length ? 'unverified' : 100 * weighted.M / weighted.A < 80 - 1e-9 ? 'provisional' : 'measured';
    // Verdicts of a phase with no audit cannot be replayed from collected evidence, so such a phase is never 'measured'.
    const readiness_status = readiness === 'measured' && input.run_context.audited !== true ? 'unverified' : readiness;
    const result = { schema_version: versions().contract_schema, evaluation_version: input.run_context.evaluation_version,
      profile, ...weighted, band: band(weighted.M === 0 ? null : 100 * weighted.N / weighted.M), readiness_status,
      blockers, unknown_core, source_ref: 'optbrew:scoring:0.1.0' };
    return validateEntity('ScoreResult', result);
  });
}
