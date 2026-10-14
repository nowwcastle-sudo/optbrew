import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../../references/schemas/contract.schema.json', import.meta.url)));
const tolerance = 1e-9;
const cwv = { 'lcp-field': [2500, 4000, 'ms'], 'inp-field': [200, 500, 'ms'], 'cls-field': [0.1, 0.25, 'unitless'] };

export class ContractError extends Error {
  constructor(message) { super(message); this.name = 'ContractError'; }
}

function fail(path, message) { throw new ContractError(`${path}: ${message}`); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }

function jsonSafe(value, path = '$', seen = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail(path, 'not JSON data');
  if (typeof value === 'number' && !Number.isFinite(value)) fail(path, 'nonfinite number');
  if (value && typeof value === 'object') {
    if (seen.has(value)) fail(path, 'cycle');
    seen.add(value);
    if (!Array.isArray(value) && !plainObject(value)) fail(path, 'not a plain JSON object');
    for (const [key, child] of Object.entries(value)) jsonSafe(child, `${path}.${key}`, seen);
    seen.delete(value);
  }
}

function checkRule(rule, value, path) {
  if (rule.$ref) return checkRule(schema.$defs[rule.$ref.split('/').at(-1)], value, path);
  if ('const' in rule && value !== rule.const) fail(path, `expected ${JSON.stringify(rule.const)}`);
  if (rule.enum && !rule.enum.includes(value)) fail(path, 'unrecognized value');
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const valid = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? plainObject(value) : typeof value === type);
    if (!valid) fail(path, `expected ${types.join(' or ')}`);
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) fail(path, 'below minimum');
    if (rule.maximum !== undefined && value > rule.maximum) fail(path, 'above maximum');
  }
  if (plainObject(value)) {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required');
    if (rule.additionalProperties === false) for (const key of Object.keys(value))
      if (!Object.hasOwn(rule.properties ?? {}, key)) fail(`${path}.${key}`, 'unexpected field');
    for (const [key, child] of Object.entries(rule.properties ?? {})) if (Object.hasOwn(value, key)) checkRule(child, value[key], `${path}.${key}`);
  }
  if (Array.isArray(value) && rule.items) value.forEach((item, i) => checkRule(rule.items, item, `${path}[${i}]`));
}

/** Official p75 thresholds; optbrew assigns the middle interval q=0.5. */
export function cwvVerdict(familyId, value, { percentile = 75, source_type = 'field', unit } = {}) {
  const limits = cwv[familyId];
  if (!limits) throw new ContractError(`unknown CWV family: ${familyId}`);
  if (!Number.isFinite(value) || value < 0 || percentile !== 75 || source_type !== 'field' || unit !== limits[2])
    throw new ContractError(`invalid p75 field measurement for ${familyId}`);
  if (value <= limits[0] + tolerance) return { state: 'pass', q: 1, partial_basis: null };
  if (value > limits[1] + tolerance) return { state: 'fail', q: 0, partial_basis: null };
  return { state: 'partial', q: 0.5, partial_basis: { kind: 'threshold_half' } };
}

function checkObservation(value) {
  const { state, q, partial_basis: basis } = value;
  if (state === 'unknown' || state === 'not_applicable') {
    if (q !== null || basis !== null) fail('CheckObservation', `${state} requires null q and basis`);
  } else if (state === 'pass' || state === 'fail') {
    if (typeof q !== 'number' || Math.abs(q - (state === 'pass' ? 1 : 0)) > tolerance || basis !== null) fail('CheckObservation', `${state} requires fixed q and null basis`);
  } else if (state === 'partial') {
    if (!plainObject(basis) || !(q > 0 && q < 1)) fail('CheckObservation', 'partial requires a supported basis and interior q');
    if (basis.kind === 'threshold_half') {
      if (Math.abs(q - 0.5) > tolerance) fail('CheckObservation', 'threshold_half requires q=0.5');
    } else if (basis.kind === 'ratio') {
      if (!Number.isInteger(basis.numerator) || !Number.isInteger(basis.denominator) || basis.denominator <= 0 ||
          basis.numerator <= 0 || basis.numerator >= basis.denominator || Math.abs(q - basis.numerator / basis.denominator) > tolerance)
        fail('CheckObservation', 'ratio requires matching integer numerator and positive denominator');
    } else fail('CheckObservation', 'unsupported partial basis');
  }
  if (value.measurement && cwv[value.family_id]) {
    const expected = cwvVerdict(value.family_id, value.measurement.value, value.measurement);
    if (expected.state !== state || Math.abs(expected.q - q) > tolerance) fail('CheckObservation', 'CWV state/q differs from field p75');
  } else if (cwv[value.family_id] && !['unknown', 'not_applicable'].includes(state)) {
    fail('CheckObservation', 'CWV measurement requires field p75 source and unit');
  }
  if (value.blocker === true && state !== 'fail') fail('CheckObservation', 'blocker requires fail');
}

/** Validate a persisted entity and return its original value. */
export function validateEntity(typeName, value) {
  const rule = schema.$defs[typeName];
  if (!rule) throw new ContractError(`unknown entity type: ${typeName}`);
  jsonSafe(value);
  checkRule(rule, value, typeName);
  if (typeName === 'CheckObservation') checkObservation(value);
  if (typeName === 'ScoreInput') value.observations.forEach(checkObservation);
  return value;
}
