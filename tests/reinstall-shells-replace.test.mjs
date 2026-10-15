import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { doctor } from '../lib/doctor.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { agents, currentManifest, runBlock, sandbox, shells } from './support/reinstall-shells.mjs';
import { releasePublished, skipUnreachable } from './support/published.mjs';

after(releasePublished);

// The documented blocks, run literally in every available shell against a published 0.1.2 install.
describe('documented reinstall blocks replace a published 0.1.2 install and keep runs', { concurrency: 5 }, () => {
  // One user-scope run with copy targets in every shell, one project-scope run with a link and a copy target in each.
  for (const { shell, command } of shells) for (const [scope, mixed] of [['user', false], ['project', true]]) {
    it(`${shell} (${command}, ${scope} scope, ${mixed ? 'link+copy' : 'copy'})`, { skip: skipUnreachable }, async t => {
      const strategies = mixed ? { codex: 'copy', 'claude-code': 'link' } : { codex: 'copy', 'claude-code': 'copy' };
      const f = await sandbox(t, { scope, strategies });
      const next = await currentManifest();
      const run = await runBlock({ shell, command, scope, f });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const record = await readInstallRecord(f.recordRoot);
      assert.equal(record.release_version, '0.1.3');
      assert.equal(record.bundle_hash, next.bundle_hash);
      assert.equal(record.transaction.state, 'committed');
      assert.deepEqual(record.targets.map(x => [x.agent, x.strategy]), agents.map(a => [a, strategies[a]]));
      const report = await doctor({ agents, ...f.where });
      assert.ok(report.targets.length === 2 && report.targets.every(x => x.registered && x.hash_ok), JSON.stringify(report));
      assert.match(run.stdout, /"hash_ok":true/);
      assert.equal(await readFile(path.join(f.scopeRoot, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
    });
  }
});
