import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { doctor } from '../lib/doctor.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { agents, assertNothingDeleted, runBlock, sandbox, shellNamed, shells, tamperRecord } from './support/reinstall-shells.mjs';
import { releasePublished, skipUnreachable } from './support/published-011.mjs';

after(releasePublished);

describe('documented reinstall blocks refuse tampering, follow the CLI home and can be repeated', { concurrency: 5 }, () => {
  // T1 (an absolute path outside the project) in every shell; T6 (a junction that no longer leads to the managed bundle) in each PowerShell edition and bash.
  for (const { shell, command } of shells) for (const name of ['T1', 'T6']) {
    if (name === 'T6' && command === 'powershell') continue;
    it(`${shell} (${command}) deletes nothing for a tampered record: ${name}`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      const v = await tamperRecord(t, f, name);
      const run = await runBlock({ shell, command, scope: 'project', f });
      assert.notEqual(run.status, 0, `the block must fail\n${run.stdout}\n${run.stderr}`);
      await assertNothingDeleted(f, v);
      assert.match(`${run.stdout}${run.stderr}`, /reinstall plan refused/);
    });
  }

  for (const { shell, command } of shells) {
    // A decoy home with its own record: a block that trusted USERPROFILE (or the shell's $HOME) would act on it.
    if (command !== 'powershell') it(`${shell} (${command}) uses the home directory the node CLI uses, whatever USERPROFILE says`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t, { scope: 'user' });
      const decoy = path.join(f.temp, 'decoy');
      await mkdir(path.join(decoy, '.optbrew/installs/user'), { recursive: true });
      await writeFile(path.join(decoy, '.optbrew/installs/user/install-record.json'), '{}');
      const run = await runBlock({ shell, command, scope: 'user', f, env: { HOME: f.home, USERPROFILE: decoy } });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
      assert.equal(await readFile(path.join(decoy, '.optbrew/installs/user/install-record.json'), 'utf8'), '{}', 'the decoy is untouched');
    });
    // PowerShell leaves the environment alone, so node falls back to USERPROFILE. (Git Bash would invent a HOME of its own.)
    if (process.platform === 'win32' && shell === 'powershell' && command === 'pwsh') it(`${shell} (${command}) follows USERPROFILE when HOME is not set, as the node CLI does`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t, { scope: 'user' });
      const run = await runBlock({ shell, command, scope: 'user', f, env: { HOME: undefined, USERPROFILE: f.home } });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
    });
  }

  for (const { shell, command } of [...shellNamed('powershell', 'pwsh'), ...shellNamed('bash')]) {
    it(`${shell} (${command}) can be run again after a partial failure`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      // The first run got as far as deleting the first target and then stopped; the record and the second target remain.
      await rm(f.targets[0].path, { recursive: true, force: true });
      const run = await runBlock({ shell, command, scope: 'project', f });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const report = await doctor({ agents, ...f.where });
      assert.ok(report.targets.every(x => x.registered && x.hash_ok), JSON.stringify(report));
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
      assert.equal(await readFile(path.join(f.project, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
    });
  }
});
