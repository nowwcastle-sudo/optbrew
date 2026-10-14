import assert from 'node:assert/strict';
import { test, after, describe, it } from 'node:test';
import { main } from '../lib/cli.mjs';
import { documented, documentedBlocks, sandbox, tamperRecord, assertNothingDeleted } from './support/reinstall-shells.mjs';
import { releasePublished, root, skipUnreachable } from './support/published-011.mjs';

after(releasePublished);

test('the reinstall command blocks are identical in docs/platforms.md, README.md and README.ko.md', async () => {
  assert.deepEqual(Object.keys(documented).sort(), ['bash project', 'bash user', 'powershell project', 'powershell user']);
  for (const file of ['README.md', 'README.ko.md']) assert.deepEqual(await documentedBlocks(file), documented, file);
});

test('the documented blocks delete only what the validated plan prints and never resolve the home or read the record themselves', () => {
  for (const [name, block] of Object.entries(documented)) {
    assert.match(block, /reinstall-plan/, `${name} asks the node CLI for the validated plan`);
    assert.doesNotMatch(block, /\$HOME|\$env:|USERPROFILE|~\//, `${name} does not resolve the home directory itself`);
    assert.doesNotMatch(block, /install-record\.json|ConvertFrom-Json/, `${name} does not read the install record itself`);
    assert.ok(block.indexOf('reinstall-plan') < block.search(/Remove-Item|rm -r/), `${name} validates before it deletes`);
  }
});

// T1-T6 against the plan command itself, in process: a tampered install record is refused before anything could be deleted.
describe('reinstall-plan refuses a tampered install record before anything could be deleted', { concurrency: 6 }, () => {
  for (const name of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']) {
    it(`${name}`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      const v = await tamperRecord(t, f, name);
      let out = '', err = '';
      const code = await main(['reinstall-plan', '--scope', 'project', '--project', f.project], { cwd: root, stdout: { write: s => out += s }, stderr: { write: s => err += s } });
      assert.equal(code, 1);
      assert.equal(out, '', 'a refused plan prints nothing to delete');
      assert.match(err, /^reinstall plan refused: /);
      if (['T7', 'T8', 'T9'].includes(name)) assert.match(err, /control character/, 'a path with a line break, tab or control character is named as such');
      await assertNothingDeleted(f, v);
    });
  }
  it('an untouched record prints the targets first, the managed root last, then the installs and the doctor agents', { skip: skipUnreachable }, async t => {
    const f = await sandbox(t, { strategies: { codex: 'copy', 'claude-code': 'link' } });
    let out = '';
    const code = await main(['reinstall-plan', '--scope', 'project', '--project', f.project], { cwd: root, stdout: { write: s => out += s }, stderr: { write() {} } });
    assert.equal(code, 0);
    const rows = out.trimEnd().split('\n').map(line => line.split('\t'));
    assert.deepEqual(rows, [['delete-dir', f.targets[0].path], ['delete-link', f.targets[1].path], ['delete-dir', f.recordRoot],
      ['install', 'codex', 'copy'], ['install', 'claude-code', 'link'], ['agents', 'codex,claude-code']]);
  });
});
