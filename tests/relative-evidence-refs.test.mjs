// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { readPreflight } from '../skills/optbrew/scripts/core/page-select.mjs';
import { stages } from '../skills/optbrew/scripts/core/stages.mjs';
import { answersFor, memorySite, passJudgments, preflightOf, quietEnv, readQueue, SITE, workspace } from './support/run-scenario.mjs';
import { tempDir } from './support/temp-dir.mjs';

const cli = path.resolve('skills/optbrew/scripts/cli.mjs');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

/** The report packet of a run, kept in the run folder as `packet.json` (a run does not keep it itself) with its evidence root written as `.`. */
const keepPacket = { name: 'keep-packet', run: async state => {
  await writeFile(path.join(state.out, 'packet.json'), JSON.stringify({ ...state.packet, evidence_root: '.' }));
  return { state };
} };

/** One finished audit of the in-memory site, with its preflight read. */
async function finishedAudit() {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, ws.out);
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, stages: [...stages(), keepPacket] };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const queue = await readQueue(first);
  const judgments = path.join(ws.dir, 'judgments.json');
  await writeFile(judgments, JSON.stringify(passJudgments(queue)));
  const done = await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath: judgments }, overrides);
  assert.equal(done.status, 'done');
  return ws;
}

const replay = (packet, outputDir) => spawnSync(process.execPath, [cli, 'report', '--input', packet, '--output-dir', outputDir], { encoding: 'utf8' });

test('a run folder moved to another path still replays its report', { timeout: 120000 }, async () => {
  const ws = await finishedAudit();
  const packet = await readJson(path.join(ws.out, 'packet.json'));
  assert.ok(packet.evidence_index.every(entry => !path.isAbsolute(entry.ref)), 'the evidence list names files relative to the run folder');
  assert.equal(replay(path.join(ws.out, 'packet.json'), path.join(ws.dir, 'replayed-here')).status, 0, 'the same folder replays as before');
  const moved = path.join(await tempDir('optbrew-moved-'), 'elsewhere');
  await cp(ws.out, moved, { recursive: true });
  await rm(ws.out, { recursive: true, force: true });
  const result = replay(path.join(moved, 'packet.json'), path.join(moved, 'replayed'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(moved, 'replayed', 'report.md'), 'utf8'), /Brew/);
});

test('a preflight folder moved into a new run folder is still read', { timeout: 120000 }, async () => {
  const site = memorySite();
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, ws.out);
  assert.equal((await readPreflight(ws.out, `${SITE}/`)).status, 'read');
  const next = path.join(ws.dir, 'out-after');
  await mkdir(next);
  await cp(path.join(ws.out, 'preflight'), path.join(next, 'preflight'), { recursive: true });
  await rm(path.join(ws.out, 'preflight'), { recursive: true, force: true });
  const found = await readPreflight(next, `${SITE}/`);
  assert.equal(found.status, 'read', 'the earlier folder is gone and the copy still reads');
  assert.ok(found.pageLinks.length > 0);
});

test('a store with a root writes refs relative to it and reads both forms', async () => {
  const root = await tempDir('optbrew-root-');
  const dir = path.join(root, 'evidence');
  await mkdir(dir);
  const store = openStore(dir, { run_id: 'relative' }, { root });
  const { ref, sha256 } = await store.write('html', '<p>x</p>');
  assert.equal(ref, `evidence/${sha256}.html`);
  assert.equal((await store.read(ref, sha256)).toString(), '<p>x</p>');
  assert.equal((await store.read(path.join(dir, `${sha256}.html`), sha256)).toString(), '<p>x</p>', 'an absolute path an older run wrote is still read');
  await assert.rejects(store.read('../outside.html', sha256), /outside run directory/);
});
