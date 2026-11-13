// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { nextJudgePage } from '../skills/optbrew/scripts/core/judgment-files.mjs';
import { answersFor, brewPage, brewPages, memorySite, passJudgments, preflightOf, queuedUnits, quietEnv, readQueue, SITE, workspace } from './support/run-scenario.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const pageFile = index => `p${String(index + 1).padStart(3, '0')}.json`;

/** A first call on the in-memory site, from a workspace of its own (the same answers every time). */
async function firstCall({ pages = brewPages(), reusePath = null, answers = answersFor(`${SITE}/`) } = {}) {
  const site = memorySite(pages);
  const ws = await workspace(answers);
  await preflightOf(site, `${SITE}/`, ws.out);
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath: ws.answersPath, out: ws.out, reusePath }, overrides);
  return { site, ws, overrides, first };
}

/** Writes one judgments file per queued page into `<out>/judgments` as the agent does (`change` edits a page's list), then finishes the run. */
async function judgeAll(call, change = list => list) {
  const queue = await readQueue(call.first);
  const folder = path.join(call.ws.out, 'judgments');
  await mkdir(folder, { recursive: true });
  for (const [index, page] of queue.pages.entries())
    await writeFile(path.join(folder, pageFile(index)), JSON.stringify(change(passJudgments({ ...queue, pages: [page] }), index)));
  return run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath: folder }, call.overrides);
}

const scoresOf = async out => score(await readJson(path.join(out, 'score-input.json')));

/** The judgment of the first unit of a page file is given up, as a model may on one run and not on the next. */
const giveUpFirst = list => list.map((judgment, index) => index === 0 ? { family_id: judgment.family_id, unit_key: judgment.unit_key, state: 'unknown', reason: 'The model could not decide' } : judgment);

test('the same evidence judged twice can score differently; reusing the earlier judgments scores the same', { timeout: 120000 }, async () => {
  const earlier = await firstCall();
  assert.equal((await judgeAll(earlier)).status, 'done');
  const wavering = await firstCall();
  assert.equal((await judgeAll(wavering, giveUpFirst)).status, 'done');
  assert.notDeepEqual(await scoresOf(wavering.ws.out), await scoresOf(earlier.ws.out), 'two judgings of one site gave two scores');
  const reused = await firstCall({ reusePath: earlier.ws.out });
  assert.equal(reused.first.status, 'done', 'every page kept its judgments, so one call is enough');
  assert.deepEqual(await scoresOf(reused.ws.out), await scoresOf(earlier.ws.out));
  const units = queuedUnits(await readQueue({ judge_pages: path.join(earlier.ws.out, 'judge-queue') })).length;
  assert.match(await readFile(reused.first.reports.md, 'utf8'), new RegExp(`이어받은 판정 ${units}개`));
});

test('only the page whose evidence changed is judged again', { timeout: 120000 }, async () => {
  const earlier = await firstCall();
  await judgeAll(earlier);
  const edited = { ...brewPages(), '/about': brewPage('About Brew, renewed', ['/']) };
  const reused = await firstCall({ pages: edited, reusePath: earlier.ws.out });
  assert.equal(reused.first.status, 'awaiting_judgments');
  const queue = await readQueue(reused.first);
  const unchanged = queue.pages.filter(page => !page.url.endsWith('/about'));
  const folder = path.join(reused.ws.out, 'judgments');
  assert.equal((await readdir(folder)).length, unchanged.length, 'a file for each page that did not change');
  const next = await nextJudgePage({ queueDir: reused.first.judge_pages, judgmentsDir: folder });
  assert.equal(next.status, 'next');
  assert.match(next.page.url, /\/about$/, 'the model is asked for the changed page alone');
  await writeFile(next.write_to, JSON.stringify(passJudgments({ ...queue, pages: [next.page] })));
  const done = await run({ answersPath: reused.ws.answersPath, out: reused.ws.out, judgmentsPath: folder }, reused.overrides);
  assert.equal(done.status, 'done');
  const taken = unchanged.reduce((sum, page) => sum + page.families.length, 0);
  assert.match(await readFile(done.reports.md, 'utf8'), new RegExp(`이어받은 판정 ${taken}개`));
});

test('a page whose earlier citation no longer checks is judged again, not reused', { timeout: 120000 }, async () => {
  const earlier = await firstCall();
  await judgeAll(earlier);
  const broken = path.join(earlier.ws.out, 'judgments', pageFile(0));
  const list = await readJson(broken);
  list[0].span_ids = ['0-1'];
  await writeFile(broken, JSON.stringify(list));
  const reused = await firstCall({ reusePath: earlier.ws.out });
  assert.equal(reused.first.status, 'awaiting_judgments');
  const files = await readdir(path.join(reused.ws.out, 'judgments'));
  assert.ok(!files.includes(pageFile(0)) && files.length > 0, 'the broken page has no file; the others were copied');
});

test('judgments are not taken from an audit made from other questions, and not with --judgments', { timeout: 120000 }, async () => {
  const earlier = await firstCall();
  await judgeAll(earlier);
  const site = memorySite();
  const other = await workspace(answersFor(`${SITE}/`, { questions: [{ id: 'q9', question: 'Where is Brew Cafe?', category: 'brand' }] }));
  const overrides = { env: quietEnv(), home: other.home, selectTransport: site.selectTransport };
  await assert.rejects(run({ answersPath: other.answersPath, out: other.out, reusePath: earlier.ws.out }, overrides), /other questions or facts/);
  assert.equal(site.requests.length, 0, 'refused before anything was collected');
  await assert.rejects(run({ answersPath: other.answersPath, out: other.out, reusePath: earlier.ws.out, judgmentsPath: other.dir }, overrides), /usage:/);
});
