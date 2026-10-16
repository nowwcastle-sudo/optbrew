// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { mergeFindings } from '../skills/optbrew/scripts/core/findings.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
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

test('the pages up to the limit are audited: a 30-page site in full, a 60-page site cut at the default, and raising the limit raises the count', async t => {
  const audit = async (count, answers) => {
    const site = memorySite(bigSite(count));
    return twoCalls(site, answers, { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  };
  const small = await audit(30, answersFor(`${SITE}/`));
  const sampled = await audit(60, answersFor(`${SITE}/`));
  const raised = await audit(60, answersFor(`${SITE}/`, { max_urls: 80, sample_mode: 'raise' }));
  const pagesOf = run => run.context.protocol.page_types.flatMap(type => type.urls);
  assert.equal(pagesOf(small).length, 31, 'the home page and all 30 listed pages');
  assert.equal(pagesOf(sampled).length, limits().max_urls_default - 2, 'the default limit less robots.txt and sitemap.xml');
  assert.equal(pagesOf(raised).length, 61, 'the home page and all 60 listed pages');
  for (const result of [small, sampled, raised]) {
    const units = new Set(result.report.baseline.input.observations.filter(x => x.family_id === 'fetch-response').map(x => x.unit_key));
    assert.equal(units.size, pagesOf(result).length, 'an observation for every selected page');
    assert.equal(result.queue.pages.length, pagesOf(result).length, 'and a queue page for every one');
    assert.ok(result.second.status === 'done');
  }
  assert.deepEqual(pagesOf(sampled).map(x => x.normalized), pagesOf(raised).slice(0, pagesOf(sampled).length).map(x => x.normalized), 'the same order, cut at the limit');
  assert.deepEqual(small.context.protocol.page_types.map(type => type.id), ['home', 'section']);
  assert.ok(small.context.protocol.render.pages.length <= limits().render_pages);
  const queueFile = await readFile(small.first.judge_queue, 'utf8');
  const stored = JSON.stringify(await readJson((await readJson(path.join(small.ws.out, 'evidence', 'evidence-index.json'))).judge_queue[0].evidence_ref), null, 2);
  t.diagnostic(`judge-queue.json for 31 pages: ${Buffer.byteLength(queueFile)} bytes (the stored queue: ${Buffer.byteLength(stored)} bytes)`);
  assert.ok(queueFile.length < stored.length);
});

test('sitemap files with CMS names (Yoast, WordPress) are read by what they hold, not by their file name', async () => {
  const child = names => ({ type: 'application/xml', body: `<urlset>${names.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>` });
  const pages = { '/': brewPage('Brew Home', []), '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: `<sitemapindex><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>` },
    '/page-sitemap.xml': child(['/about', '/contact']), '/wp-sitemap-posts-post-1.xml': child(['/blog/first']),
    '/about': brewPage('About', []), '/contact': brewPage('Contact', []), '/blog/first': brewPage('First', []) };
  const site = memorySite(pages);
  const { context, ws } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  assert.deepEqual(context.protocol.page_types.flatMap(type => type.urls.map(url => url.normalized)).sort(), [`${SITE}/`, `${SITE}/about`, `${SITE}/blog/first`, `${SITE}/contact`]);
  const intake = await readJson(path.join(ws.out, 'intake.json'));
  assert.deepEqual(intake.selection.sources, { preflight: 'read', sitemap_pages: 3, linked_pages: 0 });
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

test('an --out that holds files this audit did not make is refused and left alone; the audit\'s own leftovers are cleared', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  await mkdir(path.join(ws.out, 'evidence'), { recursive: true });
  await writeFile(path.join(ws.out, 'evidence', 'my-notes.txt'), 'the owner\'s notes');
  await writeFile(path.join(ws.out, 'context.json'), '{"run_id":"somebody-else"}');
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws)), { message: /^This folder holds files this audit did not make/ });
  assert.equal(await readFile(path.join(ws.out, 'evidence', 'my-notes.txt'), 'utf8'), 'the owner\'s notes');
  assert.equal(await readFile(path.join(ws.out, 'context.json'), 'utf8'), '{"run_id":"somebody-else"}');
  assert.equal(site.requests.length, 0, 'nothing was fetched');
  // The folder of a first call that stopped after its evidence index existed is the audit's own and is cleared.
  const [contextStage, collectStage] = stages();
  const own = await workspace(answersFor(`${SITE}/`));
  await assert.rejects(run({ answersPath: own.answersPath, out: own.out }, overridesOf(site, own, { stages: [contextStage, collectStage, { name: 'boom', run: async () => { throw new Error('stopped'); } }] })), /stopped/);
  assert.equal((await run({ answersPath: own.answersPath, out: own.out }, overridesOf(site, own))).status, 'awaiting_judgments');
});

test('the same problem on several pages is one fix row that says how many pages', async () => {
  const pages = bigSite(3);
  for (const route of ['/section/page-1', '/section/page-2', '/section/page-3']) pages[route] = { body: pages[route].body.replace(/<title>[^<]*<\/title>/, '') };
  const site = memorySite(pages);
  const { second } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const report = await readJson(second.reports.json);
  const rows = report.tables.remediation.filter(row => row[1].startsWith('Raw HTML has no title'));
  assert.equal(rows.length, 1);
  assert.match(rows[0][1], /\(3개 페이지: /);
  assert.equal(report.composed.fixes.filter(fix => fix.check_id === 'document-title').length, 1);
  const merged = mergeFindings([1, 2].map(i => ({ schema_version: '2.0.0', finding_id: `f${i}`, check_id: 'document-title', unit_key: `document-title|${SITE}/p`, unit_keys: [`document-title|${SITE}/p${i}`],
    priority: 'P2', blocker: false, message: 'm', source_ref: `s${i}`, evidence_ref: 'e', remediation_ids: [], status: 'confirmed' })));
  assert.deepEqual(merged[0].unit_keys.sort(), [`document-title|${SITE}/p1`, `document-title|${SITE}/p2`], 'two sources of one issue keep every page');
});

test('duplicate titles on three pages are one finding, not three', async () => {
  const pages = bigSite(3);
  for (const route of ['/section/page-1', '/section/page-2', '/section/page-3']) pages[route] = { body: pages[route].body.replace(/<title>[^<]*<\/title>/, '<title>Same title</title>') };
  const site = memorySite(pages);
  const { report } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const titles = report.findings.filter(item => item.check_id === 'document-title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].unit_keys.length, 3);
  assert.equal(titles[0].message, 'Title duplicates the title of other pages');
  const observation = report.baseline.input.observations.find(x => x.unit_key === titles[0].unit_keys[0]);
  assert.equal(observation.measurement.duplicate_pages.length, 2, 'the other pages are in the measurement');
});

test('a grouped finding cannot list a page that did not fail the same way', async () => {
  const pages = brewPages();
  pages['/about'] = { body: brewPage('About Brew', ['/']).body.replace('<head>', '<head><meta name="robots" content="noindex">') };
  const facts = [{ key: 'phone', value: '02-555-0142', source_url: `${SITE}/about` }];
  const site = memorySite(pages);
  const ws = await workspace(answersFor(`${SITE}/`, { facts }));
  const overrides = overridesOf(site, ws);
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const probe = { name: 'probe', run: async state => {
    const packet = structuredClone(state.packet);
    packet.findings = packet.findings.map(item => item.check_id === 'index-policy' ? { ...item, unit_keys: [...item.unit_keys, `index-policy|${SITE}/`] } : item);
    assert.throws(() => buildReport(packet), /not a failed verdict of the same problem/);
    return { state };
  } };
  const done = await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, { ...overrides, stages: [...stages(), probe] });
  assert.equal(done.status, 'done');
});

test('an adopted start address is said in the run conditions and must match the intake record', async () => {
  const from = `${SITE}/`, to = 'https://www.brew.test/';
  const site = memorySite(redirectPages(from, to));
  const { ws, second } = await twoCalls(site, answersFor(from), { before: ws => preflightOf(site, from, ws.out) });
  const report = await readJson(second.reports.json);
  assert.deepEqual(report.start_redirect, { from, to });
  assert.match(await readFile(second.reports.md, 'utf8'), /시작 주소: https:\/\/brew\.test\/ → https:\/\/www\.brew\.test\/ \(이 주소로 연결되므로 감사는 https:\/\/www\.brew\.test\/에서 실행했습니다\)/);
  // A packet that names another address than the intake record is refused.
  const ws2 = await workspace(answersFor(from));
  await preflightOf(site, from, ws2.out);
  const overrides = overridesOf(site, ws2);
  const first = await run({ answersPath: ws2.answersPath, out: ws2.out }, overrides);
  const judgmentsPath = path.join(ws2.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const forge = { name: 'forge', run: async state => ({ state: { ...state, start_redirect: { from, to: 'https://elsewhere.test/' } } }) };
  const list = stages();
  list.splice(list.findIndex(stage => stage.name === 'report'), 0, forge);
  await assert.rejects(run({ answersPath: ws2.answersPath, out: ws2.out, judgmentsPath }, { ...overrides, stages: list }), /start redirect differs from the intake record or the run target/);
  assert.ok(ws);
});

test('a preflight of another address is ignored, an off-site redirect is named, and an unusable preflight is said in the report', async () => {
  const site = memorySite();
  const stale = await workspace(answersFor(`${SITE}/`));
  await mkdir(path.join(stale.out, 'preflight'), { recursive: true });
  await writeFile(path.join(stale.out, 'preflight', 'start.json'), JSON.stringify({ requested_url: 'https://www.cafe.test/', final_url: 'https://www.cafe.test/' }));
  assert.equal((await run({ answersPath: stale.answersPath, out: stale.out }, overridesOf(site, stale))).status, 'awaiting_judgments', 'a stale start.json does not redirect the run');
  const away = memorySite({ ...brewPages(), 'brew.test/': { redirect: 'https://other.test/' } });
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(away, `${SITE}/`, ws.out);
  assert.equal((await readJson(path.join(ws.out, 'preflight', 'start.json'))).redirected_to, 'https://other.test/');
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(away, ws)),
    { message: 'The address https://brew.test/ leads to another site (https://other.test), which this audit does not cover. If you own that site, start again with its address.' });
  const broken = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, broken.out);
  const evidence = path.join(broken.out, 'preflight', 'evidence');
  for (const name of await readdir(evidence)) if (name.endsWith('.html') || name.endsWith('.bin')) await appendFile(path.join(evidence, name), 'x');
  const overrides = overridesOf(site, broken);
  const first = await run({ answersPath: broken.answersPath, out: broken.out }, overrides);
  const judgmentsPath = path.join(broken.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const done = await run({ answersPath: broken.answersPath, out: broken.out, judgmentsPath }, overrides);
  assert.equal((await readJson(path.join(broken.out, 'intake.json'))).selection.sources.preflight, 'unreadable');
  assert.ok((await readJson(done.reports.json)).follow_ups.some(row => row.reason === 'preflight_unreadable'));
});

test('the commands and result fields SKILL.md names are the ones run.mjs and preflight.mjs take and print', async () => {
  const skill = (await readFile(new URL('../skills/optbrew/SKILL.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const lines = name => skill.split('\n').filter(line => line.includes(`scripts/${name}.mjs`) && line.startsWith('node '));
  const flagsOf = line => line.match(/--[a-z-]+/g);
  assert.deepEqual(lines('run').map(flagsOf), [['--answers', '--out'], ['--answers', '--out', '--judgments']]);
  const preflightUsage = (await readFile(new URL('../skills/optbrew/scripts/preflight.mjs', import.meta.url), 'utf8')).match(/const USAGE = '([^']*)'/)[1];
  for (const flag of flagsOf(lines('preflight')[0])) assert.ok(preflightUsage.includes(flag), `preflight takes ${flag}`);
  // The documented flags, run for real: a first call, then the documented second command in a child process.
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws));
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const child = await new Promise(resolve => {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('../skills/optbrew/scripts/run.mjs', import.meta.url)), '--answers', ws.answersPath, '--out', ws.out, '--judgments', judgmentsPath],
      { env: { ...quietEnv(), HOME: ws.home, USERPROFILE: ws.home }, windowsHide: true });
    const out = [];
    proc.stdout.on('data', chunk => out.push(chunk));
    proc.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString('utf8') }));
  });
  assert.equal(child.code, 0);
  const done = JSON.parse(child.stdout);
  const printed = { ...first, ...done };
  for (const field of ['judge_queue', 'reports', 'score_input', 'queue_items', 'lab_cwv']) assert.ok(skill.includes(`\`${field}\``), `SKILL.md names ${field}`);
  for (const field of ['judge_queue', 'queue_items', 'reports', 'score_input']) assert.ok(field in printed, `${field} is printed`);
  assert.ok(done.reports.json && done.reports.md && done.reports.html);
  // Every field step 7.3 names is printed, whatever is added to that step later; lab_cwv exists only with a Chrome.
  const named = [...skill.split('\n').find(line => line.startsWith('3. 종료 코드가 0이면')).matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  const printable = new Set([...Object.keys(printed), ...Object.keys(done.reports), 'lab_cwv', 'awaiting_judgments', 'done']);
  assert.deepEqual(named.filter(name => !printable.has(name)), [], 'SKILL.md names a field run.mjs does not print');
  assert.ok(named.includes('status') && named.includes('queue_items'));
  assert.match(await readFile(new URL('../skills/optbrew/scripts/run.mjs', import.meta.url), 'utf8'), /lab_cwv/, 'lab_cwv is printed when Chrome measured it');
});

test('WordPress and Yoast: /sitemap.xml redirects to an index; pages that only the child sitemaps list pass discovery', async () => {
  const xml = body => ({ type: 'application/xml', body });
  const child = names => xml(`<urlset>${names.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`);
  const pages = { '/': brewPage('Brew Home', []), '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { redirect: '/sitemap_index.xml' },
    '/sitemap_index.xml': xml(`<sitemapindex><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/post-sitemap.xml</loc></sitemap></sitemapindex>`),
    '/page-sitemap.xml': child(['/menu', '/about']), '/post-sitemap.xml': child(['/news/first']),
    '/menu': brewPage('Menu', []), '/about': brewPage('About', []), '/news/first': brewPage('First', []) };
  const site = memorySite(pages);
  const { report, context } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const declared = context.protocol.auxiliary_resources.filter(x => x.kind === 'sitemap').map(x => x.normalized).sort();
  assert.deepEqual(declared, ['/page-sitemap.xml', '/post-sitemap.xml', '/sitemap.xml', '/sitemap_index.xml'].map(p => `${SITE}${p}`));
  const discovery = report.baseline.input.observations.filter(x => x.family_id === 'discovery');
  assert.equal(discovery.length, 3, 'the three pages the child sitemaps list have a verdict (the home page is in no sitemap and has none)');
  assert.ok(discovery.every(x => x.state === 'pass'), JSON.stringify(discovery.map(x => [x.unit_key, x.state, x.reason])));
  assert.ok(discovery.some(x => x.unit_key.endsWith('/menu') && x.reason === 'Listed in a declared sitemap'));
});

test('generic anchors in a shared menu are one internal-navigation finding on every page they hit', async () => {
  const pages = bigSite(3);
  for (const route of Object.keys(pages)) if (pages[route].body?.includes('<a ')) pages[route] = { body: pages[route].body.replace(/(<a [^>]*>)[^<]*(<\/a>)/g, '$1click here$2') };
  const site = memorySite(pages);
  const { report } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const navigation = report.findings.filter(item => item.check_id === 'internal-navigation');
  assert.equal(navigation.length, 1, 'one fix, whatever each page\'s own counts are');
  assert.equal(navigation[0].unit_keys.length, 4);
  assert.equal(navigation[0].message, 'Linked pages have too many empty or generic anchors');
});

test('two problems of one check on one page are two fixes, each listing every page it hits', async () => {
  const chain = ['/', '/p1', '/p2', '/p3', '/p4', '/p5', '/p6'];
  const pages = { '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: `<urlset>${chain.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>` } };
  chain.forEach((p, i) => { pages[p] = brewPage(`Chain ${i}`, []); if (chain[i + 1]) pages[p].body = pages[p].body.replace('</body>', `<a href="${chain[i + 1]}">click here</a></body>`); });
  const site = memorySite(pages);
  const { report } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const navigation = report.findings.filter(item => item.check_id === 'internal-navigation');
  const paths = finding => (finding.unit_keys ?? [finding.unit_key]).map(unit => new URL(unit.split('|').at(-1)).pathname).sort();
  assert.deepEqual(navigation.map(finding => [finding.message, paths(finding)]).sort(), [
    ['Linked pages have too many empty or generic anchors', ['/', '/p1', '/p2', '/p3', '/p4', '/p5']],
    ['The home page reaches this page in more clicks than the limit', ['/p4', '/p5', '/p6']]]);
  assert.equal(new Set(navigation.map(finding => finding.finding_id)).size, 2);
});

test('an HTML page that shows sample sitemap XML is audited as a page; a real child sitemap with an XML prolog still counts', async () => {
  const guide = { body: brewPage('Sitemap guide', ['/']).body.replace('</body>',
    `<script>const sample = '<urlset><url><loc>${SITE}/</loc></url></urlset>';</script></body>`) };
  const prolog = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>\n<!-- generated -->\n';
  const pages = { '/': brewPage('Brew Home', ['/blog/sitemap-guide/', '/about']), '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: `${prolog}<sitemapindex><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap></sitemapindex>` },
    '/page-sitemap.xml': { type: 'application/xml', body: `${prolog}<urlset><url><loc>${SITE}/about</loc></url><url><loc>${SITE}/blog/sitemap-guide/</loc></url></urlset>` },
    '/about': brewPage('About', ['/']), '/blog/sitemap-guide/': guide };
  const site = memorySite(pages);
  const { report, context } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const selected = context.protocol.page_types.flatMap(type => type.urls.map(url => url.normalized));
  assert.ok(selected.includes(`${SITE}/blog/sitemap-guide/`), 'the guide is a page to audit');
  assert.deepEqual(context.protocol.auxiliary_resources.filter(x => x.kind === 'sitemap').map(x => x.normalized).sort(),
    [`${SITE}/page-sitemap.xml`, `${SITE}/sitemap.xml`]);
  const discovery = report.baseline.input.observations.filter(x => x.family_id === 'discovery' && x.unit_key.endsWith('/blog/sitemap-guide/'));
  assert.deepEqual(discovery.map(x => [x.state, x.reason]), [['pass', 'Listed in a declared sitemap']]);
});

test('the shipped flow (answers hold the landed address) still says the typed address was redirected, both ways', async () => {
  const from = `${SITE}/`, to = 'https://www.brew.test/';
  const site = memorySite(redirectPages(from, to));
  const { report, ws, second } = await twoCalls(site, answersFor(to), { before: ws => preflightOf(site, from, ws.out) });
  assert.deepEqual(report.start_redirect, { from, to });
  assert.match(await readFile(second.reports.md, 'utf8'), /시작 주소: https:\/\/brew\.test\/ → https:\/\/www\.brew\.test\//);
  // A packet that leaves the redirect out while the intake record has it is refused too.
  const again = await workspace(answersFor(to));
  await preflightOf(site, from, again.out);
  const overrides = overridesOf(site, again);
  const first = await run({ answersPath: again.answersPath, out: again.out }, overrides);
  const judgmentsPath = path.join(again.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const forget = { name: 'forget', run: async state => ({ state: { ...state, start_redirect: null } }) };
  const list = stages();
  list.splice(list.findIndex(stage => stage.name === 'report'), 0, forget);
  await assert.rejects(run({ answersPath: again.answersPath, out: again.out, judgmentsPath }, { ...overrides, stages: list }), /start redirect differs from the intake record or the run target/);
  assert.ok(ws);
});

test('remaining work names every page of a grouped finding', async () => {
  const pages = bigSite(3);
  for (const route of ['/section/page-1', '/section/page-2', '/section/page-3']) pages[route] = { body: pages[route].body.replace(/<title>[^<]*<\/title>/, '') };
  const site = memorySite(pages);
  const { report } = await twoCalls(site, answersFor(`${SITE}/`), { before: ws => preflightOf(site, `${SITE}/`, ws.out) });
  const row = report.follow_ups.find(item => item.problem.startsWith('Raw HTML has no title'));
  assert.match(row.problem, /\(3개 페이지: /);
});

test('a folder left by a first call that stopped before its first index save is rerun; one that only looks similar is refused', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const [contextStage, collectStage] = stages();
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws, { stages: [contextStage, collectStage, { name: 'boom', run: async () => { throw new Error('stopped'); } }] })), /stopped/);
  await rm(path.join(ws.out, 'evidence', 'evidence-index.json'));
  assert.equal((await run({ answersPath: ws.answersPath, out: ws.out }, overridesOf(site, ws))).status, 'awaiting_judgments');
  const other = await workspace(answersFor(`${SITE}/`));
  await mkdir(path.join(other.out, 'evidence'), { recursive: true });
  await writeFile(path.join(other.out, 'context.json'), '{"run_id":"somebody-else"}');
  await assert.rejects(run({ answersPath: other.answersPath, out: other.out }, overridesOf(site, other)), { message: /^This folder holds files this audit did not make/ });
});
