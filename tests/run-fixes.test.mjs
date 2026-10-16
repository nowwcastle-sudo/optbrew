// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { stages } from '../skills/optbrew/scripts/core/stages.mjs';
import { answersFor, bigSite, brewPage, brewPages, memorySite, passJudgments, preflightOf, queuedUnits, quietEnv, SITE, workspace } from './support/run-scenario.mjs';

// Assembled from fragments: the repository never contains a literal key.
const KEY = ['AI', 'za', 'Sy', 'Fake', 'Fix', 'Key', '0123456789', 'abcdefghij', 'KLMN'].join('');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const overridesOf = (site, ws, extra = {}) => ({ env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, ...extra });

/** Both calls of a run on `site`; judgments are `judge(queue)` or a pass for every unit. */
async function twoCalls(site, answers, { before = null, judge = passJudgments, extra = {} } = {}) {
  const ws = await workspace(answers);
  if (before) await before(ws);
  const overrides = overridesOf(site, ws, extra);
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const queue = await readJson(first.judge_queue);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(judge(queue)));
  const second = await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, overrides);
  return { ws, overrides, first, second, queue, report: await readJson(second.reports.json), context: await readJson(path.join(ws.out, 'context.json')) };
}

test('pages with identical bytes and a sitemap answered by the app shell: both calls finish, each page is queued once', async () => {
  const shell = brewPage('Shell', ['/about', '/contact']);
  const pages = { '/': shell, '/about': shell, '/contact': shell, '/sitemap.xml': { ...shell }, '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' } };
  const facts = ['/about', '/contact'].map(p => ({ key: 'phone', value: '02-555-0142', source_url: `${SITE}${p}` }));
  const { queue, report, context } = await twoCalls(memorySite(pages), answersFor(`${SITE}/`, { facts }));
  const urls = context.protocol.page_types.flatMap(type => type.urls.map(url => url.normalized)).sort();
  assert.deepEqual(urls, [`${SITE}/`, `${SITE}/about`, `${SITE}/contact`]);
  assert.deepEqual(queue.pages.map(page => page.url).sort(), urls, 'every selected page is queued, and the sitemap is not');
  assert.ok(queue.pages.every(page => page.families.length === queue.pages[0].families.length));
  assert.equal(report.model_judgments.length, queuedUnits(queue).length);
});

test('a 30-page site: the pages up to the limit are audited, and raising the limit raises the count', async t => {
  const audit = async answers => {
    const site = memorySite(bigSite(30));
    return twoCalls(site, answers, { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  };
  const sampled = await audit(answersFor(`${SITE}/`, { max_urls: 20 }));
  const raised = await audit(answersFor(`${SITE}/`, { max_urls: 60, sample_mode: 'raise' }));
  const pagesOf = run => run.context.protocol.page_types.flatMap(type => type.urls);
  assert.equal(pagesOf(sampled).length, 20 - 2, 'the limit less robots.txt and sitemap.xml');
  assert.equal(pagesOf(raised).length, 31, 'the home page and all 30 listed pages');
  for (const result of [sampled, raised]) {
    const units = new Set(result.report.baseline.input.observations.filter(x => x.family_id === 'fetch-response').map(x => x.unit_key));
    assert.equal(units.size, pagesOf(result).length, 'an observation for every selected page');
    assert.equal(result.queue.pages.length, pagesOf(result).length, 'and a queue page for every one');
    assert.ok(result.second.status === 'done');
  }
  assert.deepEqual(pagesOf(sampled).map(x => x.normalized), pagesOf(raised).slice(0, pagesOf(sampled).length).map(x => x.normalized), 'the same order, cut at the limit');
  assert.deepEqual(raised.context.protocol.page_types.map(type => type.id), ['home', 'section']);
  assert.ok(raised.context.protocol.render.pages.length <= limits().render_pages);
  const queueFile = await readFile(raised.first.judge_queue, 'utf8');
  const stored = JSON.stringify(await readJson((await readJson(path.join(raised.ws.out, 'evidence', 'evidence-index.json'))).judge_queue[0].evidence_ref), null, 2);
  t.diagnostic(`judge-queue.json for 31 pages: ${Buffer.byteLength(queueFile)} bytes (the stored queue: ${Buffer.byteLength(stored)} bytes)`);
  assert.ok(queueFile.length < stored.length);
});

const redirectPages = (from, to) => {
  const pages = brewPages();
  const moved = Object.fromEntries(Object.entries(pages).map(([route, page]) => [`${new URL(to).host}${route}`, page]));
  return { ...moved, [from]: { redirect: to } };
};

test('a start address that redirects to its www or https twin is adopted and said so; the same answers resume', async () => {
  for (const [from, to] of [[`${SITE}/`, 'https://www.brew.test/'], ['http://brew.test/', `${SITE}/`]]) {
    const site = memorySite(redirectPages(from, to));
    const answers = answersFor(from);
    const { ws, context, report, second } = await twoCalls(site, answers, { before: ws => preflightOf(site, from, ws.out) });
    assert.equal(context.target, to);
    assert.deepEqual(context.scope.allowed, [{ origin: new URL(to).origin, path_prefix: '/' }]);
    assert.equal(second.status, 'done');
    assert.ok(report.baseline.input.observations.some(x => x.family_id === 'fetch-response' && x.state === 'pass'), 'something was measured');
    const intake = await readJson(path.join(ws.out, 'intake.json'));
    assert.deepEqual(intake.selection.start_redirect, { from, to });
  }
});

test('any other redirect target is one plain sentence, and so is a run in which no selected page can be fetched', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  await mkdir(path.join(ws.out, 'preflight'), { recursive: true });
  await writeFile(path.join(ws.out, 'preflight', 'start.json'), JSON.stringify({ final_url: 'https://other.test/' }));
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws)),
    { message: 'The address https://brew.test/ leads to another site (https://other.test), which this audit does not cover. If you own that site, start again with its address.' });
  const dead = memorySite({ '/': { redirect: 'https://elsewhere.test/' } });
  const second = await workspace(answersFor(`${SITE}/`));
  await assert.rejects(run({ answersPath: second.answersPath, out: second.out }, overridesOf(dead, second)),
    { message: /^None of the selected pages could be fetched, so there is nothing to audit\./ });
});

test('a first call that stopped early can be run again into the same --out', async () => {
  const [contextStage, collectStage] = stages();
  const boom = { name: 'boom', run: async () => { throw new Error('closed terminal'); } };
  for (const early of [[contextStage, boom], [contextStage, collectStage, boom]]) {
    const site = memorySite();
    const ws = await workspace(answersFor(`${SITE}/`));
    await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws, { stages: early })), /closed terminal/);
    const again = await run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws));
    assert.equal(again.status, 'awaiting_judgments', 'no EEXIST on its own files and no false "index changed"');
  }
  // A report stage that stopped after writing costs.json can run again.
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const overrides = overridesOf(site, ws);
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  await writeFile(path.join(ws.out, 'costs.json'), '{}');
  assert.equal((await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, overrides)).status, 'done');
});

test('a model-judged failure is a finding marked as the model\'s, citing the page evidence', async () => {
  const { report } = await twoCalls(memorySite(), answersFor(`${SITE}/`), { judge: queue => passJudgments(queue).map(j => j.family_id === 'claim-support' ? { ...j, state: 'fail', reason: 'No claim has a source' } : j) });
  const finding = report.findings.find(item => item.check_id === 'claim-support');
  assert.equal(finding.source_ref, 'optbrew:model-judgment');
  assert.equal(finding.label, '근거 확인됨, 판정은 모델');
  assert.ok(report.model_judgments.some(row => row.family_id === 'claim-support' && row.state === 'fail'));
  assert.ok(report.findings.filter(item => item.check_id !== 'claim-support').every(item => !item.label), 'a code finding is not labelled');
});

test('the same problem on several pages is one finding that lists its pages', async () => {
  const pages = bigSite(3);
  for (const route of ['/section/page-1', '/section/page-2', '/section/page-3']) pages[route] = { body: pages[route].body.replace(/<title>[^<]*<\/title>/, '') };
  const site = memorySite(pages);
  const { report } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const titles = report.findings.filter(item => item.check_id === 'document-title');
  assert.equal(titles.length, 1, 'one fix for three pages');
  assert.deepEqual(titles[0].unit_keys.sort(), [1, 2, 3].map(i => `document-title|${SITE}/section/page-${i}`));
});

test('the field-data call goes through the run\'s transport with the key in the header only', async () => {
  const site = memorySite();
  const { ws } = await twoCalls(site, answersFor(`${SITE}/`), { extra: { env: { ...quietEnv(), OPTBREW_GOOGLE_API_KEY: KEY } } });
  const cwv = site.calls.filter(call => new URL(call.href).host === 'chromeuxreport.googleapis.com');
  assert.ok(cwv.length > 0, 'the request went through the memory transport');
  assert.ok(cwv.every(call => call.headers['x-goog-api-key'] === KEY && !call.href.includes(KEY)));
  assert.ok(!(await readFile(path.join(ws.out, 'report.json'), 'utf8')).includes(KEY));
});

test('a forged collector not-applicable decision is refused by the report', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const real = stages();
  // A self-consistent forger: the decision is changed in the verdicts and in the saved observation file, so only the replay can tell.
  const edit = obs => obs.applicability_decision ? { ...obs, applicability_decision: { ...obs.applicability_decision, reason: `${obs.applicability_decision.reason} (edited)` } } : obs;
  const forge = { name: 'forge', run: async state => {
    const file = path.join(state.out, 'evidence', 'observations.json');
    await writeFile(file, `${JSON.stringify((await readJson(file)).map(edit), null, 2)}\n`);
    return { state: { ...state, observations: state.observations.map(edit) } };
  } };
  real.splice(real.findIndex(stage => stage.name === 'score'), 0, forge);
  const overrides = overridesOf(site, ws);
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, { ...overrides, stages: real }), /collector verdict differs from raw evidence/);
});

test('a resume selects no transport and opens no chrome', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  let selections = 0, opened = 0;
  const overrides = overridesOf(site, ws, { selectTransport: async input => { selections++; return site.selectTransport(input); },
    chrome: { open: () => { opened++; return { address_vetting: 'pinned', fetchStatic: null, get: async () => null, notFound: () => ({ found: false, reason: 'chrome_not_found' }) }; }, close: async () => {} } });
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const [before, chromeBefore] = [selections, opened];
  assert.ok(before > 0 && chromeBefore > 0);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, overrides);
  assert.deepEqual([selections, opened], [before, chromeBefore]);
});

test('owner export paths: relative to the answers file, ~ is the home folder, and a file above the size cap is refused', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const home = path.join(ws.dir, 'userhome');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(ws.dir, 'naver.txt'), '기간 2026.09.01 ~ 2026.09.28\n키워드\t클릭수\t노출수\n브루\t30\t400\n');
  await writeFile(path.join(home, 'big.txt'), Buffer.alloc(limits().max_bytes + 1, 97));
  const answers = answersFor(`${SITE}/`, { owner_exports: [{ kind: 'naver', path: 'naver.txt' }, { kind: 'gsc', path: '~/big.txt' }] });
  await writeFile(ws.answersPath, JSON.stringify(answers));
  await run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws, { env: { ...quietEnv(), HOME: home, USERPROFILE: home } }));
  const index = await readJson(path.join(ws.out, 'evidence', 'evidence-index.json'));
  assert.deepEqual(index.owner_exports.map(x => [x.kind, x.status, x.reason ?? null]), [['naver', 'read', null], ['gsc', 'unusable', 'export_file_too_large']]);
  const intake = await readJson(path.join(ws.out, 'intake.json'));
  assert.deepEqual(intake.answers.owner_exports, [{ kind: 'naver', name: 'naver.txt' }, { kind: 'gsc', name: 'big.txt' }], 'the intake record keeps file names, not folders');
});
