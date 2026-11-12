import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, release } from './fixtures/releases/create.mjs';
import { tempDir } from './support/temp-dir.mjs';
import { install } from '../lib/install.mjs';
import { managedRename } from '../lib/transaction.mjs';
import { update } from '../lib/update.mjs';
import { openStore, ownerOnlyDir } from '../skills/optbrew/scripts/core/evidence-store.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/** Swap a real folder for a link to `outside`, as a local attacker racing the check would. */
async function swapForLink(folder, outside) {
  await rename(folder, `${folder}-real`);
  await symlink(outside, folder, linkType);
}

// daybreak csf_40c2109a0015: a host loads every child of its skills folder, so a backup kept there is a second skill.
test('an update keeps backups and staging under the managed record, never in a host skills folder', async () => {
  const f = await fixture('copy');
  const edited = path.join(f.record.targets[0].path, 'SKILL.md');
  await writeFile(edited, 'user edit');
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, localChanges: 'backup-and-replace' });
  assert.equal(result.status, 'updated');
  for (const backup of result.decision.backups) {
    assert.ok(backup.backup.startsWith(path.join(f.recordRoot, 'backups') + path.sep), backup.backup);
  }
  for (const target of f.record.targets) assert.deepEqual(await readdir(path.dirname(target.path)), ['optbrew']);
  const kept = result.decision.backups.find(item => item.path === path.dirname(edited));
  assert.equal(await readFile(path.join(kept.backup, 'SKILL.md'), 'utf8'), 'user edit', 'the edited copy is still kept');
});

// daybreak csf_3b5cfc13c1dd: a parent swapped for a link after the check must not receive the install.
for (const strategy of ['link', 'copy']) {
  test(`install (${strategy}) refuses and undoes a target written through a parent swapped after the check`, async () => {
    const root = await tempDir('optbrew-race-');
    const home = path.join(root, 'home'), outside = path.join(root, 'outside');
    await mkdir(path.join(outside, 'skills'), { recursive: true });
    const bundleRoot = await release(root, '0.1.0');
    const faultHook = async stage => { if (stage === 'before_target_write') await swapForLink(path.join(home, '.claude'), outside); };
    await assert.rejects(install({ bundleRoot, agents: ['claude-code'], scope: 'user', home, strategy, faultHook }), /resolved path changed/);
    assert.deepEqual(await readdir(path.join(outside, 'skills')), [], 'nothing is left in the folder the link points to');
  });
}

test('a managed rename whose destination parent became a link is moved back and refused', async () => {
  const scope = await tempDir('optbrew-rename-');
  const from = path.join(scope, 'a', 'src'), outside = path.join(scope, '..', `${path.basename(scope)}-outside`);
  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, 'file.txt'), 'kept');
  await mkdir(path.join(scope, 'b'));
  await mkdir(outside, { recursive: true });
  await assert.rejects(managedRename(scope, from, path.join(scope, 'b', 'dst'), { beforeRename: () => swapForLink(path.join(scope, 'b'), outside) }),
    /resolved path changed/);
  assert.equal(await readFile(path.join(from, 'file.txt'), 'utf8'), 'kept');
  assert.deepEqual(await readdir(outside), []);
});

// daybreak csf_0274d90e248e: owner exports and raw bodies are owner-only on POSIX. Windows keeps the profile's inherited ACL.
test('audit folders are owner-only and evidence files are 0600', { skip: process.platform === 'win32' }, async () => {
  const root = await tempDir('optbrew-perm-');
  const fresh = path.join(root, 'fresh');
  await ownerOnlyDir(fresh);
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);
  const reused = path.join(root, 'reused');
  await mkdir(reused);
  await chmod(reused, 0o755);
  await ownerOnlyDir(reused);
  assert.equal((await stat(reused)).mode & 0o777, 0o700, 'an existing folder this user owns is narrowed');
  const { ref } = await openStore(fresh).write('owner-export', Buffer.from('query,clicks\n'));
  assert.equal((await stat(ref)).mode & 0o777, 0o600);
});
