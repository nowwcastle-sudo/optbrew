import { readFileSync } from 'node:fs';

const levels = ['beginner', 'brief'];
const placeholder = '{{skill_root}}';
const dir = new URL('../../references/runbooks/', import.meta.url);

let cachedIndex;
const index = () => cachedIndex ??= JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const entryOf = id => index().find(entry => entry.id === id);
/** One index entry (`id`, `kind`, `when`, `fills`, `item`, and sometimes `line` and `expands_to`), or undefined. */
export const runbookEntry = entryOf;
/** The `harness:` value in a runbook's front matter. */
const harnessOf = id => parse(id, readFileSync(new URL(`${id}.md`, dir), 'utf8')).head.harness;

/** Split a runbook file into its front-matter fields and its `## <name>` sections. */
function parse(id, raw) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  if (!match) throw new Error(`runbook ${id}: front matter is missing`);
  const head = Object.fromEntries(match[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  const sections = Object.fromEntries(match[2].split(/^## /m).slice(1).map(part => {
    const newline = part.indexOf('\n');
    return [part.slice(0, newline).trim(), part.slice(newline + 1).trim()];
  }));
  return { head, sections };
}

/** One stored runbook at one guidance level; `{{skill_root}}` becomes the caller's skill folder, inserted as given. */
export function loadRunbook(id, level, { skillRoot } = {}) {
  const entry = entryOf(id);
  if (!entry) throw new Error(`unknown runbook: ${id}`);
  if (!levels.includes(level)) throw new Error(`runbook level must be one of ${levels.join(', ')}: ${level}`);
  const { head, sections } = parse(id, readFileSync(new URL(`${id}.md`, dir), 'utf8'));
  const body = sections[level];
  if (!body) throw new Error(`runbook ${id} has no ${level} section`);
  if (body.includes(placeholder) && !skillRoot) throw new Error(`runbook ${id} needs skillRoot`);
  return { id, kind: entry.kind, text: body.replaceAll(placeholder, () => skillRoot), checked: head.checked, source: head.source, harness: head.harness };
}

/** What the start probe says is missing. Owner exports cannot be probed, so they always count as missing. */
const missingOf = probe => new Set([!probe.google_key && 'google_key', !probe.chrome?.found && 'chrome', 'owner_export'].filter(Boolean));

const matchesStart = (when, probe, missing) =>
  (when.block_reason !== undefined && when.block_reason === probe.block_reason) || (when.missing !== undefined && missing.has(when.missing));

/**
 * The runbooks to show before the audit starts. A blocking runbook (at most one) comes whole at the chosen level;
 * an improving one comes as its single line with its `harness`. An entry with no `block_reason` or `missing` is never shown here.
 * `harnesses`, when given, lists the runbook `harness` values that apply; others are dropped before the one-blocking cap.
 */
export function startRunbooks(probe, { level, skillRoot, harnesses = null }) {
  const missing = missingOf(probe);
  const hits = index().filter(entry => matchesStart(entry.when, probe, missing))
    .map(entry => ({ ...entry, harness: harnessOf(entry.id) })).filter(entry => !harnesses || harnesses.includes(entry.harness));
  const blocking = hits.filter(entry => entry.kind === 'blocking').slice(0, 1).map(entry => loadRunbook(entry.id, level, { skillRoot }));
  const improving = hits.filter(entry => entry.kind === 'improving').map(({ id, line, harness }) => ({ id, line, harness }));
  return { blocking, improving };
}

/** The runbooks that answering one start item opens: its `expands_to` list in order, else the item itself. */
export function answeredRunbooks(id, { level, skillRoot }) {
  const entry = entryOf(id);
  if (!entry) throw new Error(`unknown runbook: ${id}`);
  return (entry.expands_to ?? [id]).map(runbookId => loadRunbook(runbookId, level, { skillRoot }));
}

/** Runbook ids for the `unknown` observations whose reason a runbook can fix, in index order, each once. */
export function remainingRunbooks(observations) {
  const reasons = new Set(observations.filter(observation => observation.state === 'unknown').map(observation => observation.reason));
  return index().filter(entry => reasons.has(entry.when.unknown_reason)).map(entry => entry.id);
}
