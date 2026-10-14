import { validateEntity, ContractError } from '../core/contracts.mjs';

const providers = new Set(['gsc', 'ga4', 'google_ai', 'bing_ai', 'naver', 'se_ranking']);
const day = 86400000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function dateValue(value) {
  if (typeof value !== 'string' || !datePattern.test(value)) throw new ContractError('invalid complete local date');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new ContractError('invalid complete local date');
  return time;
}
function dateString(time) { return new Date(time).toISOString().slice(0, 10); }

/** Caller supplies the last complete date in the named timezone. */
export function completeWindows(lastCompleteDate, timezone) {
  const end = dateValue(lastCompleteDate);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new ContractError('invalid timezone'); }
  if (!timezone) throw new ContractError('timezone required');
  return { before: { start: dateString(end - 55 * day), end: dateString(end - 28 * day), timezone },
    after: { start: dateString(end - 27 * day), end: lastCompleteDate, timezone } };
}

/** Owner export rows retain provider meaning and source filters; no cross-provider synthesis. */
export function normalizeImport(provider, rows, metadata) {
  if (!providers.has(provider) || !Array.isArray(rows) || !metadata || typeof metadata !== 'object')
    throw new ContractError('invalid provider export');
  const required = ['timezone', 'collected_at', 'source_ref', 'evidence_ref'];
  for (const field of required) if (typeof metadata[field] !== 'string' || !metadata[field])
    throw new ContractError(`import metadata requires ${field}`);
  const { window, sample_selection } = metadata;
  if (!window || window.timezone !== metadata.timezone || dateValue(window.start) > dateValue(window.end) ||
      !sample_selection || !['all', 'positive_only', 'unknown'].includes(sample_selection.kind))
    throw new ContractError('invalid window or sample selection');
  if (!Number.isFinite(Date.parse(metadata.collected_at)) || !/[zZ]|[+-]\d\d:\d\d$/.test(metadata.collected_at))
    throw new ContractError('collected_at requires timezone');
  if (metadata.last_complete_date !== undefined) dateValue(metadata.last_complete_date);
  return rows.map(row => {
    if (!row || typeof row.metric_id !== 'string' || !row.metric_id ||
        typeof (row.provider_definition ?? metadata.provider_definition) !== 'string' ||
        !(row.provider_definition ?? metadata.provider_definition).trim())
      throw new ContractError('native metric definition required');
    if (row.filters && (typeof row.filters !== 'object' || Array.isArray(row.filters)))
      throw new ContractError('row filters must be an object');
    for (const key of ['property', 'aggregation'])
      if (row.filters?.[key] != null && metadata[key] != null && row.filters[key] !== metadata[key])
        throw new ContractError(`row ${key} conflicts with export scope`);
    if (sample_selection.kind === 'positive_only' &&
        (['citation_response_rate', 'all_question_citation_rate', 'overall_citation_rate'].includes(row.metric_id) ||
         row.denominator_scope === 'all_questions'))
      throw new ContractError('positive-only sample cannot estimate all-question citation rate');
    const ambiguousZero = provider === 'google_ai' && row.value === 0 && row.missing_mask !== false;
    const ambiguousDisplay = provider === 'google_ai' && (['~', '-'].includes(row.display_state) || ['~', '-'].includes(row.value));
    const ambiguousMask = row.missing_mask === true;
    const value_state = row.value_state ?? (ambiguousZero || ambiguousDisplay || ambiguousMask ? 'zero_or_missing' :
      row.value === null || row.value === undefined ? 'unknown' : 'measured');
    if ((ambiguousZero || ambiguousDisplay || ambiguousMask) && value_state === 'measured')
      throw new ContractError('Google AI export zero requires a known nonmissing mask');
    const value = value_state === 'measured' ? row.value : null;
    if (value_state === 'measured' && !Number.isFinite(value)) throw new ContractError('measured value must be finite');
    const dimensions = ['property', 'hostname', 'path', 'query', 'search_type', 'device', 'country', 'aggregation'];
    const dimension = key => row.filters?.[key] ?? metadata[key] ?? 'unknown';
    const export_scope = Object.fromEntries(dimensions.map(key => [key, metadata[key] ?? 'unknown']));
    const observation = { schema_version: '1.0.0', metric_id: `${provider}:${row.metric_id}`,
      value_state, value, numerator: row.numerator ?? null, denominator: row.denominator ?? null,
      definition: row.definition ?? row.provider_definition ?? metadata.provider_definition,
      filters: { ...(row.filters ?? {}), provider, property: dimension('property'),
        hostname: dimension('hostname'), search_type: dimension('search_type'),
        device: dimension('device'), country: dimension('country'),
        aggregation: dimension('aggregation'), collected_at: metadata.collected_at,
        ...(metadata.last_complete_date ? { last_complete_date: metadata.last_complete_date } : {}),
        path: dimension('path'), query: dimension('query'), export_scope },
      window: { ...window }, panel_hash: null,
      provider_definition: row.provider_definition ?? metadata.provider_definition,
      sample_selection: { ...sample_selection,
        ...(value_state === 'not_applicable' ? { exclusion_reason: row.not_applicable_reason } : {}) },
      source_ref: metadata.source_ref,
      evidence_ref: row.evidence_ref ?? metadata.evidence_ref };
    return validateEntity('MetricObservation', observation);
  });
}
