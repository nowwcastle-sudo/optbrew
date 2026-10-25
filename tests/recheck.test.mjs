// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { answersFor, bigSite, memorySite, passJudgments, preflightOf, quietEnv, readQueue, SITE, workspace } from './support/run-scenario.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

/** One audit to `done` into `out`: the run picks its pages from `out/preflight`, as step 7 does after step 3. */
async function audit(site, ws, out) {
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath: ws.answersPath, out }, overrides);
  const judgmentsPath = path.join(ws.dir, `${path.basename(out)}-judgments.json`);
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readQueue(first))));
  const done = await run({ answersPath: ws.answersPath, out, judgmentsPath }, overrides);
  assert.equal(done.status, 'done');
  return readJson(done.score_input);
}

test('the step-11 re-check (recheck.md) compares: the after run reuses the before preflight, so it audits the same pages', async () => {
  const site = memorySite(bigSite(20));
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, ws.out);
  const before = await audit(site, ws, ws.out);
  const after = `${ws.out}-after`;
  await cp(path.join(ws.out, 'preflight'), path.join(after, 'preflight'), { recursive: true });
  const result = compare(before, await audit(site, ws, after));
  assert.equal(result.status, 'comparable', JSON.stringify(result.reasons));
  // Without the copied preflight the after run reads no sitemap and audits other pages, so the two runs cannot be compared.
  const bare = compare(before, await audit(site, ws, `${ws.out}-bare`));
  assert.equal(bare.status, 'not_comparable');
});
