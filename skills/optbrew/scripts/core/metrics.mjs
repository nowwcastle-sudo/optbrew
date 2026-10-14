import { ContractError, validateEntity } from './contracts.mjs';

function ratio(id, numerator, denominator, definition, panel, selection, evaluable = true) {
  const measured = evaluable && denominator > 0;
  const observation = { schema_version: '1.0.0', metric_id: id,
    value_state: measured ? 'measured' : 'unknown', value: measured ? numerator / denominator : null,
    numerator: measured ? numerator : null, denominator: measured ? denominator : null,
    definition, filters: { engine: panel.engine, surface: panel.surface, model: panel.model,
      search_enabled: panel.search_enabled, locale: panel.locale, region: panel.region },
    window: panel.window, panel_hash: panel.panel_hash, provider_definition: 'optbrew fixed AI response panel v0.1.0',
    sample_selection: selection, source_ref: panel.source_ref, evidence_ref: panel.evidence_ref };
  return validateEntity('MetricObservation', observation);
}

/** Six distinct panel metrics; response-level and citation/claim denominators never mix. */
export function measurePanel(panel, responses, evaluations) {
  if (!panel || !Array.isArray(panel.questions) || !panel.questions.length ||
      new Set(panel.questions.map(q => q.id)).size !== panel.questions.length ||
      !Number.isInteger(panel.repeats) || panel.repeats < 1 || !panel.panel_hash ||
      typeof panel.search_enabled !== 'boolean' || !panel.target_entity ||
      !Array.isArray(panel.target_domains) || !panel.target_domains.length ||
      !Array.isArray(responses) || !Array.isArray(evaluations))
    throw new ContractError('invalid fixed panel');
  const planned = panel.questions.length * panel.repeats;
  const slots = new Set(), responseIds = new Set(), valid = [];
  for (const response of responses) {
    const slot = `${response.question_id}\0${response.repeat}`;
    if (!panel.questions.some(q => q.id === response.question_id) ||
        !Number.isInteger(response.repeat) || response.repeat < 0 || response.repeat >= panel.repeats ||
        slots.has(slot) || !response.response_id || responseIds.has(response.response_id) || typeof response.valid !== 'boolean')
      throw new ContractError('response outside or duplicated in fixed panel');
    slots.add(slot); responseIds.add(response.response_id);
    if (response.valid) {
      if (!Array.isArray(response.cited_urls) || typeof response.target_mentioned !== 'boolean' ||
          !Array.isArray(response.brand_mentions)) throw new ContractError('valid response lacks evaluated fields');
      for (const citedUrl of response.cited_urls) {
        try { if (!['http:', 'https:'].includes(new URL(citedUrl).protocol)) throw new Error(); }
        catch { throw new ContractError('valid response has invalid citation URL'); }
      }
      valid.push(response);
    }
  }
  const selection = { kind: 'all', planned_responses: planned, valid_responses: valid.length,
    unique_questions: panel.questions.length, inference: panel.questions.length < 10 ? 'exploratory' : 'descriptive' };
  const targetDomains = panel.target_domains.map(domain => domain.toLowerCase());
  const cited = response => (response.cited_urls ?? []).some(url => {
    try { const host = new URL(url).hostname.toLowerCase(); return targetDomains.some(domain => host === domain || host.endsWith(`.${domain}`)); }
    catch { return false; }
  });
  const citationCount = valid.filter(cited).length;
  const mentionCount = valid.filter(r => r.target_mentioned === true).length;
  const brands = new Set([panel.target_entity, ...(panel.competitor_entities ?? [])]);
  const brandCount = valid.reduce((sum, r) => sum + [...new Set(r.brand_mentions)].filter(x => brands.has(x)).length, 0);
  const targetBrandCount = valid.filter(r => r.brand_mentions.includes(panel.target_entity)).length;
  const validIds = new Set(valid.map(r => r.response_id));
  if (evaluations.some(e => !validIds.has(e.response_id)) ||
      new Set(evaluations.map(e => e.response_id)).size !== evaluations.length)
    throw new ContractError('duplicate evaluation or evaluation without valid panel response');
  const support = evaluations.flatMap(e => e.citations ?? []).filter(x =>
    x.evaluable === true && x.source_accessible === true && typeof x.supported === 'boolean');
  const facts = panel.fact_list_ref ? evaluations.flatMap(e => e.claims ?? []).filter(x =>
    x.evaluable === true && typeof x.matches === 'boolean') : [];
  return [
    ratio('target_citation_response_rate', citationCount, valid.length, 'valid responses citing a target URL or domain / valid responses', panel, selection),
    ratio('target_entity_mention_rate', mentionCount, valid.length, 'valid responses with evaluated target entity mention / valid responses', panel, selection),
    ratio('citation_support_rate', support.filter(x => x.supported === true).length, support.length,
      'supported evaluable linked citations / evaluable linked citations', panel,
      { ...selection, evaluation_scope: support.length, ...(support.length ? {} : { missing_reason: 'no_accessible_evaluable_citations' }) }, support.length > 0),
    ratio('fact_consistency_rate', facts.filter(x => x.matches === true).length, facts.length,
      'matching evaluable important claims / evaluable important claims', panel,
      { ...selection, evaluation_scope: facts.length, ...(panel.fact_list_ref ? {} : { missing_reason: 'approved_fact_list_missing' }) }, facts.length > 0),
    ratio('observed_brand_share', targetBrandCount, brandCount,
      'target mentions once per response / mentions for fixed competitor set', panel, selection),
    ratio('observation_completion_rate', valid.length, planned, 'valid responses / planned responses', panel, selection),
  ];
}
