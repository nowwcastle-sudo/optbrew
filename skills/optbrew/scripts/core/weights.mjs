import { readFileSync } from 'node:fs';
import { ContractError, validateEntity } from './contracts.mjs';
import { freezeProtocol } from './protocol.mjs';

const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const profiles = JSON.parse(readFileSync(new URL('../../references/profiles.json', import.meta.url)));
const tolerance = 1e-9;

function candidateUnits(definition, plan, protocol) {
  const pageTypes = protocol.page_types.map(type => ({ ...type,
    urls: type.urls.filter(url => !plan.urls || plan.urls.includes(url.normalized)) })).filter(type => type.urls.length);
  const pages = pageTypes.flatMap(type => type.urls.map(url => ({ url: url.normalized,
    share: 1 / pageTypes.length / type.urls.length })));
  const scope = definition.unit_scope;
  if (scope === 'site') return [{ key: `${definition.family_id}|site`, engine: null, url: null, share: 1 }];
  if (scope === 'origin') {
    const origins = [...new Set(pages.map(page => new URL(page.url).origin))];
    return origins.map(origin => ({ key: `${definition.family_id}|${origin}`, engine: null, url: origin, share: 1 / origins.length }));
  }
  if (scope === 'url') return pages.map(page => ({ key: `${definition.family_id}|${page.url}`,
    engine: null, url: page.url, share: page.share }));
  if (scope === 'engine_url') {
    const engines = (plan.engines ?? protocol.engines).filter(engine => !definition.engines || definition.engines.includes(engine));
    return engines.flatMap(engine => pages.map(page => ({ key: `${definition.family_id}|${engine}|${page.url}`,
      engine, url: page.url, share: page.share / engines.length })));
  }
  throw new ContractError(`unsupported unit scope: ${scope}`);
}

function observationsByUnit(input) {
  const result = new Map();
  for (const obs of input.observations) {
    if (obs.check_id !== obs.family_id) throw new ContractError(`unregistered check_id: ${obs.check_id}`);
    const previous = result.get(obs.unit_key);
    if (previous && (previous.family_id !== obs.family_id || previous.state !== obs.state ||
      previous.q !== obs.q || JSON.stringify(previous.partial_basis) !== JSON.stringify(obs.partial_basis) ||
      Boolean(previous.blocker) !== Boolean(obs.blocker)))
      throw new ContractError(`conflicting observation for ${obs.unit_key}`);
    result.set(obs.unit_key, previous ?? obs);
  }
  return result;
}

/** Compile fixed protocol units in axis → family → engine → page type/URL order. */
export function compileUnits(input, profile) {
  validateEntity('ScoreInput', input);
  const profileWeights = profiles.profiles[profile];
  if (!profileWeights) throw new ContractError(`unknown profile: ${profile}`);
  const { protocol } = freezeProtocol(input.run_context);
  const plans = new Map(protocol.families.map(plan => [plan.family_id, plan]));
  if (plans.size !== registry.families.length || registry.families.some(def => !plans.has(def.family_id)))
    throw new ContractError('protocol must state applicability for all 22 families');
  const observed = observationsByUnit(input);
  const questionCoverage = observed.get('question-coverage|site');
  if (questionCoverage?.partial_basis?.kind === 'ratio' &&
      questionCoverage.partial_basis.denominator !== protocol.question_panel.length)
    throw new ContractError('question-coverage denominator differs from fixed panel');
  const expected = new Set();
  const families = [];
  for (const definition of registry.families) {
    const plan = plans.get(definition.family_id);
    if (!plan.applicable) continue;
    const candidates = candidateUnits(definition, plan, protocol);
    if (!candidates.length) throw new ContractError(`applicable family has no fixed units: ${definition.family_id}`);
    for (const candidate of candidates) expected.add(candidate.key);
    const active = candidates.map(candidate => ({ ...candidate, observation: observed.get(candidate.key) })).filter(x => x.observation?.state !== 'not_applicable');
    if (active.length) families.push({ definition, active, total: active.reduce((sum, x) => sum + x.share, 0) });
  }
  for (const obs of input.observations) {
    if (!expected.has(obs.unit_key) || !obs.unit_key.startsWith(`${obs.family_id}|`))
      throw new ContractError(`unregistered observation unit: ${obs.unit_key}`);
  }
  const axes = profiles.axes.filter(axis => profileWeights[axis] > 0 && families.some(f => f.definition.axis === axis));
  const availableAxisWeight = axes.reduce((sum, axis) => sum + profileWeights[axis], 0);
  const units = [];
  for (const axis of axes) {
    const axisFamilies = families.filter(f => f.definition.axis === axis);
    const axisWeight = 100 * profileWeights[axis] / availableAxisWeight;
    for (const family of axisFamilies) {
      for (const candidate of family.active) {
        const obs = candidate.observation;
        units.push({ key: candidate.key, family_id: family.definition.family_id,
          engine: candidate.engine, url: candidate.url,
          weight: axisWeight / axisFamilies.length * candidate.share / family.total,
          state: obs?.state ?? 'unknown', q: obs?.q ?? null });
      }
    }
  }
  return units;
}

const display = value => Math.round((value + Number.EPSILON) * 10) / 10;
const tidy = value => Math.abs(value) < tolerance ? 0 : Math.abs(value - 100) < tolerance ? 100 : value;

/** A/M/N remain raw weighted totals; only displayed percentages are rounded. */
export function scoreWeighted(units) {
  if (!Array.isArray(units)) throw new ContractError('units must be an array');
  const keys = new Set();
  let A = 0, M = 0, N = 0;
  for (const unit of units) {
    if (!unit || typeof unit.key !== 'string' || !unit.key || keys.has(unit.key) ||
      !Number.isFinite(unit.weight) || unit.weight < 0) throw new ContractError('invalid or duplicate weighted unit');
    keys.add(unit.key);
    const { state, q, weight } = unit;
    if (state === 'not_applicable') {
      if (q !== null) throw new ContractError('not_applicable q must be null');
      continue;
    }
    A += weight;
    if (state === 'unknown') {
      if (q !== null) throw new ContractError('unknown q must be null');
      continue;
    }
    if (!['pass', 'partial', 'fail'].includes(state) || !Number.isFinite(q) || q < 0 || q > 1 ||
      (state === 'pass' && Math.abs(q - 1) > tolerance) ||
      (state === 'fail' && Math.abs(q) > tolerance) ||
      (state === 'partial' && !(q > 0 && q < 1))) throw new ContractError(`invalid weighted verdict: ${unit.key}`);
    M += weight;
    N += weight * q;
  }
  A = tidy(A); M = tidy(M); N = tidy(N);
  return { A, M, N, score: M === 0 ? null : display(100 * N / M),
    coverage: A === 0 ? null : display(100 * M / A),
    missing_bounds: A === 0 ? null : [display(100 * N / A), display(100 * (N + A - M) / A)] };
}
