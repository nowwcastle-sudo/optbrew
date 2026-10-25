import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const PAGE_FILE = /^p\d{3,}\.json$/;
// A reason that is only a stand-in: what a long write-out shrinks the tail to ("…", "same as above", "TODO").
const PLACEHOLDER = /^\s*(?:…+|\.{2,}|todo|tbd|placeholder|자리\s*표시|생략|나머지(?:\s*(?:동일|같음|생략))?|(?:위와\s*)?(?:동일|같음)|same(?:\s+as\s+above)?|etc\.?)\s*$/i;
const FIELDS = ['family_id', 'unit_key', 'state', 'reason'];

/** Why one entry of a judgments file is a stand-in rather than a judgment, or null when it is a real one. */
function placeholderOf(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'it is not a judgment object';
  const missing = FIELDS.find(field => typeof entry[field] !== 'string' || !entry[field].trim());
  if (missing) return `its ${missing} is missing or empty`;
  const filler = FIELDS.find(field => PLACEHOLDER.test(entry[field]));
  return filler ? `its ${filler} is "${entry[filler].trim()}"` : null;
}

/** One file's bare JSON array, every entry checked for stand-ins; the error names the file and the entry's position (from 1). */
async function readList(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`The judgments file cannot be read as JSON: ${file}`); }
  if (!Array.isArray(value)) throw new Error(`The judgments file must hold one JSON array of judgments: ${file}`);
  value.forEach((entry, index) => {
    const why = placeholderOf(entry);
    if (why) throw new Error(`Judgment ${index + 1} in ${path.basename(file)} looks like a placeholder (${why}); write the full judgment.`);
  });
  return value;
}

/**
 * The one page file to judge next: the first queued page, in number order, whose judgments file is not written yet. Each page that
 * comes before it is checked as `readJudgments` checks it, so a stand-in stops here and not at the end. The page is handed over whole,
 * one at a time, so the agent judges and writes a page before it can read the next one. `null` when every queued page has its file.
 */
export async function nextJudgePage({ queueDir, judgmentsDir }) {
  const listed = await readdir(queueDir).catch(() => { throw new Error(`There is no judge queue at ${queueDir}; run the audit (step 7) first.`); });
  const queued = listed.filter(name => PAGE_FILE.test(name)).sort();
  const written = new Set((await readdir(judgmentsDir).catch(() => [])).filter(name => PAGE_FILE.test(name)));
  const next = queued.find(name => !written.has(name));
  for (const name of queued.filter(name => written.has(name))) await readList(path.join(judgmentsDir, name));
  if (!next) return { status: 'all_judged', total: queued.length };
  const page = JSON.parse(await readFile(path.join(queueDir, next), 'utf8'));
  return { status: 'next', file: next, position: queued.indexOf(next) + 1, total: queued.length, write_to: path.join(judgmentsDir, next), page };
}

/**
 * The model's judgments from one file, or from a folder of page files (`p001.json` …, one per page file of the queue in
 * `queueDir`). A folder must hold a file for every queued page, so a page left out stops the run before anything is merged.
 */
export async function readJudgments(target, { queueDir }) {
  if (!(await stat(target).catch(() => null))?.isDirectory()) return readList(target);
  const written = new Set((await readdir(target)).filter(name => PAGE_FILE.test(name)));
  const queued = (await readdir(queueDir).catch(() => [])).filter(name => PAGE_FILE.test(name)).sort();
  const missing = queued.filter(name => !written.has(name));
  if (missing.length) throw new Error(`The judgments are missing for page ${missing.join(', ')}; judge those pages and write their files (an empty array for a page with nothing to judge).`);
  const lists = [];
  for (const name of [...written].sort()) lists.push(await readList(path.join(target, name)));
  return lists.flat();
}
