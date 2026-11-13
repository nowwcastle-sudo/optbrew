import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeJudgments } from './judgments.mjs';
import { assertCurrentEvidence } from './migration.mjs';

const PAGE_FILE = /^p\d{3,}\.json$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/**
 * Stops before anything is collected when the earlier run folder cannot supply judgments for this run: it must be a run folder of
 * this release, made from the same questions and confirmed facts (a judgment answers one question of the list and rests on the facts).
 * `earlier` is `{ context, intake }`, the paths of the earlier run's `context.json` and `intake.json`.
 */
export async function assertReusable({ context, intake }, answers) {
  const earlierContext = await readJson(context);
  const earlierIntake = await readJson(intake);
  if (!earlierContext || !earlierIntake) throw new Error(`There is no earlier audit to take judgments from: ${path.dirname(context)}`);
  assertCurrentEvidence(earlierContext, 'earlier run folder');
  if (!same(earlierIntake.answers?.questions, answers.questions) || !same(earlierIntake.answers?.facts, answers.facts))
    throw new Error('The earlier audit was made from other questions or facts, so its judgments cannot be reused; run again without --reuse-judgments.');
}

/** The earlier run's judgments by unit, each with the evidence hash and identity data of the page it was written for. */
async function earlierJudgments({ queue, judgments }) {
  const earlier = new Map();
  for (const name of (await readdir(queue).catch(() => [])).filter(file => PAGE_FILE.test(file))) {
    const page = await readJson(path.join(queue, name));
    const list = await readJson(path.join(judgments, name));
    if (!page || !Array.isArray(list)) continue;
    for (const judgment of list) {
      const family = page.families?.find(item => item.unit_key === judgment?.unit_key);
      if (family) earlier.set(judgment.unit_key, { judgment, evidence_sha256: page.evidence_sha256, identity: family.identity });
    }
  }
  return earlier;
}

/** The earlier judgments of every unit on a page whose bytes (and identity facts) are unchanged; null unless the page is covered whole. */
function coveredPage(page, earlier) {
  const list = [];
  for (const family of page.families) {
    const found = earlier.get(family.unit_key);
    if (!found || found.evidence_sha256 !== page.evidence_sha256 || !same(found.identity, family.identity)) return null;
    list.push(found.judgment);
  }
  return list;
}

/** Whether `mergeJudgments` still accepts a page's judgments against this run's queue and keeps each state (a citation that no longer holds turns into unknown). */
async function stillHolds(list, check) {
  try {
    const merged = await mergeJudgments({ ...check, judgments: list });
    return list.every(judgment => merged.find(observation => observation.unit_key === judgment.unit_key)?.state === judgment.state);
  } catch { return false; }
}

/**
 * Copies the earlier run's judgments for the pages whose evidence hash is unchanged into `into` (this run's `judgments/` folder),
 * as the page files `judge next` would otherwise ask the model to write. Each page is first merged again by `mergeJudgments`
 * against this run's stored queue and evidence; a page that fails is left for the model to judge afresh. `pages` is
 * `[file name, queue page]` in queue order. Nothing is copied into a folder that already holds page files. Answers `null` when
 * nothing was reused, else `{ judgments, complete, from_run_id }` where `complete` says every page was reused.
 */
export async function reuseJudgments({ earlier, pages, into, observations, store, questions }) {
  if ((await readdir(into).catch(() => [])).some(name => PAGE_FILE.test(name))) return null;
  const found = await earlierJudgments(earlier);
  const reused = [];
  for (const [name, page] of pages) {
    const list = coveredPage(page, found);
    if (list && await stillHolds(list, { observations, store, questions })) reused.push([name, list]);
  }
  if (!reused.length) return null;
  await mkdir(into, { recursive: true });
  for (const [name, list] of reused) await writeFile(path.join(into, name), `${JSON.stringify(list, null, 2)}\n`, { flag: 'wx' });
  return { judgments: reused.flatMap(([, list]) => list), complete: reused.length === pages.length, from_run_id: (await readJson(earlier.context)).run_id };
}

/** How many of the judgments reused at the first call are still, unchanged, among the judgments the run merged. */
export function reusedCount(recorded, judgments) {
  const merged = new Set((judgments ?? []).map(judgment => JSON.stringify(judgment)));
  return (recorded?.judgments ?? []).filter(judgment => merged.has(JSON.stringify(judgment))).length;
}
