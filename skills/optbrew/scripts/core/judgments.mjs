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
/** What the model's identity verdict rests on, by state (recorded in its measurement; report replay checks it): the name with another fact, the name alone, or no matching name. */
const IDENTITY_BASIS = { pass: 'name_and_fact', partial: 'name_only', fail: 'no_matching_name' };
const NONE_ANSWERED = problem('Question coverage: no audited page answers a question of the fixed list', 'question-coverage.none-answered');
const registry = JSON.parse(readFileSync(new URL('../../references/check-registry.json', import.meta.url)));
const verdictMode = new Map(registry.families.map(family => [family.family_id, family.verdict_mode]));
const naConditions = new Map(registry.families.map(family => [family.family_id, family.na_conditions ?? []]));
// The not_applicable conditions that mean "the page has no X", and the families whose fail may rest on something missing from the page.
const absenceConditions = new Map(registry.families.map(family => [family.family_id, new Set(family.na_absence_conditions ?? [])]));
const absenceFamilies = new Set(registry.families.filter(family => family.absence_fail).map(family => family.family_id));
/** What a model marks (`basis`) on every fail of an absence family: the fail rests on something missing from the page, or on something the cited text shows. */
const ABSENCE_BASIS = 'absence';
const SHOWN_BASIS = 'shown';
/** Why a verdict that rests on absence becomes unknown when the queue offered too little of the page. */
const ABSENCE_UNCOVERED = 'queue covers too little of the page to declare absence';
const CHROME_ONLY = 'the cited spans are all site chrome, not the page\'s own text';
const NO_TEXT_REASON = 'page shows no text';
const DATE_OUTSIDE = 'a date is visible outside the queued spans';
const DATE_INSIDE = 'a date is visible in the queued spans';
const OPERATOR_OUTSIDE = 'the operator is named outside the queued spans';
const OPERATOR_INSIDE = 'the operator is named in the queued spans';
const FRESHNESS_FAMILY = 'freshness-truth';
const SOURCE_FAMILY = 'source-transparency';
const COPYRIGHT = /©|\(c\)|copyright/i;
// A line that credits someone. The host label (a product's own name, as in "htmx") names an operator only on such a line.
const CREDIT = /©|\(c\)|copyright|\b(?:published|operated|maintained|created|made|written|run|owned)\s+by\b|운영|제공|발행|저작권|문의/i;
const SPACE = '[ \\t\\r\\n\\f]';
const LEADING = new RegExp(`^${SPACE}*`);
const TRAILING = new RegExp(`${SPACE}+$`);
// Text that is not shown to a reader: comments and script, style, template and noscript bodies.
const INERT = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
// An inert run is blanked to this character between its angle brackets, so it still reads as one tag and splits the text around it.
const BLANK = '\0';
const TAG_OPENER = /[A-Za-z/!?\0]/;
// A hyphenated name (a custom element) is one name, so `b-card` is not the inline tag `b`.
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;
const SENTENCE_END = /[.!?。！？]+["'”’」)\]]*(?=\s|$)/gu;
const SENTENCE_TAIL = /[.!?。！？]+["'”’」)\]]*\s*$/u;
// Tags inside a line of text: they do not end a span, and the text shown to the model has them taken out.
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'mark', 'small', 'span', 'strong', 'sub', 'sup', 'time']);
// A date form is a pattern plus a check of its parts: digits stand alone (no digit right before or after, so a business number such as
// 142-80-39228 or a phone number is not read as a date), the year is 1990-2099, the month 1-12 and the day 1-31.
const YEAR = value => value >= 1990 && value <= 2099;
const MONTH = value => value >= 1 && value <= 12;
const DAY = value => value >= 1 && value <= 31;
// A full date names a day, a month and a year. A long line that holds one is kept ahead of other long lines when the cap is full.
const FULL_DATE_FORMS = [
  { re: /(?<!\d)(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?!\d)/gu, ok: (y, m, d) => YEAR(+y) && MONTH(+m) && DAY(+d) },
  { re: /(?<!\d)(\d{4})\s+(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, ok: (y, m, d) => YEAR(+y) && MONTH(+m) && DAY(+d) },
  { re: /(?<!\d)(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})(?!\d)/gu, ok: (a, b, y) => YEAR(+y) && (MONTH(+a) && DAY(+b) || MONTH(+b) && DAY(+a)) },
  { re: /(?<!\w)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/giu, ok: (_, d, y) => DAY(+d) && YEAR(+y) },
  { re: /(?<!\d)(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})(?!\d)/giu, ok: (d, _, y) => DAY(+d) && YEAR(+y) },
];
// A year and month, offered when short.
const YEAR_MONTH_FORMS = [
  { re: /(?<!\d)(\d{4})\s*년\s*(\d{1,2})\s*월/gu, ok: (y, m) => YEAR(+y) && MONTH(+m) },
];
// Any text that shows a date, a month or a day of a month: a page that has one is not "without a visible date". Broad, but each form checks its parts.
const BROAD_DATE_FORMS = [
  ...FULL_DATE_FORMS,
  ...YEAR_MONTH_FORMS,
  { re: /(?<!\d)(\d{4})\s+(\d{1,2})\s*월/gu, ok: (y, m) => YEAR(+y) && MONTH(+m) },
  { re: /(?<![\d./-])(\d{4})\s*[-./]\s*(\d{1,2})(?![\d./-])/gu, ok: (y, m) => YEAR(+y) && MONTH(+m) },
  { re: /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, ok: (m, d) => MONTH(+m) && DAY(+d) },
  { re: /(?<!\w)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?!\d)/gu, ok: (_, d) => DAY(+d) },
  { re: /(?<!\w)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})(?!\d)/gu, ok: (_, y) => YEAR(+y) },
];
const hasDate = (text, forms) => forms.some(({ re, ok }) => [...text.matchAll(re)].some(found => ok(...found.slice(1))));
// Short text that is still worth offering: a full date or a year and month, a way to reach the owner (and, by element, an author line in <address>). The floor in limits.json does not drop these.
const CONTACT_PATTERNS = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u,
  /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{4}/u,
  /\b1[568]\d{2}[-\s]\d{4}\b/u,
];
const isShortException = text => hasDate(text, [...FULL_DATE_FORMS, ...YEAR_MONTH_FORMS]) || CONTACT_PATTERNS.some(pattern => pattern.test(text));
const ADDRESS_ELEMENT = /<address\b[^>]*>([\s\S]*?)<\/address\s*>/gi;
const BODY_ELEMENT = /<body(?=[\s>/])[^>]*>([\s\S]*)/i;
const HEAD_ELEMENT = /<head(?=[\s>/])[\s\S]*?<\/head\s*>/i;
// What is left of an element once its tags and blank entities are gone.
const NO_TEXT = /^(?:\s|&nbsp;|&#160;|&#xa0;)*$/i;

/** The families a model may judge: per-page families that have no code check block. Code-judged families are read from the block list. */
function modelFamilies() {
  return registry.families.filter(family => family.unit_scope === 'url' && !isCodeJudged(family.family_id)).map(family => family.family_id);
}

/** Whether a family is one the model judges through the judge queue (a per-page family with no code check block). */
export const isModelJudged = family_id => modelFamilies().includes(family_id);

/** Whether a family has a code check block, so only code may judge it. */
export const isCodeJudged = family_id => blocks.some(block => block.family_id === family_id);

/**
 * Whether a judgment's `basis` is allowed: a fail of an absence family names `absence` (it rests on something missing from the page)
 * or `shown` (the cited text shows it); every other verdict names none.
 */
export const basisAllowed = ({ family_id, state, basis }) =>
  state === 'fail' && absenceFamilies.has(family_id) ? basis === ABSENCE_BASIS || basis === SHOWN_BASIS : basis === undefined;

/** Whether a judgment rests on something being absent from the page: a not_applicable under an absence condition, or a fail marked with the absence basis in a family that allows it. */
const restsOnAbsence = ({ family_id, state, condition, basis }) =>
  state === 'not_applicable' ? absenceConditions.get(family_id)?.has(condition) === true : state === 'fail' && basis === ABSENCE_BASIS && absenceFamilies.has(family_id);

/** The basis the model's identity verdict must record for its state. */
export const identityBasisOf = state => IDENTITY_BASIS[state];

/** The one code-judged unit a model may judge: the site's identity, when code produced no verdict for it. */
export const isEntityFallback = (family_id, unit_key) => family_id === ENTITY_FAMILY && unit_key === ENTITY_UNIT;

/**
 * The home page among fetched pages: a page at the root of the site, else the page with the shortest path; ties go to the smaller address,
 * so the choice does not depend on the order the pages were fetched in. Queue building and report replay both choose it.
 */
export const homeOf = urls => {
  const keyed = urls.map(url => ({ url, path: new URL(url).pathname }));
  keyed.sort((a, b) => (a.path === '/' ? 0 : 1) - (b.path === '/' ? 0 : 1) || a.path.length - b.path.length || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return keyed[0]?.url ?? null;
};

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

/** The ranges of `[from, to)` that lie outside every tag. */
function piecesOf(masked, from, to) {
  const pieces = [];
  let index = from;
  let piece = from;
  while (index < to) {
    if (masked[index] === '<' && TAG_OPENER.test(masked[index + 1] ?? '')) {
      if (index > piece) pieces.push([piece, index]);
      index = Math.min(tagEnd(masked, index), to);
      piece = index;
    } else index++;
  }
  if (to > piece) pieces.push([piece, to]);
  return pieces;
}

/** The `[start, end)` ranges of `masked` that lie between tags that break a line of text; an inline tag (a, code, em, ...) does not break it. */
function textRuns(masked) {
  const runs = [];
  let from = 0;
  let index = 0;
  while (index < masked.length) {
    if (masked[index] === '<' && TAG_OPENER.test(masked[index + 1] ?? '')) {
      const name = TAG_NAME.exec(masked.slice(index, index + 24))?.[1].toLowerCase();
      const end = tagEnd(masked, index);
      if (!INLINE_TAGS.has(name)) {
        if (index > from) runs.push([from, index]);
        from = end;
      }
      index = end;
    } else index++;
  }
  if (masked.length > from) runs.push([from, masked.length]);
  return runs;
}

/** What joins two pieces of a run: a space where a line break lies between them or one element ends and the next begins; nothing where a single tag does (a word and its particle). */
const joinerOf = gap => /<br\b/i.test(gap) || /<\/[^>]*>\s*<[A-Za-z]/.test(gap) ? ' ' : '';

/**
 * The text of a run: its pieces outside tags, with leading and trailing ASCII whitespace taken off the whole. Returns the byte range
 * from the first to the last text byte (inline tags in between lie inside it) and the text those pieces hold, tags left out.
 */
function trimmedRun(masked, bytes, from, to) {
  const pieces = piecesOf(masked, from, to);
  while (pieces.length) {
    const [start, end] = pieces[0];
    const lead = LEADING.exec(masked.slice(start, end))[0].length;
    if (start + lead >= end) pieces.shift(); else { pieces[0] = [start + lead, end]; break; }
  }
  while (pieces.length) {
    const [start, end] = pieces.at(-1);
    const trail = masked.slice(start, end).length - masked.slice(start, end).replace(TRAILING, '').length;
    if (end - trail <= start) pieces.pop(); else { pieces[pieces.length - 1] = [start, end - trail]; break; }
  }
  if (!pieces.length) return null;
  // Two words are not run together across a line break or the boundary of two elements.
  const text = pieces.map(([start, end], index) => (index ? joinerOf(masked.slice(pieces[index - 1][1], start)) : '') + bytes.subarray(start, end).toString('utf8')).join('');
  return { start: pieces[0][0], end: pieces.at(-1)[1], text, pieces };
}

/** The ranges of `text` (character indices) cut after each sentence end, and a sentence that is still longer than `max` bytes at its last space, else at a character. */
function sentenceRanges(text, max) {
  const cuts = [0, ...[...text.matchAll(SENTENCE_END)].map(found => found.index + found[0].length), text.length];
  const ranges = [];
  for (let i = 1; i < cuts.length; i++) {
    let from = cuts[i - 1];
    const to = cuts[i];
    if (to <= from) continue;
    while (Buffer.byteLength(text.slice(from, to)) > max) {
      let at = from;
      let used = 0;
      while (at < to) {
        const width = Buffer.byteLength(String.fromCodePoint(text.codePointAt(at)));
        if (used + width > max) break;
        used += width;
        at += text.codePointAt(at) > 0xFFFF ? 2 : 1;
      }
      const space = text.slice(from, at).search(/\s\S*$/);
      const cut = space > 0 ? from + space + 1 : at;
      ranges.push([from, cut]);
      from = cut;
    }
    ranges.push([from, to]);
  }
  return ranges;
}

/**
 * A run longer than `max` bytes as several runs of at most `max` bytes each. Its pieces are cut after sentence ends (and, for a
 * sentence still too long, at a space or a character); the cut pieces form units that end at a sentence end or a line break, and the
 * units are packed, in order, into the longest groups that fit (a unit longer than `max` is packed piece by piece). Each part is a byte
 * range from its first to its last text byte, with the text of that range as `trimmedRun` builds it.
 */
function splitRun(masked, bytes, pieces, max) {
  const units = [];
  let unit = [];
  pieces.forEach(([start, end], index) => {
    const text = bytes.subarray(start, end).toString('utf8');
    const before = index ? joinerOf(masked.slice(pieces[index - 1][1], start)) : '';
    const lineBreak = index + 1 < pieces.length && /<br\b/i.test(masked.slice(end, pieces[index + 1][0]));
    const ranges = sentenceRanges(text, max);
    ranges.forEach(([from, to], n) => {
      const atom = { start: start + Buffer.byteLength(text.slice(0, from)), end: start + Buffer.byteLength(text.slice(0, to)), text: text.slice(from, to), before: n ? '' : before };
      unit.push(atom);
      if (SENTENCE_TAIL.test(atom.text) || n + 1 === ranges.length && lineBreak) { units.push(unit); unit = []; }
    });
  });
  if (unit.length) units.push(unit);
  const items = units.flatMap(atoms => {
    const joined = { start: atoms[0].start, end: atoms.at(-1).end, before: atoms[0].before,
      text: atoms.map((atom, n) => (n ? atom.before : '') + atom.text).join('') };
    return Buffer.byteLength(joined.text) <= max ? [joined] : atoms;
  });
  const parts = [];
  let current = null;
  for (const item of items) {
    if (current && Buffer.byteLength(current.text + item.before + item.text) <= max) { current.text += item.before + item.text; current.end = item.end; }
    else { if (current) parts.push(current); current = { start: item.start, end: item.end, text: item.text }; }
  }
  if (current) parts.push(current);
  return parts.flatMap(part => {
    const lead = LEADING.exec(part.text)[0];
    const trail = TRAILING.exec(part.text)?.[0] ?? '';
    const text = part.text.slice(lead.length, part.text.length - trail.length);
    return text ? [{ start: part.start + Buffer.byteLength(lead), end: part.end - Buffer.byteLength(trail), text }] : [];
  });
}

/** The body as latin1 text with inert runs blanked, and the byte ranges of the text inside <address> elements. */
function maskedBody(bytes) {
  const masked = bytes.toString('latin1').replace(INERT, found => `<${BLANK.repeat(found.length - 2)}>`);
  const addresses = [...masked.matchAll(ADDRESS_ELEMENT)].map(found => { const from = found.index + found[0].indexOf('>') + 1; return [from, from + found[1].length]; });
  return { masked, addresses };
}

/** Every line of visible text of the body, as the spans are cut from it: byte range, text, and whether it stands inside an <address> element. */
function textLines(bytes) {
  const { judge_span_max_bytes: maximum } = limits();
  const { masked, addresses } = maskedBody(bytes);
  const lines = [];
  for (const [from, to] of textRuns(masked)) {
    const whole = trimmedRun(masked, bytes, from, to);
    if (!whole) continue;
    for (const run of Buffer.byteLength(whole.text) > maximum ? splitRun(masked, bytes, whole.pieces, maximum) : [whole])
      lines.push({ start: run.start, end: run.end, text: run.text, address: addresses.some(([first, last]) => run.start >= first && run.end <= last) });
  }
  return lines;
}

/**
 * Candidate spans of one HTML body: each line of text between tags that break a line, as UTF-8 byte offsets. An inline tag (a, code,
 * em, strong, ...) does not break the line: its span covers the tag, and its `text` is the text of the range with the tags left out.
 * Text inside a tag (attribute values) and inside script and style is never offered. The body is scanned as bytes (latin1), so
 * offsets are byte offsets and a span can only start or end next to an ASCII character, never inside a multi-byte one. A line shorter
 * than the floor is dropped unless it is a date, a contact or a line inside an <address> element; those (one of each text) have an
 * allowance of their own beside the cap. A line longer than the maximum is cut at sentence ends (or a space, or a character) into
 * several spans of at most that size. Lines with a secret are dropped; the longest lines are kept, in document order, but a long line
 * that holds a full date comes before the others when the cap is full.
 */
export function candidateSpans(bytes, evidence_sha256) {
  const { judge_spans_per_unit: cap, judge_span_min_bytes: minimum, judge_short_spans_per_unit: shortCap } = limits();
  const long = [];
  const short = new Map();
  for (const line of textLines(bytes)) {
    if (sensitive.test(line.text)) continue;
    const span = { span_id: `${line.start}-${line.end}`, evidence_sha256, start: line.start, end: line.end, text: line.text };
    const size = Buffer.byteLength(line.text);
    if (size >= minimum) long.push({ span, size, dated: hasDate(line.text, FULL_DATE_FORMS) });
    else if (!short.has(line.text) && (line.address || isShortException(line.text))) short.set(line.text, span);
  }
  const kept = long.sort((a, b) => b.dated - a.dated || b.size - a.size || a.span.start - b.span.start).slice(0, cap).map(x => x.span);
  return [...kept, ...[...short.values()].slice(0, shortCap)].sort((a, b) => a.start - b.start);
}

/** Whether the page shows no text: its <body> holds none or, with no <body>, nothing outside <head> does. Script, style and comments are not text. */
export function isEmptyPage(bytes) {
  const { masked } = maskedBody(bytes);
  const body = BODY_ELEMENT.exec(masked)?.[1] ?? masked.replace(HEAD_ELEMENT, '');
  return NO_TEXT.test(body.replace(/<[^>]*>/g, ''));
}

/**
 * The lines of text that repeat across most of the audited pages (menus, headers, footers): a line on more than `site_chrome.min_share`
 * of the pages, when at least `site_chrome.min_pages` pages were audited. They belong to the site, not to a page. Queue building and
 * report replay both derive the set from the pages' bytes.
 */
export function siteChrome(pages) {
  const { min_share: share, min_pages: minimum } = limits().site_chrome;
  const counts = new Map();
  if (pages.length < minimum) return new Set();
  for (const bytes of pages) for (const text of new Set(textLines(bytes).map(line => line.text))) counts.set(text, (counts.get(text) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n / pages.length > share).map(([text]) => text));
}

/**
 * Why an absence fail is not accepted although the queue covered the page: the page shows what the fail says is missing, in lines the
 * model may not have read. A date: any line with a date (menus and footers included). The operator: a line of the page's own text (not
 * site chrome) inside <address>, with a copyright mark, or naming one of `names`. Returns the reason, or null when the page shows nothing.
 * `spans` are the spans the queue offered, to tell a line the model could read from one it could not.
 */
function absenceRefuted(family_id, bytes, spans, { chrome, names, host }) {
  const inSpans = line => spans.some(span => span.start <= line.start && line.end <= span.end);
  const lines = textLines(bytes);
  if (family_id === FRESHNESS_FAMILY) {
    const hits = lines.filter(line => !chrome.has(line.text) && hasDate(line.text, BROAD_DATE_FORMS));
    return hits.length ? (hits.every(inSpans) ? DATE_INSIDE : DATE_OUTSIDE) : null;
  }
  if (family_id !== SOURCE_FAMILY) return null;
  const lowered = names.map(name => name.toLowerCase());
  const hits = lines.filter(line => !chrome.has(line.text) && (line.address || COPYRIGHT.test(line.text) || lowered.some(name => line.text.toLowerCase().includes(name)) ||
    host && CREDIT.test(line.text) && line.text.toLowerCase().includes(host)));
  return hits.length ? (hits.every(inSpans) ? OPERATOR_INSIDE : OPERATOR_OUTSIDE) : null;
}

/**
 * The names that tell a page names its operator, from every source the run has: the names the owner confirmed (`confirmed`) and the
 * organization name the code identity check found (JSON-LD) are `names`; the site's host label (`youthdc` of youthdc.com) is `host`
 * and counts only on a credit line. A name under two characters is not used.
 */
export function operatorNames({ confirmed = [], observations = [], url }) {
  const entity = observations.find(observation => observation.unit_key === ENTITY_UNIT && observation.evaluator_type === 'code')?.measurement?.name_reference;
  // A site unit has no address of its own, and an IP address has no name: no host label then.
  const hostname = URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, '') : '';
  const host = /^[\d.]+$|^\[/.test(hostname) ? null : hostname.split('.')[0];
  const usable = name => typeof name === 'string' && name.trim().length >= 2;
  return { names: [...new Set([...confirmed, entity].filter(usable).map(name => name.trim()))], host: usable(host) ? host.toLowerCase() : null };
}

/**
 * Whether a model verdict stands, from the page's bytes: null when it does, else `{ reason, code }` and the verdict becomes unknown.
 * A page that shows no text gets no verdict but unknown. A fail of an absence family, and a freshness pass, must cite some of the page's
 * own text (not only site chrome); a date that only site chrome shows is not the page showing a date. A verdict that rests on absence (an
 * absence N/A, an absence fail, and a freshness fail labelled shown on a page that shows no date, which is an absence fail in
 * disguise) needs a queue that covered the page; an absence fail also needs a page that does not show what it says is missing.
 * `cited` are the spans the verdict cites, `offered` all spans of the queue unit. Merge and report replay both call this.
 */
export function acceptance(verdict, bytes, cited, offered, { chrome, names, host }) {
  const { family_id, state } = verdict;
  if (state !== 'unknown' && isEmptyPage(bytes)) return { reason: NO_TEXT_REASON, code: 'empty_page' };
  const failOfAbsenceFamily = state === 'fail' && absenceFamilies.has(family_id);
  const freshnessPass = state === 'pass' && family_id === FRESHNESS_FAMILY;
  if ((failOfAbsenceFamily || freshnessPass) && cited.length && cited.every(span => chrome.has(span.text))) return { reason: CHROME_ONLY, code: 'chrome' };
  const disguised = failOfAbsenceFamily && verdict.basis === SHOWN_BASIS && family_id === FRESHNESS_FAMILY &&
    !textLines(bytes).some(line => !chrome.has(line.text) && hasDate(line.text, BROAD_DATE_FORMS));
  if (!restsOnAbsence(verdict) && !disguised) return null;
  if (!coversPage(bytes, offered)) return { reason: ABSENCE_UNCOVERED, code: 'queue_coverage' };
  const shown = failOfAbsenceFamily ? absenceRefuted(family_id, bytes, offered, { chrome, names, host }) : null;
  return shown ? { reason: shown, code: 'visible' } : null;
}

/**
 * Whether the queue's `spans` cover enough of the page to show that something is absent from it: the spans make up at least
 * `judge_absence_min_coverage` of the page's visible text (bytes of text). A page with no text never gets here (acceptance refuses it first).
 */
function coversPage(bytes, spans) {
  const total = textLines(bytes).reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
  return total === 0 || spans.reduce((sum, span) => sum + Buffer.byteLength(span.text), 0) / total >= limits().judge_absence_min_coverage;
}

/**
 * The model's work list: for every page that was fetched and every model-judged family with no verdict yet, the page's
 * candidate spans. Evidence is read through the store, so a body that no longer matches its recorded hash fails here.
 * With the run's `context`, only the families the run plans are offered. When code gave no verdict on the site's identity, the
 * home page also carries that site unit, with the names and the other facts the start answers confirmed (`names`, `facts`) and the host.
 * Returns `{ items: [{ family_id, unit_key, url, evidence_ref, evidence_sha256, spans }] }` and stores it in the run evidence
 * (kind `judge-queue`, listed with its hash in the index section `judge_queue`); mergeJudgments and report replay read that copy.
 */
export async function buildJudgeQueue({ observations, store, context = null, names = [], facts = [] }) {
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
  const loaded = new Map();
  for (const [url, entry] of pages) {
    const bytes = await store.read(entry.evidence_ref, entry.content_hash);
    loaded.set(url, { bytes, spans: candidateSpans(bytes, entry.content_hash), empty: isEmptyPage(bytes) });
  }
  // A line that most audited pages repeat is the site's, not the page's: the spans that hold one say so.
  const chrome = siteChrome([...loaded.values()].map(page => page.bytes));
  const spansOf = new Map();
  for (const [url, page] of loaded) spansOf.set(url, page.spans.map(span => chrome.has(span.text) ? { ...span, site_chrome: true } : span));
  for (const [url, entry] of pages) {
    const spans = spansOf.get(url);
    if (!spans.length) continue;
    const empty = loaded.get(url).empty ? { empty_page: true } : {};
    for (const family_id of families) {
      const unit_key = unitKey(family_id, url);
      if (!judged.has(unit_key)) items.push({ family_id, unit_key, url, evidence_ref: entry.evidence_ref, evidence_sha256: entry.content_hash, spans, ...empty });
    }
  }
  const home = homeOf([...pages.keys()]);
  if (home && spansOf.get(home).length && offered(ENTITY_FAMILY) && !judged.has(ENTITY_UNIT)) {
    const entry = pages.get(home);
    items.push({ family_id: ENTITY_FAMILY, unit_key: ENTITY_UNIT, url: home, evidence_ref: entry.evidence_ref, evidence_sha256: entry.content_hash,
      spans: spansOf.get(home), ...(loaded.get(home).empty ? { empty_page: true } : {}), identity: { names, facts, host: new URL(home).host } });
  }
  const emptyPages = [...loaded].filter(([, page]) => page.empty).map(([url]) => url);
  const queue = { items, ...(chrome.size ? { site_chrome: [...chrome].sort() } : {}), ...(emptyPages.length ? { empty_pages: emptyPages } : {}), ...(names.length ? { owner_names: names } : {}) };
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
  const confirmed = [...(queue.owner_names ?? []), ...(queue.items.find(item => item.identity)?.identity.names ?? [])];
  const chrome = new Set(queue.site_chrome ?? []);
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
    let evidence = null;
    if (state === 'fail' && absenceFamilies.has(family_id) && judgment.basis === undefined)
      throw new Error(`a fail of ${family_id} needs basis "absence" (something is missing from the page) or "shown" (the cited text shows it) (${unit_key})`);
    if (!basisAllowed(judgment))
      throw new Error(`basis "${judgment.basis}" is allowed only as "absence" or "shown" on a fail of ${[...absenceFamilies].join(' or ')} (${unit_key})`);
    if (state === 'not_applicable') {
      if (site) throw new Error(`${unit_key} is a site unit and cannot be not_applicable`);
      if (!naConditions.get(family_id).includes(judgment.condition))
        throw new Error(`a not_applicable judgment for ${unit_key} needs a condition of the family (${naConditions.get(family_id).join(', ')})`);
      // A question named means the page is meant to answer it: the verdict is pass, partial or fail. Not applicable is for a page no question is about.
      if (family_id === ANSWER_FAMILY && judgment.question_id !== undefined) throw new Error(`a not_applicable answer-clarity judgment for ${unit_key} names no question`);
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
      evidence = bytes;
      extra.evidence_span = spans.map(({ evidence_sha256, start, end }) => ({ evidence_sha256, start, end }));
      for (const part of extra.evidence_span) {
        if (part.evidence_sha256 !== item.evidence_sha256) throw new Error(`span of ${unit_key} is not from the unit's evidence`);
        checkSpan(bytes, part);
      }
    }
    // A verdict that rests on something missing from the page needs a queue that offered enough of it and a page that does not show it; otherwise it is unknown.
    const notAccepted = evidence && acceptance(judgment, evidence, extra.evidence_span.map(part => item.spans.find(span => span.start === part.start && span.end === part.end)), item.spans,
      { chrome, ...operatorNames({ confirmed, observations, url: item.url }) });
    if (notAccepted) {
      made.push(makeObservation({ family_id, unit_key, state: 'unknown', reason: notAccepted.reason, evidence_ref: item.evidence_ref,
        extra: { evaluator_type: MODEL_EVALUATOR, source_ref: extra.source_ref, measurement: { not_accepted: notAccepted.code } } }));
      continue;
    }
    if (state === 'fail' && absenceFamilies.has(family_id)) extra.measurement = { ...extra.measurement, basis: judgment.basis };
    if (site && state !== 'unknown') extra.measurement = { ...extra.measurement, identity_basis: IDENTITY_BASIS[state] };
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
