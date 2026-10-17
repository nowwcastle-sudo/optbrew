import { inflateRawSync } from 'node:zlib';
import { validateEntity, ContractError } from '../core/contracts.mjs';
import { limits, versions } from '../core/config.mjs';

// ZIP record signatures and the two compression methods Search Console's export uses.
const ZIP_END = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const ZIP_END_SIZE = 22;
const ZIP_CENTRAL_SIZE = 46;
const ZIP_LOCAL_SIZE = 30;
// Search Console dates its performance report in Pacific time; Naver Search Advisor in Korea time.
const GSC_TIMEZONE = 'America/Los_Angeles';
const NAVER_TIMEZONE = 'Asia/Seoul';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAVER_PERIOD = /(\d{4})[.-](\d{2})[.-](\d{2})\s*~\s*(\d{4})[.-](\d{2})[.-](\d{2})/;
// Column names as the English and Korean screens print them.
const DATE_COLUMNS = ['date', '날짜', '일자'];
const CLICK_COLUMNS = ['clicks', '클릭수', '클릭'];
const IMPRESSION_COLUMNS = ['impressions', '노출수', '노출'];

/** A file the owner handed over that cannot be used; `reason` is a short code the report shows next to the missing numbers. */
const unusable = reason => Object.assign(new Error(reason), { reason });

/** The entries of a ZIP archive, read from its central directory. */
function zipEntries(bytes) {
  try {
    let end = bytes.length - ZIP_END_SIZE;
    while (end >= 0 && bytes.readUInt32LE(end) !== ZIP_END) end--;
    if (end < 0) throw unusable('export_not_a_zip');
    let offset = bytes.readUInt32LE(end + 16);
    const entries = [];
    for (let count = bytes.readUInt16LE(end + 10); count > 0; count--) {
      if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL) throw unusable('export_zip_damaged');
      const [nameLength, extraLength, commentLength] = [28, 30, 32].map(at => bytes.readUInt16LE(offset + at));
      entries.push({ name: bytes.toString('utf8', offset + ZIP_CENTRAL_SIZE, offset + ZIP_CENTRAL_SIZE + nameLength), method: bytes.readUInt16LE(offset + 10),
        compressed: bytes.readUInt32LE(offset + 20), original: bytes.readUInt32LE(offset + 24), local: bytes.readUInt32LE(offset + 42) });
      offset += ZIP_CENTRAL_SIZE + nameLength + extraLength + commentLength;
    }
    return entries;
  } catch (error) { throw error.reason ? error : unusable('export_zip_damaged'); }
}

/** The text of one archive entry; an entry larger than the collection byte limit is refused, so a small file cannot expand into memory. */
function zipText(bytes, entry) {
  if (entry.original > limits().max_bytes) throw unusable('export_file_too_large');
  try {
    const start = entry.local + ZIP_LOCAL_SIZE + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
    const data = bytes.subarray(start, start + entry.compressed);
    if (entry.method === ZIP_STORED) return data.toString('utf8');
    if (entry.method === ZIP_DEFLATED) return inflateRawSync(data, { maxOutputLength: limits().max_bytes }).toString('utf8');
  } catch { throw unusable('export_zip_damaged'); }
  throw unusable('export_zip_method_unsupported');
}

/** Rows of a CSV text (quoted cells, doubled quotes, CRLF), without a leading byte-order mark. */
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

const column = (header, names) => header.findIndex(name => names.includes(name.trim().toLowerCase()));
const count = value => { const number = Number(String(value).replace(/,/g, '')); return Number.isFinite(number) ? number : null; };

/** Clicks and impressions as totals, with ctr as their ratio. */
function trafficRows(clicks, impressions, label) {
  return [
    { metric_id: 'clicks', value: clicks, provider_definition: `${label}: clicks summed over the rows of the export` },
    { metric_id: 'impressions', value: impressions, provider_definition: `${label}: impressions summed over the rows of the export` },
    ...(impressions > 0 ? [{ metric_id: 'ctr', value: clicks / impressions, numerator: clicks, denominator: impressions,
      provider_definition: `${label}: clicks divided by impressions over the rows of the export` }] : []),
  ];
}

/** Search Console's CSV export: the archive's daily table (date, clicks, impressions) gives the totals and the period. */
function readGsc(bytes) {
  const archive = zipEntries(bytes);
  for (const entry of archive.filter(x => x.name.toLowerCase().endsWith('.csv'))) {
    const [header, ...body] = csvRows(zipText(bytes, entry));
    if (!header) continue;
    const [date, clicks, impressions] = [DATE_COLUMNS, CLICK_COLUMNS, IMPRESSION_COLUMNS].map(names => column(header, names));
    if (date < 0 || clicks < 0 || impressions < 0 || !body.length || !body.every(row => ISO_DATE.test(row[date]))) continue;
    const days = body.map(row => row[date]).sort();
    const totals = body.map(row => [count(row[clicks]), count(row[impressions])]);
    if (totals.some(pair => pair.includes(null))) throw unusable('export_numbers_unreadable');
    return { provider: 'gsc', window: { start: days[0], end: days.at(-1), timezone: GSC_TIMEZONE }, sample_selection: { kind: 'all' },
      rows: trafficRows(totals.reduce((sum, pair) => sum + pair[0], 0), totals.reduce((sum, pair) => sum + pair[1], 0), 'Search Console performance report') };
  }
  throw unusable('export_table_not_found');
}

/** Naver Search Advisor's pasted table: tab- or space-separated, a header with the click and impression columns, and the period printed above it. */
function readNaver(bytes) {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const period = NAVER_PERIOD.exec(text);
  if (!period) throw unusable('export_period_missing');
  const lines = text.split(/\r?\n/).map(line => line.split(/\t| {2,}/).map(cell => cell.trim()).filter(Boolean));
  const at = lines.findIndex(cells => column(cells, CLICK_COLUMNS) >= 0 && column(cells, IMPRESSION_COLUMNS) >= 0);
  if (at < 0) throw unusable('export_table_not_found');
  const [clicks, impressions] = [CLICK_COLUMNS, IMPRESSION_COLUMNS].map(names => column(lines[at], names));
  const body = lines.slice(at + 1).filter(cells => cells.length > Math.max(clicks, impressions) && count(cells[clicks]) !== null && count(cells[impressions]) !== null);
  if (!body.length) throw unusable('export_numbers_unreadable');
  const [start, end] = [period.slice(1, 4), period.slice(4, 7)].map(parts => parts.join('-'));
  // A pasted top-N table lists only its leading rows, so its totals say nothing about the whole site.
  return { provider: 'naver', window: { start, end, timezone: NAVER_TIMEZONE }, sample_selection: { kind: 'unknown' },
    rows: trafficRows(body.reduce((sum, cells) => sum + count(cells[clicks]), 0), body.reduce((sum, cells) => sum + count(cells[impressions]), 0), 'Naver Search Advisor table as pasted') };
}

/**
 * The numbers an owner's export holds: `gsc` is the Search Console CSV export (a zip), `naver` the table pasted from Search
 * Advisor as text. Returns `{ provider, window, sample_selection, rows }` for `normalizeImport`; a file that cannot be read
 * throws an error whose `reason` names why, so the caller can report the gap instead of failing.
 */
export function readOwnerExport(kind, bytes) {
  if (kind === 'gsc') return readGsc(bytes);
  if (kind === 'naver') return readNaver(bytes);
  throw unusable('export_kind_unknown');
}

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
    const observation = { schema_version: versions().contract_schema, metric_id: `${provider}:${row.metric_id}`,
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
