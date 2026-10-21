import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, validateEntity, validateApplicabilityDecision } from './contracts.mjs';
import { assertUrlInScope } from './scope.mjs';
import { limits, publicOnlyFamily, requestLimit } from './config.mjs';

const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const knownFamilies = new Map(registry.families.map(x => [x.family_id, x]));

function unique(values, label) {
  if (values.some(x => typeof x !== 'string' || !x) || new Set(values).size !== values.length)
    throw new ContractError(`${label}: blank or duplicate identifier`);
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** The engines of the run a family covers: its own registry engines that the run targets, or every target engine. */
const coveredEngines = (definition, protocol) => definition.engines ? definition.engines.filter(engine => protocol.engines.includes(engine)) : protocol.engines;

/**
 * The inapplicable conditions the run's own fixed facts decide, in the order a held one names the reason: the question panel, the
 * target engines (`no_target_engine`, or a `*_not_target` condition of a family with registry engines), the goals (a `*_not_goal`
 * condition of a family with registry goals), and the public index targets (`no_public_index_target` of a `public_only` family).
 * `holds` answers whether the condition is true for this run.
 */
const FIXED_CONDITIONS = [
  { matches: code => code === 'no_fixed_questions', holds: ({ protocol }) => !protocol.question_panel.length },
  { matches: (code, definition) => code === 'no_target_engine' || (code.endsWith('_not_target') && definition.engines?.length > 0),
    holds: ({ definition, protocol }) => !coveredEngines(definition, protocol).length },
  { matches: (code, definition) => code.endsWith('_not_goal') && definition.goals?.length > 0,
    holds: ({ definition, protocol }) => !definition.goals.some(goal => (protocol.goals ?? []).includes(goal)) },
  { matches: (code, definition) => code === 'no_public_index_target' && definition.public_only === true, holds: ({ publicCount }) => publicCount === 0 },
];

/**
 * Whether the run's own fixed conditions decide a family's applicability, and the condition code that names the reason when it is not
 * applicable; null when no fixed condition decides it (the owner's or the model's decision then stands). Read from the registry, never from
 * a list of family names: no inapplicable condition at all means always applicable; otherwise the first fixed condition that holds makes
 * the family inapplicable, and a family whose fixed conditions all fail is applicable. A test holds the registry flag and this rule together (T22 S2).
 */
function fixedApplicability(definition, protocol, publicCount) {
  const conditions = definition.na_conditions ?? [];
  if (!conditions.length) return { applicable: true, condition: null };
  const fixed = FIXED_CONDITIONS.map(rule => ({ rule, code: conditions.find(code => rule.matches(code, definition)) })).filter(x => x.code);
  if (!fixed.length) return null;
  const held = fixed.find(({ rule }) => rule.holds({ definition, protocol, publicCount }));
  return held ? { applicable: false, condition: held.code } : { applicable: true, condition: null };
}
const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** Fix comparison inputs; run_id, timestamps and evidence paths are excluded. */
export function freezeProtocol(context) {
  validateEntity('RunContext', context);
  const p = context.protocol;
  for (const key of ['target', 'environment', 'evaluation_version', 'protocol_version'])
    if (Object.hasOwn(p, key) && JSON.stringify(p[key]) !== JSON.stringify(context[key]))
      throw new ContractError(`protocol ${key} differs from RunContext`);
  unique(p.page_types.map(x => x.id), 'page_types');
  unique(p.engines, 'engines');
  unique(p.goals ?? [], 'goals');
  unique(p.families.map(x => x.family_id), 'families');
  unique(p.question_panel.map(x => x.id), 'question_panel');
  if (p.question_panel.some(x => !x.question.trim())) throw new ContractError('question_panel: empty question');
  const urls = p.page_types.flatMap(x => x.urls.map(u => u.normalized));
  unique(urls, 'normalized URLs');
  if (!urls.length) throw new ContractError('protocol requires selected public audit URLs');
  const { render } = p;
  unique(render.pages.map(x => x.normalized), 'render pages');
  if (render.pages.length > limits().render_pages) throw new ContractError('render pages exceed the render page limit');
  if (render.pages.some(x => !urls.includes(x.normalized))) throw new ContractError('render page is not a selected URL');
  if (!Number.isInteger(render.max_render_requests) || render.max_render_requests > limits().max_render_requests)
    throw new ContractError('render request limit is not a whole number within the render ceiling');
  const resources = p.auxiliary_resources ?? [];
  unique(resources.map(x => x.normalized), 'auxiliary resources');
  if (resources.some(x => urls.includes(x.normalized))) throw new ContractError('auxiliary resource duplicates a selected URL');
  if (urls.length + resources.length > requestLimit(context.scope)) throw new ContractError('selected pages and auxiliary resources exceed request scope');
  for (const resource of resources) {
    for (const url of [resource.original, resource.normalized]) {
      try { assertUrlInScope(url, context.scope); }
      catch { throw new ContractError(`auxiliary resource outside scope: ${url}`); }
    }
    if (assertUrlInScope(resource.original, context.scope).href !== resource.normalized)
      throw new ContractError(`auxiliary resource normalized URL mismatch: ${resource.original}`);
  }
  for (const pageType of p.page_types) {
    if (!pageType.urls.length) throw new ContractError(`empty page type: ${pageType.id}`);
    for (const url of pageType.urls) {
      for (const value of [url.original, url.normalized]) {
        try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error(); }
        catch { throw new ContractError(`invalid HTTP URL: ${value}`); }
      }
      if (/\/(?:robots\.txt|sitemap[^/]*\.xml)$/i.test(decodeURIComponent(new URL(url.normalized).pathname)))
        throw new ContractError(`${url.normalized}: robots and sitemap must be auxiliary resources`);
      if (url.public_indexing === false) validateApplicabilityDecision(url.indexing_decision,
        ['not_public_index_target'], `${url.normalized}.indexing_decision`);
      else if (url.indexing_decision) throw new ContractError(`${url.normalized}: indexing decision requires public_indexing=false`);
    }
  }
  const publicUrls = p.page_types.flatMap(type => type.urls.filter(url => url.public_indexing !== false).map(url => url.normalized));
  for (const family of p.families) {
    const definition = knownFamilies.get(family.family_id);
    if (!definition) throw new ContractError(`unregistered family: ${family.family_id}`);
    const requiredUrls = publicOnlyFamily(family.family_id) ? publicUrls : urls;
    if (family.urls) {
      unique(family.urls, `${family.family_id}.urls`);
      if (definition.unit_scope === 'site' || !sameSet(family.urls, requiredUrls))
        throw new ContractError(`${family.family_id}: use unit not_applicable decisions instead of omitting selected URLs`);
    }
    if (family.engines) {
      unique(family.engines, `${family.family_id}.engines`);
      const requiredEngines = coveredEngines(definition, p);
      if (definition.unit_scope !== 'engine_url' || !sameSet(family.engines, requiredEngines))
        throw new ContractError(`${family.family_id}: target engine units cannot be omitted`);
    }
    // A family that only matters for indexed pages has no unit when every selected page is a non-index target.
    if (publicOnlyFamily(family.family_id) && family.applicable && !publicUrls.length)
      throw new ContractError(`${family.family_id}: applicable family has no public index target`);
    const fixed = fixedApplicability(definition, p, publicUrls.length);
    if (fixed && family.applicable !== fixed.applicable)
      throw new ContractError(`${family.family_id}: applicability contradicts fixed URL/engine conditions`);
    if (family.applicable) {
      if (family.applicability_decision) throw new ContractError(`${family.family_id}: decision only allowed when inapplicable`);
    } else {
      const decision = validateApplicabilityDecision(family.applicability_decision,
        definition.na_conditions, `${family.family_id}.applicability_decision`);
      const automaticCondition = fixed?.condition ?? null;
      if (automaticCondition && decision.condition !== automaticCondition)
        throw new ContractError(`${family.family_id}: decision conflicts with fixed conditions`);
    }
    if (family.applicable && ['question-coverage', 'answer-clarity'].includes(family.family_id) && !p.question_panel.length)
      throw new ContractError(`${family.family_id}: fixed question panel required`);
  }
  const sorted = { ...p,
    ...(p.auxiliary_resources ? { auxiliary_resources: [...resources].sort((a, b) => compare(a.normalized, b.normalized)) } : {}),
    render: { ...render, pages: [...render.pages].sort((a, b) => compare(a.normalized, b.normalized)) },
    engines: [...p.engines].sort(),
    ...(p.goals ? { goals: [...p.goals].sort() } : {}),
    ...(p.confirmed_facts ? { confirmed_facts: [...p.confirmed_facts].sort((a, b) => compare(a.key, b.key) || compare(a.value, b.value)) } : {}),
    families: [...p.families].sort((a, b) => compare(a.family_id, b.family_id)).map(f => ({ ...f,
      ...(f.urls ? { urls: [...f.urls].sort() } : {}),
      ...(f.engines ? { engines: [...f.engines].sort() } : {}) })),
    page_types: [...p.page_types].sort((a, b) => compare(a.id, b.id)).map(t => ({ ...t,
      urls: [...t.urls].sort((a, b) => compare(a.normalized, b.normalized)).map(url => ({ ...url,
        public_indexing: url.public_indexing !== false })) })) };
  const protocol = stable({ ...sorted, target: context.target, environment: context.environment,
    evaluation_version: context.evaluation_version, protocol_version: context.protocol_version });
  const hashInput = structuredClone(protocol);
  for (const type of hashInput.page_types) for (const url of type.urls) if (url.indexing_decision)
    url.indexing_decision = { condition: url.indexing_decision.condition };
  for (const url of hashInput.render.pages) if (url.indexing_decision) url.indexing_decision = { condition: url.indexing_decision.condition };
  for (const family of hashInput.families) if (family.applicability_decision)
    family.applicability_decision = { condition: family.applicability_decision.condition };
  if (hashInput.target_identity) {
    for (const mapping of hashInput.target_identity.native_properties ?? []) delete mapping.evidence_ref;
    if (hashInput.target_identity.panel) delete hashInput.target_identity.panel.evidence_ref;
  }
  return { protocol, protocol_hash: createHash('sha256').update(JSON.stringify(stable(hashInput))).digest('hex') };
}
