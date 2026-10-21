import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { finishChange, startChange } from '../skills/optbrew/scripts/core/changes.mjs';
import { runCli } from '../skills/optbrew/scripts/cli.mjs';
import { tempDir } from './support/temp-dir.mjs';

const cli = path.resolve('skills/optbrew/scripts/cli.mjs');
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const ORIGINAL = '<html><head></head><body>원본</body></html>\n';
const FIXED = '<html><head><title>고침</title></head><body>원본</body></html>\n';

/** A source folder with two pages and a file beside it that is not part of the site, and an empty result folder path. */
async function workspace() {
  // The record names real paths, so the folder the test builds is a real path too (a temp folder can be reached through a link or a short name; only the native realpath expands a Windows 8.3 name).
  const dir = realpathSync.native(await tempDir('optbrew change '));
  const root = path.join(dir, 'site');
  mkdirSync(path.join(root, 'pages'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), ORIGINAL);
  writeFileSync(path.join(root, 'pages', 'about.html'), ORIGINAL);
  writeFileSync(path.join(dir, 'secret.txt'), 'outside\n');
  return { dir, root, out: path.join(dir, 'out'), page: path.join(root, 'index.html'), about: path.join(root, 'pages', 'about.html') };
}
const start = (ws, file, ...findings) => run(['change', 'start', '--out', ws.out, '--root', ws.root, '--path', file, ...findings.flatMap(id => ['--finding', id])]);
const finish = (ws, file, ...rest) => run(['change', 'finish', '--out', ws.out, '--path', file, ...rest]);
const lastJson = result => JSON.parse(result.stdout.trim().split('\n').at(-1));
const lastLine = text => text.trim().split('\n').at(-1);

test('start backs the file up once and notes the change; finish writes the complete record and removes the note', async () => {
  const ws = await workspace();
  const started = start(ws, 'index.html', 'f1', 'f2');
  assert.equal(started.status, 0, started.stderr);
  const backup = path.join(ws.out, 'changes', 'backup', 'c1-index.html');
  assert.deepEqual(lastJson(started), { change_id: 'c1', path: ws.page, backup_ref: backup, before_hash: sha256(ORIGINAL), finding_ids: ['f1', 'f2'] });
  assert.equal(readFileSync(backup, 'utf8'), ORIGINAL, 'the backup holds the bytes the file had');
  const pending = json(path.join(ws.out, 'changes', 'pending', 'c1.json'));
  assert.equal(pending.before_hash, sha256(ORIGINAL));
  assert.deepEqual(pending.finding_ids, ['f1', 'f2']);
  assert.equal(existsSync(path.join(ws.out, 'changes', 'c1.json')), false, 'no complete record before finish');

  writeFileSync(ws.page, FIXED);
  const finished = finish(ws, 'index.html', '--tool', 'graft', '--query', 'where is the head built');
  assert.equal(finished.status, 0, finished.stderr);
  const record = json(path.join(ws.out, 'changes', 'c1.json'));
  assert.deepEqual(lastJson(finished), record, 'the command prints the record it wrote');
  assert.deepEqual(record, { schema_version: '2.0.0', change_id: 'c1', finding_ids: ['f1', 'f2'], environment: 'local', path: ws.page,
    before_hash: sha256(ORIGINAL), after_hash: sha256(FIXED), backup_ref: backup, verification: { status: 'pending', note: '배포 전이라 아직 확인하지 않음' },
    evidence_ref: ws.page, analysis: { tools: ['graft'], queries: ['where is the head built'], self_analysis: false } });
  assert.equal(validateEntity('ChangeRecord', record), record, 'the record passes the contract schema');
  assert.equal(existsSync(path.join(ws.out, 'changes', 'pending', 'c1.json')), false, 'the note is gone');
  assert.equal(readFileSync(backup, 'utf8'), ORIGINAL, 'finish leaves the backup as it was');
});

test('a second start for a file with a pending or a finished record is refused, and nothing new is written', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  const files = () => readdirSync(path.join(ws.out, 'changes'), { recursive: true }).sort();
  const before = files();
  for (const form of ['index.html', ws.page, './pages/../index.html']) {
    const again = start(ws, form, 'f1');
    assert.equal(again.status, 1);
    assert.match(lastLine(again.stderr), /c1 is already started for .*; run change finish first/);
  }
  assert.deepEqual(files(), before, 'a refused start copies nothing and notes nothing');
  writeFileSync(ws.page, FIXED);
  assert.equal(finish(ws, 'index.html').status, 0);
  const third = start(ws, 'index.html', 'f9');
  assert.equal(third.status, 1);
  assert.match(lastLine(third.stderr), /c1 already holds the change record of index\.html; a result folder has one record per file/);
  assert.deepEqual(readdirSync(path.join(ws.out, 'changes', 'backup')), ['c1-index.html']);
});

test('finish refuses a file that is unchanged, keeps the note, and works once the file is changed', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  const unchanged = finish(ws, 'index.html');
  assert.equal(unchanged.status, 1);
  assert.match(lastLine(unchanged.stderr), /index\.html is unchanged since change start \(c1\)/);
  assert.equal(existsSync(path.join(ws.out, 'changes', 'c1.json')), false);
  assert.equal(existsSync(path.join(ws.out, 'changes', 'pending', 'c1.json')), true);
  // Writing the same bytes again is still no change.
  writeFileSync(ws.page, ORIGINAL);
  assert.equal(finish(ws, 'index.html').status, 1);
  writeFileSync(ws.page, FIXED);
  assert.equal(finish(ws, 'index.html').status, 0);
  assert.equal(json(path.join(ws.out, 'changes', 'c1.json')).after_hash, sha256(FIXED));
});

test('finish with no start, or after the change is finished, says what to do', async () => {
  const ws = await workspace();
  const none = finish(ws, 'index.html');
  assert.equal(none.status, 1);
  assert.match(lastLine(none.stderr), /no change was started for index\.html; run change start first/);
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  writeFileSync(ws.page, FIXED);
  assert.equal(finish(ws, 'index.html').status, 0);
  assert.equal(finish(ws, 'index.html').status, 1, 'a finished change is not finished a second time');
  // Another file of the folder has no start either.
  assert.match(lastLine(finish(ws, 'pages/about.html').stderr), /no change was started for pages\/about\.html/);
});

test('a path outside the source folder is refused: .. , an absolute path, a link to a file and a link to a folder', async () => {
  const ws = await workspace();
  const refused = file => {
    const result = start(ws, file, 'f1');
    assert.equal(result.status, 1, file);
    assert.match(lastLine(result.stderr), /path is outside the source folder|file not found/, file);
  };
  refused('../secret.txt');
  refused('pages/../../secret.txt');
  refused(path.join(ws.dir, 'secret.txt'));
  const links = [['to-secret.html', path.join(ws.dir, 'secret.txt')], ['to-outside', ws.dir]];
  let linked = true;
  try { for (const [name, target] of links) symlinkSync(target, path.join(ws.root, name)); } catch (error) { if (error.code !== 'EPERM') throw error; linked = false; }
  if (linked) { refused('to-secret.html'); refused('to-outside/secret.txt'); }
  // The root itself and a folder are not files to change.
  for (const file of ['.', 'pages']) assert.match(lastLine(start(ws, file, 'f1').stderr), /path is outside the source folder|not a file/);
  assert.equal(existsSync(path.join(ws.out, 'changes')), false, 'a refused start leaves the result folder untouched');
  const missing = start(ws, 'nope.html', 'f1');
  assert.match(lastLine(missing.stderr), /file not found: nope\.html/);
  const noRoot = run(['change', 'start', '--out', ws.out, '--root', path.join(ws.dir, 'missing'), '--path', 'index.html', '--finding', 'f1']);
  assert.match(lastLine(noRoot.stderr), /source folder not found/);
});

test('a link inside the folder that leads to another file inside it is the same file', async () => {
  const ws = await workspace();
  try { symlinkSync(ws.page, path.join(ws.root, 'home.html')); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal(start(ws, 'home.html', 'f1').status, 0);
  assert.equal(json(path.join(ws.out, 'changes', 'pending', 'c1.json')).path, ws.page, 'the record names the real file');
  assert.match(lastLine(start(ws, 'index.html', 'f1').stderr), /c1 is already started/);
});

test('change ids count up from the records, notes and backups that exist; analysis defaults follow the tools named', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  assert.equal(lastJson(start(ws, 'pages/about.html', 'f2')).change_id, 'c2');
  writeFileSync(ws.page, FIXED);
  writeFileSync(ws.about, FIXED);
  assert.equal(finish(ws, 'index.html').status, 0);
  assert.deepEqual(json(path.join(ws.out, 'changes', 'c1.json')).analysis, { tools: [], queries: [], self_analysis: true }, 'no tool named: the code was read directly');
  const second = finish(ws, 'pages/about.html', '--tool', 'graft', '--tool', ' graft ', '--tool', 'understand-anything', '--self-analysis');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(json(path.join(ws.out, 'changes', 'c2.json')).analysis, { tools: ['graft', 'understand-anything'], queries: [], self_analysis: true }, 'the flag says the code was also read');
  // A backup left by a stop before the note was written is not taken again.
  mkdirSync(path.join(ws.out, 'changes', 'backup'), { recursive: true });
  writeFileSync(path.join(ws.out, 'changes', 'backup', 'c7-old.html'), 'x');
  writeFileSync(path.join(ws.root, 'third.html'), ORIGINAL);
  assert.equal(lastJson(start(ws, 'third.html', 'f3')).change_id, 'c8');
});

test('finish reads a relative path from the source folder of the start, wherever the command runs', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'pages/about.html', 'f1').status, 0);
  writeFileSync(ws.about, FIXED);
  const elsewhere = await tempDir('optbrew change cwd ');
  const finished = run(['change', 'finish', '--out', ws.out, '--path', 'pages/about.html', '--query', 'q', '--query', 'q', '--query', 'r'], { cwd: elsewhere });
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(json(path.join(ws.out, 'changes', 'c1.json')).analysis.queries, ['q', 'r']);
  // The absolute path names the same file.
  assert.equal(start(ws, 'index.html', 'f2').status, 0);
  writeFileSync(ws.page, FIXED);
  assert.equal(finish(ws, ws.page).status, 0);
});

test('finish refuses when the backup is gone or no longer holds the bytes the start hashed', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  writeFileSync(ws.page, FIXED);
  const backup = path.join(ws.out, 'changes', 'backup', 'c1-index.html');
  writeFileSync(backup, 'tampered');
  assert.match(lastLine(finish(ws, 'index.html').stderr), /the backup of index\.html is missing or changed/);
  rmSync(backup);
  assert.match(lastLine(finish(ws, 'index.html').stderr), /the backup of index\.html is missing or changed/);
  assert.equal(existsSync(path.join(ws.out, 'changes', 'c1.json')), false);
});

test('finish run again after a stop between its two writes removes the note and gives the same record', async () => {
  const ws = await workspace();
  await startChange({ out: ws.out, root: ws.root, file: 'index.html', findings: ['f1'] });
  const notePath = path.join(ws.out, 'changes', 'pending', 'c1.json');
  const note = readFileSync(notePath, 'utf8');
  writeFileSync(ws.page, FIXED);
  const first = await finishChange({ out: ws.out, file: 'index.html', tools: ['graft'] });
  // The stop: the complete record was written, the note was not removed.
  writeFileSync(notePath, note);
  const again = await finishChange({ out: ws.out, file: 'index.html', tools: ['other'] });
  assert.deepEqual(again, first, 'the record already written stands');
  assert.equal(existsSync(notePath), false);
  // The file changed once more before the retry: the record would no longer describe it.
  writeFileSync(notePath, note);
  writeFileSync(ws.page, `${FIXED}<!-- more -->\n`);
  await assert.rejects(finishChange({ out: ws.out, file: 'index.html' }), /c1 was already finished with other bytes/);
  assert.deepEqual(json(path.join(ws.out, 'changes', 'c1.json')), first);
});

test('start needs a finding id, and the record keeps each id once', async () => {
  const ws = await workspace();
  await assert.rejects(startChange({ out: ws.out, root: ws.root, file: 'index.html', findings: [] }), /give at least one finding id/);
  await assert.rejects(startChange({ out: ws.out, root: ws.root, file: 'index.html', findings: ['  '] }), /give at least one finding id/);
  assert.deepEqual((await startChange({ out: ws.out, root: ws.root, file: 'index.html', findings: ['f2', ' f1', 'f2'] })).finding_ids, ['f2', 'f1']);
});

test('the command line takes the options of each command, and anything else is the usage line', async () => {
  const expectUsage = argv => assert.rejects(runCli(argv), error => error.message.startsWith('usage: cli.mjs score --input') && !/\n/.test(error.message), JSON.stringify(argv));
  const ws = await workspace();
  const bad = [[], ['nope'], ['__proto__'], ['constructor'], ['change'], ['change', 'nope'], ['change', 'start'], ['change', 'finish'],
    ['score'], ['score', '--input', 'a'], ['score', '--input', 'a', '--output'], ['score', '--input', 'a', '--output', ''], ['score', '--input', '', '--output', 'b'],
    ['score', '--input', 'a', '--output', 'b', '--output', 'c'], ['score', '--input', 'a', '--output', 'b', 'extra'], ['score', '--input', 'a', '--output', 'b', '--other', 'x'],
    ['score', 'extra', '--input', 'a', '--output', 'b'], ['compare', '--before', 'a', '--after', 'b'], ['report', '--input', 'a'], ['report', '--output-dir', 'a'],
    ['runbook', '--ids', 'a'], ['runbook', '--ids', 'a', '--level', ''],
    ['change', 'start', '--out', ws.out, '--root', ws.root, '--path', 'index.html'],
    ['change', 'start', '--out', ws.out, '--root', ws.root, '--path', 'index.html', '--finding', ''],
    ['change', 'start', '--out', ws.out, '--root', ws.root, '--path', 'index.html', '--path', 'x', '--finding', 'f1'],
    ['change', 'finish', '--out', ws.out], ['change', 'finish', '--path', 'index.html'],
    ['change', 'finish', '--out', ws.out, '--path', 'index.html', '--self-analysis=yes'], ['change', 'finish', '--out', ws.out, '--path', 'index.html', '--tool']];
  for (const argv of bad) await expectUsage(argv);
  assert.equal(existsSync(ws.out), false, 'a refused command line writes nothing');
});

test('score and compare still run from the command line as before', async () => {
  const ws = await workspace();
  const scored = run(['score', '--input', 'tests/fixtures/scoring/partial.json', '--output', path.join(ws.dir, 'nested', 'score.json')]);
  assert.equal(scored.status, 0, scored.stderr);
  assert.ok(Array.isArray(json(path.join(ws.dir, 'nested', 'score.json'))));
  const compared = run(['compare', '--before', 'tests/fixtures/scoring/before.json', '--after', 'tests/fixtures/scoring/after.json', '--output', path.join(ws.dir, 'compare.json')]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(json(path.join(ws.dir, 'compare.json')).status, 'comparable');
  const unknown = run(['score', '--input', 'tests/fixtures/scoring/partial.json']);
  assert.equal(unknown.status, 1);
  assert.match(lastLine(unknown.stderr), /^Error: usage: cli\.mjs score --input/);
});

test('a pending record that was damaged is named, not guessed at', async () => {
  const ws = await workspace();
  assert.equal(start(ws, 'index.html', 'f1').status, 0);
  const note = path.join(ws.out, 'changes', 'pending', 'c1.json');
  writeFileSync(ws.page, FIXED);
  for (const damaged of ['not json', JSON.stringify({ change_id: 'c1' }), JSON.stringify({ ...json(note), before_hash: 'abc' })]) {
    const original = readFileSync(note, 'utf8');
    writeFileSync(note, damaged);
    assert.match(lastLine(finish(ws, 'index.html').stderr), /change record (is damaged|cannot be read): /);
    assert.match(lastLine(start(ws, 'pages/about.html', 'f2').stderr), /change record (is damaged|cannot be read): /);
    writeFileSync(note, original);
  }
  assert.equal(finish(ws, 'index.html').status, 0, 'the intact note finishes');
});
