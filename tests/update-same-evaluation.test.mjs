import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { update } from '../lib/update.mjs';
import { install } from '../lib/install.mjs';
import { doctor } from '../lib/doctor.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { isSameEvaluationText } from '../lib/evaluation-equivalence.mjs';
import { fileDigest, isDistributedBundlePath } from '../skills/optbrew/scripts/core/bundle.mjs';
import { versions } from '../skills/optbrew/scripts/core/config.mjs';
import { seal } from './fixtures/releases/create.mjs';
import { tempDir } from './support/temp-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentBundle = path.join(root, 'skills', 'optbrew');
const sameEvaluationText = JSON.parse(await readFile(path.join(root, 'lib/evaluation-equivalence.json'), 'utf8'));
const before = path.join(root, 'tests/fixtures/evaluation-0.6.0-before-docs-fix');
// The bundle_hash that release 0.4.0 (commit e6bd804) published. It proves the fixture below is that release byte for byte.
const published040 = '97358d424ea7f31110fec6c845cd6b8fcfaebe867b10bb2fd5cff9115307bac8';

async function copyCurrent(destination) {
  await cp(currentBundle, destination, { recursive: true, filter: p => isDistributedBundlePath(path.relative(currentBundle, p)) });
}
const manifestOf = async dir => JSON.parse(await readFile(path.join(dir, 'bundle-manifest.json'), 'utf8'));

/** A managed install of release 0.4.0 as published, and a follow-up release built from this checkout. */
async function setup(t, edit) {
  const temp = await tempDir('optbrew same evaluation ');
  const released = path.join(temp, 'release-0.4.0');
  await copyCurrent(released);
  const versionsFile = path.join(released, 'references', 'versions.json');
  await writeFile(versionsFile, (await readFile(versionsFile, 'utf8')).replace('"release": "0.4.1"', '"release": "0.4.0"'));
  for (const name of ['scoring.md', 'measurement.md']) await copyFile(path.join(before, name), path.join(released, 'references', name));
  await seal(released, '0.4.0');
  assert.equal((await manifestOf(released)).bundle_hash, published040, 'the fixture is the published 0.4.0 bundle');
  const next = path.join(temp, 'release-0.4.1');
  await copyCurrent(next);
  await writeFile(path.join(next, 'SKILL.md'), `${await readFile(path.join(next, 'SKILL.md'), 'utf8')}\nSynthetic follow-up release.\n`);
  await edit?.(next);
  await seal(next, '0.4.1');
  const home = path.join(temp, 'home');
  await mkdir(home);
  const installed = await install({ bundleRoot: released, home, scope: 'user', agents: ['codex'], strategy: 'copy' });
  await mkdir(path.join(home, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(home, '.optbrew/runs/run.json'), 'private run evidence');
  return { home, next, recordRoot: installed.record.managed_root };
}

test('a managed 0.4.0 install updates in place after a wording-only fix of the scoring contract text', async t => {
  const f = await setup(t);
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  assert.equal(result.status, 'updated');
  assert.equal(result.record.release_version, '0.4.1');
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.4.1');
  assert.ok((await doctor({ home: f.home, scope: 'user', agents: ['codex'] })).targets.every(x => x.hash_ok));
  assert.equal(await readFile(path.join(f.home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
});

test('a changed scoring rule text or rule file still requires a migration, and the install stays as it was', async t => {
  const appended = file => async next => writeFile(path.join(next, file), `${await readFile(path.join(next, file), 'utf8')}\nA new rule.\n`);
  for (const [file, name] of [['references/scoring.md', 'scoring.md'], ['references/measurement.md', 'measurement.md'], ['scripts/core/score.mjs', 'score.mjs'], ['references/profiles.json', 'profiles.json']]) {
    const f = await setup(t, file.endsWith('.json') ? async next => {
      const profiles = JSON.parse(await readFile(path.join(next, file), 'utf8'));
      await writeFile(path.join(next, file), JSON.stringify({ ...profiles, changed: true }));
    } : appended(file));
    await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), error => /^migration_required: /.test(error.message) && error.message.includes(name), name);
    assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.4.0', name);
  }
});

test('the list never bridges a change of the evaluation version, and a hash outside the list is not bridged', () => {
  const [oldHash, newHash] = sameEvaluationText['0.6.0']['references/scoring.md'];
  const same = (evaluationVersion, nextEvaluationVersion, previousHash, nextHash) =>
    isSameEvaluationText({ evaluationVersion, nextEvaluationVersion, name: 'references/scoring.md', previousHash, nextHash });
  assert.notEqual(oldHash, newHash);
  assert.equal(same('0.6.0', '0.6.0', oldHash, newHash), true);
  assert.equal(same('0.5.0', '0.6.0', oldHash, newHash), false, 'another evaluation version');
  assert.equal(same('0.6.0', '0.7.0', oldHash, newHash), false, 'another evaluation version');
  assert.equal(same(undefined, undefined, oldHash, newHash), false, 'unknown evaluation version');
  assert.equal(same('0.6.0', '0.6.0', oldHash, 'f'.repeat(64)), false, 'a hash outside the list');
  assert.equal(same('0.6.0', '0.6.0', 'e'.repeat(64), newHash), false, 'a hash outside the list');
  assert.equal(isSameEvaluationText({ evaluationVersion: '0.6.0', nextEvaluationVersion: '0.6.0', name: 'scripts/core/score.mjs', previousHash: oldHash, nextHash: newHash }), false, 'only the prose files are listed');
});

test('this checkout is listed as the same evaluation, so a later wording fix cannot lock managed installs out unnoticed', async () => {
  const listed = sameEvaluationText[versions().evaluation];
  assert.ok(listed, `add evaluation ${versions().evaluation} to lib/evaluation-equivalence.mjs with the hashes of its scoring.md and measurement.md`);
  for (const name of ['references/scoring.md', 'references/measurement.md']) {
    const hash = fileDigest(await readFile(path.join(currentBundle, name)));
    assert.ok(listed[name]?.includes(hash), `${name} has hash ${hash}; list it in lib/evaluation-equivalence.mjs only if no rule changed`);
  }
});
