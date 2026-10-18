import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './support/temp-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/check-skips.mjs');

/** One phase as the spec reporter prints it: its skipped tests, then its summary. */
const phase = (...reasons) => [
  '✔ a passing test (1.2ms)',
  ...reasons.map(reason => `﹣ a skipped test (0.3ms) # ${reason}`),
  'ℹ tests 3', 'ℹ suites 0', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0', `ℹ skipped ${reasons.length}`, 'ℹ todo 0', 'ℹ duration_ms 4.5', ''].join('\n');

const BY_DESIGN = ['maintainer-only: upstream source mirror not found; set OPTBREW_SOURCES_ROOT to the mirror directory',
  'Windows has no POSIX modes',
  'skill files are CRLF in this checkout (core.autocrlf=true); release artifacts are built from a core.autocrlf=false clone'];

async function check(t, log) {
  const dir = await tempDir('optbrew-check-skips-');
  const file = path.join(dir, 'test.log');
  await writeFile(file, log);
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(run.error, undefined);
  return run;
}

test('the by-design skips of the other files pass, with the counts printed', async t => {
  const run = await check(t, `${phase(...BY_DESIGN)}${phase()}`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /skipped per phase \(other files, Chrome files\): 3, 0/);
  assert.match(run.stdout, /skip reason: Windows has no POSIX modes/);
  assert.equal((await check(t, `${phase()}${phase()}`)).status, 0, 'no skips at all passes');
  assert.equal((await check(t, `${phase(...BY_DESIGN).replaceAll('\n', '\r\n')}${phase().replaceAll('\n', '\r\n')}`)).status, 0, 'CRLF log lines read the same');
});

test('a skip for a reason outside the list fails', async t => {
  for (const reason of ['no Chrome found on this machine (set OPTBREW_CHROME)', 'published 0.1.3 tag is not in this clone', 'SKIP', 'not a git checkout']) {
    const run = await check(t, `${phase(BY_DESIGN[1], reason)}${phase()}`);
    assert.equal(run.status, 1, reason);
    assert.match(run.stderr, new RegExp(`unexpected reason: ${reason.replace(/[()]/g, '.')}`));
  }
});

test('a skipped Chrome test fails whatever its reason', async t => {
  const run = await check(t, `${phase()}${phase(BY_DESIGN[0])}`);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /a Chrome test was skipped \(1\)/);
});

test('a log that does not have two phases, or whose lines and summary disagree, fails instead of passing unread', async t => {
  assert.match((await check(t, phase())).stderr, /expected 2 phase summaries, found 1/);
  assert.match((await check(t, '')).stderr, /expected 2 phase summaries, found 0/);
  const drifted = `${phase(BY_DESIGN[1]).replace('# Windows has no POSIX modes', '')}${phase()}`;
  const run = await check(t, drifted);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /says 1 skipped but the log lists 0/);
});

test('the parser reads what node --test really prints for a skipped test', async t => {
  const dir = await tempDir('optbrew-check-skips-real-');
  const sample = path.join(dir, 'sample.test.mjs');
  await writeFile(sample, "import test from 'node:test';\ntest('kept', () => {});\n" +
    "test('skipped', { skip: 'Windows has no POSIX modes' }, () => {});\ntest('skipped for another reason', { skip: 'because' }, () => {});\n");
  // Run from inside a test, a child would report to this runner instead of printing its own summary.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const printed = () => spawnSync(process.execPath, ['--test', '--test-reporter=spec', sample], { encoding: 'utf8', env }).stdout;
  const allowed = await check(t, `${printed().replace(/.*because.*\n/, '').replace('skipped 2', 'skipped 1')}${phase()}`);
  assert.equal(allowed.status, 0, allowed.stderr);
  const refused = await check(t, `${printed()}${phase()}`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unexpected reason: because/);
});
