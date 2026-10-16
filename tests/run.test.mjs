// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { findChrome } from '../skills/optbrew/scripts/core/chrome.mjs';
import { stages } from '../skills/optbrew/scripts/core/stages.mjs';
import { answersFor, brewPage, brewPages, memorySite, passJudgments, queuedUnits, quietEnv, SITE, workspace } from './support/run-scenario.mjs';
import { startSite } from './support/review-scenario.mjs';
import { tempDir } from './support/temp-dir.mjs';

// Assembled from fragments: the repository never contains a literal key.
const KEY = ['AI', 'za', 'Sy', 'Fake', 'Run', 'Key', '0123456789', 'abcdefghij', 'KLMN'].join('');
const INDEX_CHANGED = /^index changed: /;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const files = async dir => (await readdir(dir, { recursive: true })).sort();

/** A first call on the in-memory site; returns what a second call needs. */
async function firstCall({ pages = brewPages(), over = {}, extra = {} } = {}) {
  const site = memorySite(pages);
  const ws = await workspace(answersFor(`${SITE}/`, over));
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, ...extra };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  return { site, ws, overrides, first };
}

async function judge(call) {
  const queue = await readJson(call.first.judge_queue);
  const judgmentsPath = path.join(call.ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(queue)));
  return { queue, judgmentsPath };
}

test('first call halts awaiting judgments with a queue', async () => {
  const { site, ws, first } = await firstCall();
  assert.equal(first.status, 'awaiting_judgments');
  assert.equal(first.judge_queue, path.join(ws.out, 'judge-queue.json'));
  const queue = await readJson(first.judge_queue);
  assert.ok(queuedUnits(queue).length > 0);
  assert.equal(first.queue_items, queuedUnits(queue).length);
  assert.ok(site.requests.length > 0 && site.requests.length <= 50, 'the crawl stays within max_urls');
  const index = await readJson(path.join(ws.out, 'evidence', 'evidence-index.json'));
  // Carry 11: the queue lives in the evidence store, and the file in --out is that stored queue.
  assert.equal(index.judge_queue.length, 1);
  const stored = JSON.parse(await readFile(index.judge_queue[0].evidence_ref, 'utf8'));
  assert.equal(stored.items.length, queuedUnits(queue).length, 'the file is the stored queue, regrouped by page');
  for (const page of queue.pages) {
    const items = stored.items.filter(item => item.evidence_ref === page.evidence_ref);
    assert.deepEqual(items.map(item => item.family_id), page.families.map(family => family.family_id));
    assert.ok(items.every(item => JSON.stringify(item.spans) === JSON.stringify(page.spans)), 'each page lists its spans once, equal to the stored ones');
  }
  assert.ok((await readFile(first.judge_queue, 'utf8')).length < JSON.stringify(stored, null, 2).length, 'grouping makes the file smaller');
  // Carry 8: the audit index says what became of Chrome.
  assert.deepEqual(index.chrome, { found: false, reason: 'optbrew_chrome_missing' });
  await assert.rejects(readFile(path.join(ws.out, 'report.json')), { code: 'ENOENT' }, 'no report before the judgments');
});

test('second call resumes at judge without new requests', async () => {
  const call = await firstCall();
  const { judgmentsPath } = await judge(call);
  const context = await readFile(path.join(call.ws.out, 'context.json'), 'utf8');
  const before = call.site.requests.length;
  const second = await run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  assert.equal(second.status, 'done');
  assert.equal(call.site.requests.length, before, 'resuming collects nothing');
  assert.equal(await readFile(path.join(call.ws.out, 'context.json'), 'utf8'), context, 'the fixed context is reused, not rebuilt');
  assert.ok((await readFile(second.reports.md, 'utf8')).length > 0);
});

test('a tampered index stops the resume', async () => {
  const call = await firstCall();
  const { judgmentsPath } = await judge(call);
  const before = call.site.requests.length;
  const resume = () => run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  const evidence = path.join(call.ws.out, 'evidence');
  const page = (await readdir(evidence)).find(name => name.endsWith('.html'));
  await appendFile(path.join(evidence, page), '<!-- edited -->');
  await assert.rejects(resume(), { message: INDEX_CHANGED });
  assert.equal(call.site.requests.length, before, 'a failed resume does not collect again');
  const indexFile = path.join(evidence, 'evidence-index.json');
  await writeFile(indexFile, '{ not json');
  await assert.rejects(resume(), { message: INDEX_CHANGED });
  assert.equal(call.site.requests.length, before);
  await assert.rejects(readFile(path.join(call.ws.out, 'report.json')), { code: 'ENOENT' });
});

test('resume refuses answers that are not the ones the run was made from', async () => {
  const call = await firstCall();
  const { judgmentsPath } = await judge(call);
  const other = path.join(call.ws.dir, 'other.json');
  await writeFile(other, JSON.stringify(answersFor('https://other.test/')));
  await assert.rejects(run({ answersPath: other, out: call.ws.out, judgmentsPath }, call.overrides), /not the ones this run was made from/);
});

test('chrome is closed even when a stage throws', async () => {
  let closed = 0;
  const chrome = { open: () => { throw new Error('not used'); }, close: async () => { closed++; } };
  const boom = { name: 'boom', run: async () => { throw new Error('stage failed'); } };
  const ws = await workspace(answersFor(`${SITE}/`));
  const [contextStage] = stages();
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out }, { env: quietEnv(), home: ws.home, chrome, selectTransport: memorySite().selectTransport,
    stages: [contextStage, boom] }), /stage failed/);
  assert.equal(closed, 1);
  const invalid = await workspace({ not: 'answers' });
  await assert.rejects(run({ answersPath: invalid.answersPath, out: invalid.out }, { env: quietEnv(), chrome }), /IntakeAnswers/);
  assert.equal(closed, 2, 'also closed when the answers are refused before any stage');
});

test('adding a stage needs no change in other stages', async () => {
  const seen = [];
  const extra = { name: 'extra', run: async state => { seen.push(state.observations.length); return { state: { ...state, extra: true } }; } };
  const list = stages();
  list.splice(list.findIndex(stage => stage.name === 'judge'), 0, extra);
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, stages: list });
  assert.equal(first.status, 'awaiting_judgments');
  assert.equal(seen.length, 1);
  assert.ok(seen[0] > 0, 'the added stage saw the derived observations');
  assert.deepEqual(stages().map(stage => stage.name), ['context', 'collect', 'render', 'cwv', 'derive', 'judge', 'score', 'report'], 'the stock list is untouched');
});

test('run never writes outside --out', async () => {
  const sandbox = await tempDir('optbrew-sandbox-');
  const [home, cwd, tmp] = ['home', 'cwd', 'tmp'].map(name => path.join(sandbox, name));
  for (const dir of [home, cwd, tmp]) await mkdir(dir);
  const out = path.join(sandbox, 'out');
  const answersPath = path.join(sandbox, 'answers.json');
  await writeFile(answersPath, JSON.stringify(answersFor(`${SITE}/`)));
  const snapshot = async () => Object.fromEntries(await Promise.all([sandbox, home, cwd, tmp].map(async dir => [dir, await files(dir)])));
  const before = await snapshot();
  const site = memorySite();
  const env = { ...quietEnv(), TEMP: tmp, TMP: tmp, TMPDIR: tmp, HOME: home, USERPROFILE: home };
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const first = await run({ answersPath, out }, { env, selectTransport: site.selectTransport });
    const judgmentsPath = path.join(sandbox, 'judgments.json');
    await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
    await run({ answersPath, out, judgmentsPath }, { env, selectTransport: site.selectTransport });
  } finally { process.chdir(previous); }
  const after = await snapshot();
  assert.deepEqual(after[home], before[home]);
  assert.deepEqual(after[cwd], before[cwd]);
  assert.deepEqual(after[tmp], before[tmp]);
  assert.deepEqual(after[sandbox].filter(name => !name.startsWith('out') && !['judgments.json'].includes(name)), before[sandbox]);
});

test('one run produces report.json and report.md', async () => {
  const call = await firstCall();
  const { queue, judgmentsPath } = await judge(call);
  const second = await run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  assert.deepEqual(Object.keys(second), ['status', 'reports', 'score_input']);
  assert.equal(second.reports.json, path.join(call.ws.out, 'report.json'));
  assert.equal(second.reports.md, path.join(call.ws.out, 'report.md'));
  assert.equal(second.reports.html, path.join(call.ws.out, 'report.html'));
  assert.equal(second.score_input, path.join(call.ws.out, 'score-input.json'));
  const report = await readJson(second.reports.json);
  assert.deepEqual(await readJson(second.score_input), report.baseline.input, 'the ScoreInput file is the one the report scored');
  const markdown = await readFile(second.reports.md, 'utf8');
  assert.match(markdown, /^# optbrew 보고서/);
  const html = await readFile(second.reports.html, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script|<link|\ssrc=|\shref=|url\(/, 'the page needs no outside file');
  assert.ok(html.includes(report.composed.headline.text.replace(/'/g, '&#39;')), 'the page says the same conclusion');
  for (const row of report.composed.remaining) for (const id of row.runbook_ids) assert.ok(html.includes(`data-runbook="${id}"`), `the page opens ${id}`);
  assert.equal(report.model_judgments.length, queuedUnits(queue).length);
  // Carry 2 and 17: the phase was audited, and its snapshot says so.
  assert.equal(report.run_context.audited, true);
  assert.deepEqual(report.audit_snapshots, [{ phase: 'baseline', audit_ref: path.join(call.ws.out, 'evidence', 'evidence-index.json'), context_ref: 'context.json' }]);
  assert.equal(report.run_context.environment, 'production');
  assert.equal(report.run_context.evidence_ref, 'context.json');
  // Carry 11: the packet lists the stored queue.
  assert.ok(report.evidence_index.some(entry => entry.kind === 'judge-queue'));
  assert.ok(report.baseline.scores.every(result => result.readiness_status !== 'measured' || report.run_context.audited));
});

test('a failed check becomes a finding and the report still replays', async () => {
  const pages = brewPages();
  pages['/about'] = { body: brewPage('About Brew', ['/']).body.replace('<head>', '<head><meta name="robots" content="noindex">') };
  const call = await firstCall({ pages, over: { facts: [{ key: 'phone', value: '02-555-0142', source_url: `${SITE}/about` }] } });
  const { judgmentsPath } = await judge(call);
  const second = await run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  const report = await readJson(second.reports.json);
  const finding = report.findings.find(item => item.check_id === 'index-policy');
  assert.ok(finding, 'the noindex page is in the fix list');
  assert.equal(finding.blocker, true);
  assert.equal(finding.priority, 'P0');
  assert.equal(finding.unit_key, `index-policy|${SITE}/about`);
  // The Korean sentence travels beside the English message, which stays the grouping text (R65).
  assert.equal(finding.message_key, 'index-policy.noindex');
  assert.match(finding.text_ko.message, /^이 페이지가 noindex로 색인을 막고 있습니다/);
  for (const file of [second.reports.md, second.reports.html]) assert.match(await readFile(file, 'utf8'), /이 페이지가 noindex로 색인을 막고 있습니다/);
});

test('field CWV uses the key only in the request header and is replayed from stored evidence', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify({ record: { key: { origin: SITE }, metrics: {
      largest_contentful_paint: { percentiles: { p75: 2000 } }, interaction_to_next_paint: { percentiles: { p75: 150 } },
      cumulative_layout_shift: { percentiles: { p75: '0.05' } } } } }) };
  };
  const call = await firstCall({ extra: { fetchFn, env: { ...quietEnv(), OPTBREW_GOOGLE_API_KEY: KEY } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
  assert.ok(!calls[0].url.includes(KEY));
  const { judgmentsPath } = await judge(call);
  const second = await run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  const report = await readJson(second.reports.json);
  assert.deepEqual(['lcp-field', 'inp-field', 'cls-field'].map(id => report.baseline.input.observations.find(x => x.family_id === id).state), ['pass', 'pass', 'pass']);
  const cwv = report.evidence_index.filter(entry => entry.kind === 'cwv');
  assert.ok(cwv.length > 0 && cwv.every(entry => entry.source_ref === 'optbrew:collector'));
  for (const name of await files(call.ws.out)) {
    const file = path.join(call.ws.out, name);
    if (name.endsWith('.json') || name.endsWith('.md') || name.endsWith('.html')) assert.ok(!(await readFile(file, 'utf8')).includes(KEY), `${name} holds no key`);
  }
});

test('a real local site: collect, render when Chrome exists, judge and report', { timeout: 300000 }, async t => {
  const chrome = await findChrome({ env: process.env });
  const site = await startSite(Object.fromEntries(Object.entries(brewPages()).map(([route, page]) => [route, { headers: { 'content-type': page.type ?? 'text/html' }, body: page.body }])));
  t.after(() => site.close());
  const ws = await workspace(answersFor(`${site.origin}/`));
  // The shipped command refuses a loopback address, as preflight does; a test names the pair it may audit.
  const overrides = { env: { ...process.env, OPTBREW_GOOGLE_API_KEY: '' }, home: ws.home, localTargets: [{ host: '127.0.0.1', port: Number(new URL(site.origin).port) }] };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  assert.equal(first.status, 'awaiting_judgments');
  const index = await readJson(path.join(ws.out, 'evidence', 'evidence-index.json'));
  const context = await readJson(path.join(ws.out, 'context.json'));
  assert.equal(context.environment, 'local');
  assert.deepEqual(context.scope.local_targets, [{ host: '127.0.0.1', port: Number(new URL(site.origin).port) }]);
  assert.equal((index.cwv ?? []).length, 0, 'a local site has no public field data and is not sent to Google');
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const second = await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, overrides);
  assert.equal(second.status, 'done');
  const report = await readJson(second.reports.json);
  const render = report.baseline.input.observations.find(x => x.family_id === 'render-content');
  if (chrome?.path) {
    assert.equal(index.chrome.found, true);
    assert.ok(index.renders.length > 0, 'the fixed sample page was rendered');
    assert.notEqual(render.reason, 'chrome_missing');
    // Carry 10: the lab measure is a reference in the run result, never a verdict.
    assert.ok('lab_cwv' in second && Number.isFinite(second.lab_cwv.cls), 'lab CWV is reported as a reference');
    assert.ok(report.baseline.input.observations.filter(x => ['lcp-field', 'inp-field', 'cls-field'].includes(x.family_id)).every(x => x.state === 'unknown'));
  } else {
    assert.equal(render.reason, 'chrome_missing');
    t.diagnostic('no Chrome on this machine: the render assertions were skipped');
  }
});
