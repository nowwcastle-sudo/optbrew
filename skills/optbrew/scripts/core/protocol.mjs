import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, validateEntity } from './contracts.mjs';

const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const knownFamilies = new Map(registry.families.map(x => [x.family_id, x]));

function unique(values, label) {
  if (values.some(x => typeof x !== 'string' || !x) || new Set(values).size !== values.length)
    throw new ContractError(`${label}: blank or duplicate identifier`);
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

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
  unique(p.families.map(x => x.family_id), 'families');
  unique(p.question_panel.map(x => x.id), 'question_panel');
  if (p.question_panel.some(x => !x.question.trim())) throw new ContractError('question_panel: empty question');
  const urls = p.page_types.flatMap(x => x.urls.map(u => u.normalized));
  unique(urls, 'normalized URLs');
  for (const pageType of p.page_types) {
    if (!pageType.urls.length) throw new ContractError(`empty page type: ${pageType.id}`);
    for (const url of pageType.urls) for (const value of [url.original, url.normalized]) {
      try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error(); }
      catch { throw new ContractError(`invalid HTTP URL: ${value}`); }
    }
  }
  for (const family of p.families) {
    const definition = knownFamilies.get(family.family_id);
    if (!definition) throw new ContractError(`unregistered family: ${family.family_id}`);
    if (family.urls) {
      unique(family.urls, `${family.family_id}.urls`);
      if (family.urls.some(url => !urls.includes(url))) throw new ContractError(`${family.family_id}: URL outside selected protocol`);
    }
    if (family.engines) {
      unique(family.engines, `${family.family_id}.engines`);
      if (family.engines.some(engine => !p.engines.includes(engine))) throw new ContractError(`${family.family_id}: engine outside protocol`);
    }
    if (family.applicable && definition.engines && !definition.engines.some(engine => p.engines.includes(engine)))
      throw new ContractError(`${family.family_id}: required target engine absent`);
    if (family.applicable && ['question-coverage', 'answer-clarity'].includes(family.family_id) && !p.question_panel.length)
      throw new ContractError(`${family.family_id}: fixed question panel required`);
  }
  const sorted = { ...p,
    engines: [...p.engines].sort(),
    families: [...p.families].sort((a, b) => compare(a.family_id, b.family_id)).map(f => ({ ...f,
      ...(f.urls ? { urls: [...f.urls].sort() } : {}),
      ...(f.engines ? { engines: [...f.engines].sort() } : {}) })),
    page_types: [...p.page_types].sort((a, b) => compare(a.id, b.id)).map(t => ({ ...t,
      urls: [...t.urls].sort((a, b) => compare(a.normalized, b.normalized)) })) };
  const protocol = stable({ ...sorted, target: context.target, environment: context.environment,
    evaluation_version: context.evaluation_version, protocol_version: context.protocol_version });
  return { protocol, protocol_hash: createHash('sha256').update(JSON.stringify(protocol)).digest('hex') };
}
