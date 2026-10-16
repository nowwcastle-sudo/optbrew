// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { answersFor, memorySite, passJudgments, quietEnv, SITE, workspace, zipOf } from './support/run-scenario.mjs';

const runScript = fileURLToPath(new URL('../skills/optbrew/scripts/run.mjs', import.meta.url));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const lastLine = text => text.trim().split('\n').at(-1);

/** The CLI in a child process, with no Chrome and an empty home. */
function cli(args, ws) {
  const env = { ...quietEnv(), HOME: ws.home, USERPROFILE: ws.home };
  // Not spawnSync: the site under test is served by this process, which must stay free to answer.
  return new Promise(resolve => {
    const child = spawn(process.execPath, [runScript, ...args], { env, windowsHide: true });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

test('the CLI prints one JSON line on success and one plain sentence on failure', async () => {
  // The first call runs in this process (the site is in memory); the second is a resume, which needs no network, so a child can run it.
  const call = async () => {
    const site = memorySite();
    const ws = await workspace(answersFor(`${SITE}/`));
    const first = await run({ answersPath: ws.answersPath, out: ws.out }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport });
    const judgmentsPath = path.join(ws.dir, 'judgments.json');
    await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
    return { site, ws, first, judgmentsPath };
  };
  const { ws, first, judgmentsPath } = await call();
  assert.deepEqual(Object.keys(first), ['status', 'judge_queue', 'queue_items']);
  const queue = await readJson(first.judge_queue);
  assert.ok(queue.pages.every(page => page.families.every(family => family.family_id && family.unit_key)), 'every unit names its family and unit_key');
  const second = await cli(['--answers', ws.answersPath, '--out', ws.out, '--judgments', judgmentsPath], ws);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim().split('\n').length, 1, 'stdout is one line');
  const done = JSON.parse(second.stdout);
  assert.deepEqual(done, { status: 'done', reports: { json: path.join(ws.out, 'report.json'), md: path.join(ws.out, 'report.md') }, score_input: path.join(ws.out, 'score-input.json') });
  for (const file of [done.reports.json, done.reports.md, done.score_input]) assert.ok((await readFile(file, 'utf8')).length > 0);
  const again = await cli(['--answers', ws.answersPath, '--out', ws.out, '--judgments', judgmentsPath], ws);
  assert.equal(again.code, 2);
  assert.equal(lastLine(again.stderr), 'This folder already holds a finished audit. Use a new --out folder for a new one.');

  const other = await call();
  const evidence = path.join(other.ws.out, 'evidence');
  await appendFile(path.join(evidence, (await readdir(evidence)).find(name => name.endsWith('.html'))), '<!-- edited -->');
  const requests = other.site.requests.length;
  const tampered = await cli(['--answers', other.ws.answersPath, '--out', other.ws.out, '--judgments', other.judgmentsPath], other.ws);
  assert.equal(tampered.code, 2);
  assert.match(lastLine(tampered.stderr), /^index changed: /);
  assert.equal(other.site.requests.length, requests, 'the stopped resume collected nothing');

  const missing = await cli(['--answers', path.join(ws.dir, 'nope.json'), '--out', path.join(ws.dir, 'o2')], ws);
  assert.equal(missing.code, 2);
  assert.equal(lastLine(missing.stderr), `The answers file cannot be read as JSON: ${path.join(ws.dir, 'nope.json')}`);
  assert.equal((await cli([], ws)).code, 2);
  assert.match(lastLine((await cli(['--answers'], ws)).stderr), /^usage: /);
});

test('the judgments file is one bare array, handed to the merge as it is', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const wrapped = path.join(ws.dir, 'wrapped.json');
  await writeFile(wrapped, JSON.stringify({ judgments: passJudgments(await readJson(first.judge_queue)) }));
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath: wrapped }, overrides), /one JSON array/);
  const bad = path.join(ws.dir, 'bad.json');
  await writeFile(bad, '{ nope');
  await assert.rejects(run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath: bad }, overrides), /judgments file cannot be read as JSON/);
});

const GSC = 'Date,Clicks,Impressions,CTR,Position\n2026-09-01,10,200,5%,3.1\n2026-09-02,20,300,6.7%,2.9\n';
const NAVER = '기간 2026.09.01 ~ 2026.09.28\n검색 키워드\t클릭수\t노출수\n브루\t30\t400\n카페\t12\t150\n';

async function withExports(exports, files) {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(ws.dir, name), bytes);
  const answersPath = path.join(ws.dir, 'with-exports.json');
  await writeFile(answersPath, JSON.stringify(answersFor(`${SITE}/`, { owner_exports: exports.map(x => ({ kind: x.kind, path: path.join(ws.dir, x.file) })) })));
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath, out: ws.out }, overrides);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readJson(first.judge_queue))));
  const second = await run({ answersPath, out: ws.out, judgmentsPath }, overrides);
  return { ws, report: await readJson(second.reports.json), index: await readJson(path.join(ws.out, 'evidence', 'evidence-index.json')) };
}

test('owner exports: a Search Console zip and a pasted Naver table become replayed metrics', async () => {
  const { report, index } = await withExports([{ kind: 'gsc', file: 'gsc.zip' }, { kind: 'naver', file: 'naver.txt' }],
    { 'gsc.zip': zipOf({ 'Queries.csv': 'Query,Clicks\nbrew,1\n', 'Dates.csv': GSC }), 'naver.txt': NAVER });
  const value = id => report.metrics.find(metric => metric.metric_id === id);
  assert.equal(value('gsc:clicks').value, 30);
  assert.equal(value('gsc:impressions').value, 500);
  assert.equal(value('gsc:ctr').numerator, 30);
  assert.deepEqual(value('gsc:clicks').window, { start: '2026-09-01', end: '2026-09-02', timezone: 'America/Los_Angeles' });
  assert.equal(value('naver:clicks').value, 42);
  assert.equal(value('naver:clicks').sample_selection.kind, 'unknown', 'a pasted top-N table is not the whole site');
  assert.deepEqual(index.owner_exports.map(entry => [entry.kind, entry.status]), [['gsc', 'read'], ['naver', 'read']]);
  assert.ok(report.evidence_index.some(entry => entry.kind === 'native_export' && entry.source_ref === 'optbrew:owner-export'));
  assert.equal(report.remaining.filter(row => row.reason.startsWith('export_')).length, 0, 'usable exports leave no remaining row');
});

test('owner exports: a missing or unreadable file is an unknown with a reason, never a crash', async () => {
  const { report, index } = await withExports([{ kind: 'gsc', file: 'gone.zip' }, { kind: 'naver', file: 'junk.txt' }],
    { 'junk.txt': '기간 2026.09.01 ~ 2026.09.28\n표가 없는 글' });
  assert.deepEqual(index.owner_exports.map(entry => [entry.kind, entry.status, entry.reason]),
    [['gsc', 'unusable', 'export_file_missing'], ['naver', 'unusable', 'export_table_not_found']]);
  assert.equal(report.metrics.length, 0);
  const gaps = report.remaining.filter(row => row.reason.startsWith('export_'));
  assert.deepEqual(gaps.map(row => row.reason), ['export_file_missing', 'export_table_not_found']);
  assert.match(gaps[0].problem, /No file was found/);
  const damaged = await withExports([{ kind: 'gsc', file: 'bad.zip' }], { 'bad.zip': Buffer.from('not a zip at all') });
  assert.equal(damaged.index.owner_exports[0].reason, 'export_not_a_zip');
  assert.equal(damaged.report.remaining.filter(row => row.reason.startsWith('export_')).length, 1);
});

test('--out may already hold preflight/ and the answers file; the queue file is pretty-printed', async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  await mkdir(path.join(ws.out, 'preflight', 'evidence'), { recursive: true });
  const start = JSON.stringify({ probe: answersFor(`${SITE}/`).probe, sitemap_pages: null });
  await writeFile(path.join(ws.out, 'preflight', 'start.json'), start);
  await writeFile(path.join(ws.out, 'intake-answers.json'), JSON.stringify(answersFor(`${SITE}/`)));
  const first = await run({ answersPath: path.join(ws.out, 'intake-answers.json'), out: ws.out }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport });
  assert.equal(first.status, 'awaiting_judgments');
  assert.equal(await readFile(path.join(ws.out, 'preflight', 'start.json'), 'utf8'), start, 'the preflight output is left as it was');
  const text = await readFile(first.judge_queue, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, 'two-space indent, one trailing newline');
  assert.ok(text.split('\n').length > 10, 'one value per line, not a single line');
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(JSON.parse(text))));
  const second = await run({ answersPath: path.join(ws.out, 'intake-answers.json'), out: ws.out, judgmentsPath }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport });
  assert.equal(second.status, 'done');
  assert.equal(await readFile(path.join(ws.out, 'preflight', 'start.json'), 'utf8'), start);
});
