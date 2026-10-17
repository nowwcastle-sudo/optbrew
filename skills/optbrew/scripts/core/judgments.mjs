import { readFileSync } from 'node:fs';
import { blocks } from './checks/index.mjs';
import { makeObservation, problem, unitKey } from './checks/observation.mjs';
import { limits } from './config.mjs';
import { sensitive } from './secrets.mjs';

const FETCH_FAMILY = 'fetch-response';
const MODEL_EVALUATOR = 'host_model';
const ENTITY_FAMILY = 'entity-identity';
const ANSWER_FAMILY = 'answer-clarity';
const QUESTION_FAMILY = 'question-coverage';
/**
 * The only `source_ref` each evaluator type may carry in a replayed packet; report replay refuses any other pair. `derived` is the
 * code evaluator's second pair: a verdict computed from the model's judgments (the question coverage), which report replay computes again.
 */
export const OBSERVATION_SOURCES = Object.freeze({ code: 'optbrew:collector', [MODEL_EVALUATOR]: 'optbrew:model-judgment', derived: 'optbrew:judgment-derived' });
export const QUEUE_KIND = 'judge-queue';
/** The two site units the model's work touches: the identity fallback it may judge, and the question coverage that code derives from its answers. */
export const ENTITY_UNIT = unitKey(ENTITY_FAMILY, 'site');
export const QUESTION_UNIT = unitKey(QUESTION_FAMILY, 'site');
const QUEUE_SECTION = 'judge_queue';
const NONE_ANSWERED = problem('Question coverage: no audited page answers a question of the fixed list', 'question-coverage.none-answered');
const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const verdictMode = new Map(registry.families.map(family => [family.family_id, family.verdict_mode]));
const naConditions = new Map(registry.families.map(family => [family.family_id, family.na_conditions ?? []]));
const SPACE = '[ \\t\\r\\n\\f]';
const LEADING = new RegExp(`^${SPACE}*`);
const TRAILING = new RegExp(`${SPACE}+$`);
// Text that is not shown to a reader: comments and script, style, template and noscript bodies.
const INERT = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
// An inert run is blanked to this character between its angle brackets, so it still reads as one tag and splits the text around it.
const BLANK = '\0';
const TAG_OPENER = /[A-Za-z/!?\0]/;
// Short text that is still worth offering: a date or a way to reach the owner. The floor in limits.json does not drop these.
const SHORT_TEXT_EXCEPTIONS = [
  /\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}/u,
  /\d{4}\s*년\s*\d{1,2}\s*월/u,
  /\d{1,2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{4}/u,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/iu,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}/iu,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u,
  /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{4}/u,
  /\b1[568]\d{2}[-\s]\d{4}\b/u,
];

/** The families a model may judge: per-page families that have no code check block. Code-judged families are read from the block list. */
function modelFamilies() {
  return registry.families.filter(family => family.unit_scope === 'url' && !isCodeJudged(family.family_id)).map(family => family.family_id);
}

/** Whether a family is one the model judges through the judge queue (a per-page family with no code check block). */
export const isModelJudged = family_id => modelFamilies().includes(family_id);

/** Whether a family has a code check block, so only code may judge it. */
export const isCodeJudged = family_id => blocks.some(block => block.family_id === family_id);

/** The one code-judged unit a model may judge: the site's identity, when code produced no verdict for it. */
export const isEntityFallback = (family_id, unit_key) => family_id === ENTITY_FAMILY && unit_key === ENTITY_UNIT;

/** The home page among fetched pages: the one at the root of the site, else the first. Queue building and report replay both choose it. */
export const homeOf = urls => urls.find(url => new URL(url).pathname === '/') ?? urls[0] ?? null;

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

/** The index after the `>` that ends the tag opening at `from`. A quote opens only after `=`, so a `>` inside an attribute value does not end it. */
function tagEnd(text, from) {
  let quote = null;
  let before = '';
  for (let index = from + 1; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; }
    else if ((char === '"' || char === "'") && before === '=') quote = char;
    else if (char === '>') return index + 1;
    if (!quote && !/\s/.test(char)) before = char;
  }
  // A quote that never closed is not trusted: the tag ends at its first `>`.
  const first = text.indexOf('>', from);
  return first < 0 ? text.length : first + 1;
}

/** The `[start, end)` ranges of `masked` that lie between tags. */
function textRuns(masked) {
  const runs = [];
  let from = 0;
  let index = 0;
  while (index < masked.length) {
    if (masked[index] === '<' && TAG_OPENER.test(masked[index + 1] ?? '')) {
      if (index > from) runs.push([from, index]);
      index = tagEnd(masked, index);
      from = index;
    } else index++;
  }
  if (masked.length > from) runs.push([from, masked.length]);
  return runs;
}

/**
 * Candidate spans of one HTML body: each run of text between tags, trimmed of ASCII whitespace, as UTF-8 byte offsets. Text inside a
 * tag (attribute values) and inside script and style is never offered. The body is scanned as bytes (latin1), so offsets are byte
 * offsets and a run can only start or end next to an ASCII character, never inside a multi-byte one. A run shorter than the floor is
 * dropped unless it is a date or a contact. Runs with a secret are dropped; the longest runs are kept, in document order.
 */
export function candidateSpans(bytes, evidence_sha256) {
  const { judge_spans_per_unit: cap, judge_span_min_bytes: minimum } = limits();
  const masked = bytes.toString('latin1').replace(INERT, found => `<${BLANK.repeat(found.length - 2)}>`);
  const spans = [];
  for (const [from, to] of textRuns(masked)) {
    const run = masked.slice(from, to);
    const start = from + LEADING.exec(run)[0].length;
    const end = from + run.replace(TRAILING, '').length;
    if (end <= start) continue;
    const text = bytes.subarray(start, end).toString('utf8');
    if (end - start < minimum && !SHORT_TEXT_EXCEPTIONS.some(pattern => pattern.test(text))) continue;
    if (!sensitive.test(text)) spans.push({ span_id: `${start}-${end}`, evidence_sha256, start, end, text });
  }
  return spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start).slice(0, cap).sort((a, b) => a.start - b.start);
}

/**
 * The model's work list: for every page that was fetched and every model-judged family with no verdict yet, the page's
 * candidate spans. Evidence is read through the store, so a body that no longer matches its recorded hash fails here.
 * With the run's `context`, only the families the run plans are offered. When code gave no verdict on the site's identity, the
 * home page also carries that site unit, with the names the start answers confirmed (`names`) and the host.
 * Returns `{ items: [{ family_id, unit_key, url, evidence_ref, evidence_sha256, spans }] }` and stores it in the run evidence
 * (kind `judge-queue`, listed with its hash in the index section `judge_queue`); mergeJudgments and report replay read that copy.
 */
export async function buildJudgeQueue({ observations, store, context = null, names = [] }) {
  const index = await store.index();
  const { raw } = index;
  // Raw bodies are named by their hash, so pages with identical bytes share one evidence file; a raw entry is told apart by its address too.
  const recorded = new Map(raw.filter(entry => entry.content_hash).map(entry => [JSON.stringify([entry.evidence_ref, entry.normalized_url]), entry]));
  const judged = new Set(observations.filter(observation => observation.state !== 'unknown').map(observation => observation.unit_key));
  // A page is the address its fetch-response verdict names, whatever other address answered with the same bytes.
  const pages = new Map();
  for (const observation of observations) {
    if (observation.family_id !== FETCH_FAMILY || observation.state !== 'pass') continue;
    const url = observation.unit_key.split('|').at(-1);
    const entry = recorded.get(JSON.stringify([observation.evidence_ref, url]));
    if (entry && !pages.has(url)) pages.set(url, entry);
  }
  const planned = context ? new Set(context.protocol.families.filter(family => family.applicable).map(family => family.family_id)) : null;
  const offered = family_id => !planned || planned.has(family_id);
  const families = modelFamilies().filter(offered);
  const items = [];
  const queue = { items };
  const spansOf = new Map();
  for (const [url, entry] of pages) {
    const spans = candidateSpans(await store.read(entry.evidence_ref, entry.content_hash), entry.content_hash);
    spansOf.set(url, spans);
    if (!spans.length) continue;
    for (const family_id of families) {
      const unit_key = unitKey(family_id, url);
      if (!judged.has(unit_key)) items.push({ family_id, unit_key, url, evidence_ref: entry.evidence_ref, evidence_sha256: entry.content_hash, spans });
    }
  }
  const home = homeOf([...pages.keys()]);
  if (home && spansOf.get(home).length && offered(ENTITY_FAMILY) && !judged.has(ENTITY_UNIT)) {
    const entry = pages.get(home);
    items.push({ family_id: ENTITY_FAMILY, unit_key: ENTITY_UNIT, url: home, evidence_ref: entry.evidence_ref, evidence_sha256: entry.content_hash,
      spans: spansOf.get(home), identity: { names, host: new URL(home).host } });
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
 * range that covers them. Code-judged families are never overwritten (the site's identity is the one exception, and only when the
 * queue offered it because code gave no verdict), a unit that already has a verdict is refused, and an `unknown` placeholder is
 * replaced. A `not_applicable` judgment needs one of the family's registry conditions and cites spans; it is recorded with that
 * condition as its applicability decision. An answer-clarity verdict other than unknown names the panel question it answers
 * (`question_id`, one of `questions`) and keeps it in its measurement.
 */
export async function mergeJudgments({ observations, judgments, store, questions = [] }) {
  const queue = await storedQueue(store);
  const items = new Map(queue.items.map(item => [item.unit_key, item]));
  const questionIds = new Set(questions.map(question => question.id));
  const made = [];
  for (const judgment of judgments) {
    const { family_id, unit_key, state } = judgment;
    const site = isEntityFallback(family_id, unit_key);
    if (isCodeJudged(family_id) && !site) throw new Error(`${family_id} is judged by code; a model judgment cannot overwrite it`);
    const item = items.get(unit_key);
    if (!item || item.family_id !== family_id) throw new Error(`no queued unit for ${family_id} ${unit_key}`);
    if (made.some(observation => observation.unit_key === unit_key)) throw new Error(`more than one judgment for ${unit_key}`);
    if (observations.some(observation => observation.unit_key === unit_key && observation.state !== 'unknown'))
      throw new Error(`${unit_key} already has a verdict`);
    if (sensitive.test(judgment.reason ?? '')) throw new Error(`judgment reason for ${unit_key} contains a secret`);
    const extra = { evaluator_type: MODEL_EVALUATOR, source_ref: OBSERVATION_SOURCES[MODEL_EVALUATOR] };
    if (state === 'not_applicable') {
      if (site) throw new Error(`${unit_key} is a site unit and cannot be not_applicable`);
      if (!naConditions.get(family_id).includes(judgment.condition))
        throw new Error(`a not_applicable judgment for ${unit_key} needs a condition of the family (${naConditions.get(family_id).join(', ')})`);
    }
    if (family_id === ANSWER_FAMILY && ['pass', 'partial', 'fail'].includes(state)) {
      if (!questionIds.has(judgment.question_id)) throw new Error(`an answer-clarity judgment for ${unit_key} needs question_id from the question list`);
      extra.measurement = { question_id: judgment.question_id };
    }
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
    if (state === 'not_applicable') extra.applicability_decision = { condition: judgment.condition, reason: judgment.reason, evidence_ref: item.evidence_ref };
    const partial = state === 'partial' ? partialBasis(judgment) : { basis: null, q: undefined };
    // A q the model supplies is ignored: the state fixes it (pass 1, fail 0, unknown and not applicable none) and a partial takes the basis's q.
    made.push(makeObservation({ family_id, unit_key, state, q: partial.q, reason: judgment.reason,
      evidence_ref: item.evidence_ref, partial_basis: partial.basis, extra }));
  }
  const replaced = new Set(made.map(observation => observation.unit_key));
  return [...observations.filter(observation => !replaced.has(observation.unit_key)), ...made];
}

/**
 * The observations with the question coverage of the fixed panel: the questions an audited page answers (an answer-clarity
 * verdict of pass or partial naming the question), each counted once however many pages answer it, over the panel's length. It
 * exists once the model has judged at least one page against a question; before that the unit stays unknown. Computed by code, not
 * judged: report replay computes it again from the answers, so a figure that does not follow from them is refused. `evidence_ref`
 * is the run context, which holds the panel.
 */
export function deriveQuestionCoverage({ observations, panel, evidence_ref }) {
  const others = observations.filter(observation => !(observation.unit_key === QUESTION_UNIT && (observation.state === 'unknown' || observation.source_ref === OBSERVATION_SOURCES.derived)));
  const judged = others.filter(observation => observation.family_id === ANSWER_FAMILY && observation.evaluator_type === MODEL_EVALUATOR &&
    ['pass', 'partial', 'fail'].includes(observation.state));
  if (!judged.length || !panel.length || others.some(observation => observation.unit_key === QUESTION_UNIT)) return others;
  const answeredBy = new Map(panel.map(question => [question.id, []]));
  for (const observation of judged) if (observation.state !== 'fail') answeredBy.get(observation.measurement?.question_id)?.push(observation.unit_key);
  const answered = [...answeredBy.values()].filter(units => units.length).length;
  const total = panel.length;
  const state = answered === 0 ? 'fail' : answered === total ? 'pass' : 'partial';
  const measurement = { answered, questions: total, list: panel.map(question => ({ question_id: question.id, answered_by: answeredBy.get(question.id) })) };
  const extra = { measurement, evaluator_type: 'code', source_ref: OBSERVATION_SOURCES.derived };
  const verdict = state === 'fail' ? { problems: [NONE_ANSWERED] } : { reason: 'Panel questions answered by an audited page, each counted once' };
  return [...others, makeObservation({ family_id: QUESTION_FAMILY, unit_key: QUESTION_UNIT, state, q: state === 'partial' ? answered / total : undefined,
    partial_basis: state === 'partial' ? { kind: 'ratio', numerator: answered, denominator: total } : null, evidence_ref, extra, ...verdict })];
}
