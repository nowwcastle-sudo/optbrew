import { readFileSync } from 'node:fs';
import { blocks } from './checks/index.mjs';
import { makeObservation, unitKey } from './checks/observation.mjs';
import { limits } from './config.mjs';
import { sensitive } from './secrets.mjs';

const FETCH_FAMILY = 'fetch-response';
const MODEL_EVALUATOR = 'host_model';
/** The `source_ref` of every model observation; report replay pins it. */
export const MODEL_SOURCE = 'optbrew:model-judgment';
const QUEUE_KIND = 'judge-queue';
const QUEUE_SECTION = 'judge_queue';
const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const verdictMode = new Map(registry.families.map(family => [family.family_id, family.verdict_mode]));
const SPACE = '[ \\t\\r\\n\\f]';
const LEADING = new RegExp(`^${SPACE}*`);
const TRAILING = new RegExp(`${SPACE}+$`);
// Text that is not shown to a reader: comments and script, style, template and noscript bodies.
const INERT = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** The families a model may judge: per-page families that have no code check block. Code-judged families are read from the block list. */
function modelFamilies() {
  return registry.families.filter(family => family.unit_scope === 'url' && !isCodeJudged(family.family_id)).map(family => family.family_id);
}

/** Whether a family has a code check block, so only code may judge it. */
export const isCodeJudged = family_id => blocks.some(block => block.family_id === family_id);

/**
 * Throw unless `{ start, end }` is a non-empty UTF-8 byte range (end exclusive) of `bytes` that begins and ends on character
 * boundaries and decodes as text. Report replay and mergeJudgments both use this one check.
 */
export function checkSpan(bytes, { start, end }) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length)
    throw new Error(`span ${start}-${end} is not a byte range inside the evidence (${bytes.length} bytes)`);
  const inside = index => index < bytes.length && (bytes[index] & 0xC0) === 0x80;
  if (inside(start) || inside(end)) throw new Error(`span ${start}-${end} splits a multi-byte character`);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end)); }
  catch { throw new Error(`span ${start}-${end} is not valid UTF-8 text`); }
}

/**
 * Candidate spans of one HTML body: each run of text between tags, trimmed of ASCII whitespace, as UTF-8 byte offsets.
 * The body is scanned as bytes (latin1), so offsets are byte offsets and a run can only start or end next to an ASCII
 * character, never inside a multi-byte one. Runs with a secret are dropped; the longest runs are kept, in document order.
 */
function candidateSpans(bytes, evidence_sha256) {
  const { judge_spans_per_unit: cap, judge_span_min_bytes: minimum } = limits();
  const masked = bytes.toString('latin1').replace(INERT, found => `<${' '.repeat(found.length - 2)}>`);
  const spans = [];
  for (const run of masked.matchAll(/[^<>]+/g)) {
    const start = run.index + LEADING.exec(run[0])[0].length;
    const end = run.index + run[0].replace(TRAILING, '').length;
    if (end - start < minimum) continue;
    const text = bytes.subarray(start, end).toString('utf8');
    if (!sensitive.test(text)) spans.push({ span_id: `${start}-${end}`, evidence_sha256, start, end, text });
  }
  return spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start).slice(0, cap).sort((a, b) => a.start - b.start);
}

/**
 * The model's work list: for every page that was fetched and every model-judged family with no verdict yet, the page's
 * candidate spans. Evidence is read through the store, so a body that no longer matches its recorded hash fails here.
 * Returns `{ items: [{ family_id, unit_key, url, evidence_ref, evidence_sha256, spans }] }` and stores it in the run evidence
 * (kind `judge-queue`, listed with its hash in the index section `judge_queue`); mergeJudgments and report replay read that copy.
 */
export async function buildJudgeQueue({ observations, store }) {
  const index = await store.index();
  const { raw } = index;
  const recorded = new Map(raw.filter(entry => entry.content_hash).map(entry => [entry.evidence_ref, entry]));
  const judged = new Set(observations.filter(observation => observation.state !== 'unknown').map(observation => observation.unit_key));
  const pages = new Map();
  for (const observation of observations) {
    const entry = observation.family_id === FETCH_FAMILY && observation.state === 'pass' ? recorded.get(observation.evidence_ref) : null;
    if (entry && !pages.has(entry.evidence_ref)) pages.set(entry.evidence_ref, entry);
  }
  const families = modelFamilies();
  const items = [];
  const queue = { items };
  for (const entry of pages.values()) {
    const spans = candidateSpans(await store.read(entry.evidence_ref, entry.content_hash), entry.content_hash);
    if (!spans.length) continue;
    for (const family_id of families) {
      const unit_key = unitKey(family_id, entry.normalized_url);
      if (!judged.has(unit_key)) items.push({ family_id, unit_key, url: entry.normalized_url, evidence_ref: entry.evidence_ref,
        evidence_sha256: entry.content_hash, spans });
    }
  }
  const { ref, sha256 } = await store.write(QUEUE_KIND, `${JSON.stringify(queue, null, 2)}\n`);
  if (!(index[QUEUE_SECTION] ?? []).some(entry => entry.sha256 === sha256)) await store.append(QUEUE_SECTION, { evidence_ref: ref, sha256 });
  return queue;
}

/** The newest queue stored in the run, read with its hash verified. */
async function storedQueue(store) {
  const entry = ((await store.index())[QUEUE_SECTION] ?? []).at(-1);
  if (!entry) throw new Error('no judge queue is stored in the run evidence; build it first');
  return JSON.parse((await store.read(entry.evidence_ref, entry.sha256)).toString('utf8'));
}

/** Whether `span` is exactly one of the candidates the queue offered for this observation's unit and evidence. */
export function queuedSpan(queue, observation, span) {
  const item = (queue.items ?? []).find(x => x.unit_key === observation.unit_key && x.family_id === observation.family_id);
  return item?.evidence_ref === observation.evidence_ref && item.spans.some(x => x.evidence_sha256 === span.evidence_sha256 &&
    x.start === span.start && x.end === span.end);
}

/** A partial verdict must fit the family's verdict mode; returns the basis and the q it implies. */
function partialBasis(judgment) {
  const mode = verdictMode.get(judgment.family_id);
  if (mode === 'binary') throw new Error(`${judgment.family_id} is binary; a partial judgment is not allowed`);
  if (mode === 'threshold_half') return { basis: { kind: 'threshold_half' }, q: 0.5 };
  const basis = judgment.partial_basis;
  const { numerator, denominator } = basis ?? {};
  if (basis?.kind !== 'ratio' || !Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || numerator >= denominator)
    throw new Error(`a partial judgment for ${judgment.family_id} needs partial_basis { kind: "ratio", numerator, denominator } with 0 < numerator < denominator`);
  return { basis, q: numerator / denominator };
}

/**
 * Merge model judgments into the observations. A judgment names a queued unit and the `span_id`s it relies on. The queue is
 * the copy stored in the run evidence (hash verified), never one passed in; each cited range is taken from it and re-checked
 * against the stored evidence. A state other than `unknown` needs spans, and the observation records each cited range, not a
 * range that covers them. Code-judged families are never overwritten, a unit that already has a verdict is refused, and an
 * `unknown` placeholder is replaced.
 */
export async function mergeJudgments({ observations, judgments, store }) {
  const queue = await storedQueue(store);
  const items = new Map(queue.items.map(item => [item.unit_key, item]));
  const made = [];
  for (const judgment of judgments) {
    const { family_id, unit_key, state } = judgment;
    if (isCodeJudged(family_id)) throw new Error(`${family_id} is judged by code; a model judgment cannot overwrite it`);
    const item = items.get(unit_key);
    if (!item || item.family_id !== family_id) throw new Error(`no queued unit for ${family_id} ${unit_key}`);
    if (made.some(observation => observation.unit_key === unit_key)) throw new Error(`more than one judgment for ${unit_key}`);
    if (observations.some(observation => observation.unit_key === unit_key && observation.state !== 'unknown'))
      throw new Error(`${unit_key} already has a verdict`);
    if (state === 'not_applicable') throw new Error('a model judgment cannot declare not_applicable');
    if (sensitive.test(judgment.reason ?? '')) throw new Error(`judgment reason for ${unit_key} contains a secret`);
    const extra = { evaluator_type: MODEL_EVALUATOR, source_ref: MODEL_SOURCE };
    if (state !== 'unknown') {
      if (!judgment.span_ids?.length) throw new Error(`a ${state} judgment for ${unit_key} needs span_ids`);
      const spans = judgment.span_ids.map(id => {
        const queued = item.spans.find(span => span.span_id === id);
        if (!queued) throw new Error(`unknown span_id ${id} for ${unit_key}`);
        return queued;
      });
      if (new Set(judgment.span_ids).size !== spans.length) throw new Error(`span_ids repeat a span for ${unit_key}`);
      const bytes = await store.read(item.evidence_ref, item.evidence_sha256);
      extra.evidence_span = spans.map(({ evidence_sha256, start, end }) => ({ evidence_sha256, start, end }));
      for (const part of extra.evidence_span) {
        if (part.evidence_sha256 !== item.evidence_sha256) throw new Error(`span of ${unit_key} is not from the unit's evidence`);
        checkSpan(bytes, part);
      }
    }
    const partial = state === 'partial' ? partialBasis(judgment) : { basis: null, q: undefined };
    made.push(makeObservation({ family_id, unit_key, state, q: judgment.q ?? partial.q, reason: judgment.reason,
      evidence_ref: item.evidence_ref, partial_basis: partial.basis, extra }));
  }
  const replaced = new Set(made.map(observation => observation.unit_key));
  return [...observations.filter(observation => !replaced.has(observation.unit_key)), ...made];
}
