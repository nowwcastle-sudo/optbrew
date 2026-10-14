import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../scripts/build-release.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';
import { verifiedBundle } from '../lib/transaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run npm with a fixed argv and no shell, as the release verifier does. */
function npmPack(destination) {
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', destination];
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  return process.platform === 'win32' ?
    spawnSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: 'utf8', shell: false }) :
    spawnSync('npm', args, { cwd: root, encoding: 'utf8', shell: false });
}

// Split from release.test.mjs so each file stays well inside the per-file timeout (the npm pack tests are the slow ones).
test('npm tarball includes matching skill bytes and excludes authoring files', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-npm-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.2', outputDir });
    const packed = npmPack(outputDir);
    assert.equal(packed.status, 0, packed.stderr);
    const info = JSON.parse(packed.stdout);
    const { filename, files } = Array.isArray(info) ? info[0] : info.optbrew;
    assert.equal(files.filter(file => file.path.endsWith('/SKILL.md')).length, 1);
    assert.ok(!files.some(file => /(?:^|\/)(?:tests|evals|dist|private|runs|_백업_원본_)|(?:^|\/)test_[^/]*\.py$/.test(file.path)));
    artifacts.npm_tarball = path.join(outputDir, filename);
    const receipt = await verifyRelease({ root, artifacts });
    assert.equal(receipt.status, 'valid', JSON.stringify(receipt.errors));
    assert.ok(files.some(file => file.path === 'skills/optbrew/LICENSE'));
    const extracted = path.join(outputDir, 'npm-extract');
    const unpack = spawnSync('python', ['-c', 'import sys,tarfile; tarfile.open(sys.argv[1],"r:gz").extractall(sys.argv[2])', artifacts.npm_tarball, extracted], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const scoreFile = path.join(outputDir, 'npm-score.json');
    const score = spawnSync(process.execPath, [path.join(extracted, 'package/bin/optbrew.mjs'), 'score', '--input',
      path.join(root, 'tests/fixtures/scoring/before.json'), '--output', scoreFile], { encoding: 'utf8' });
    assert.equal(score.status, 0, score.stderr);
    assert.equal(JSON.parse(await readFile(scoreFile, 'utf8')).length, 4);
    passed = true;
  } finally {
    if (passed) await rm(outputDir, { recursive: true, force: true });
  }
});

test('npm verifier rejects tampered entrypoint, missing libs, and false package or overlay versions', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-npm-tamper-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.2', outputDir });
    const packed = npmPack(outputDir);
    assert.equal(packed.status, 0, packed.stderr);
    const info = JSON.parse(packed.stdout);
    artifacts.npm_tarball = path.join(outputDir, (Array.isArray(info) ? info[0] : info.optbrew).filename);
    const results = {};
    for (const kind of ['cli-tamper', 'missing-lib', 'wrong-version', 'overlay-version', 'extra-file',
      'dir-file-conflict', 'duplicate-directory', 'trailing-file-name', 'unchanged-repack']) {
      const mutated = path.join(outputDir, `${kind}.tgz`);
      const script = `import io,json,sys,tarfile\nsrc,dst,kind=sys.argv[1:]\nwith tarfile.open(src,'r:gz') as source,tarfile.open(dst,'w:gz') as target:\n if kind=='dir-file-conflict':\n  item=tarfile.TarInfo('package/bin/optbrew.mjs'); item.type=tarfile.DIRTYPE; target.addfile(item)\n if kind=='duplicate-directory':\n  for _ in range(2):\n   item=tarfile.TarInfo('package/duplicate/'); item.type=tarfile.DIRTYPE; target.addfile(item)\n for item in source:\n  if kind=='trailing-file-name' and item.name=='package/bin/optbrew.mjs': item.name += '/'\n  if kind=='missing-lib' and item.name.startswith('package/lib/'): continue\n  if item.isfile():\n   data=source.extractfile(item).read()\n   if kind=='cli-tamper' and item.name=='package/bin/optbrew.mjs': data=b'throw new Error("broken")\\n'\n   if kind=='wrong-version' and item.name=='package/package.json':\n    obj=json.loads(data); obj['version']='99.0.0'; data=json.dumps(obj).encode()\n   if kind=='overlay-version' and item.name=='package/.claude-plugin/plugin.json':\n    obj=json.loads(data); obj['version']='99.0.0'; data=json.dumps(obj).encode()\n   item.size=len(data); target.addfile(item,io.BytesIO(data))\n  else: target.addfile(item)\n if kind=='extra-file':\n  data=b'unexpected'; item=tarfile.TarInfo('package/extra.txt'); item.size=len(data); target.addfile(item,io.BytesIO(data))\n`;
      const mutation = spawnSync('python', ['-c', script, artifacts.npm_tarball, mutated, kind], { encoding: 'utf8' });
      assert.equal(mutation.status, 0, mutation.stderr);
      results[kind] = await verifyRelease({ root, artifacts: { ...artifacts, npm_tarball: mutated } });
    }
    const target = { 'cli-tamper': ['package/bin/optbrew.mjs', 'npm_hash_mismatch'],
      'missing-lib': ['package/lib/cli.mjs', 'npm_missing_file'],
      'wrong-version': ['package/package.json', 'npm_hash_mismatch'],
      'overlay-version': ['package/.claude-plugin/plugin.json', 'npm_hash_mismatch'],
      'extra-file': ['package/extra.txt', 'npm_unexpected_file'] };
    for (const [kind, result] of Object.entries(results)) {
      if (kind === 'unchanged-repack') {
        assert.equal(result.status, 'valid', JSON.stringify(result.errors));
        process.stdout.write('npm mutation unchanged-repack: valid\n');
        continue;
      }
      assert.equal(result.status, 'invalid', `${kind}: ${JSON.stringify(result)}`);
      if (target[kind])
        assert.ok(result.errors.some(error => error.path === target[kind][0] && error.code === target[kind][1]),
          `${kind}: ${JSON.stringify(result.errors)}`);
      else if (kind === 'trailing-file-name')
        assert.ok(result.errors.some(error => /regular file path ends with slash/.test(error.code)),
          `${kind}: ${JSON.stringify(result.errors)}`);
      else assert.ok(result.errors.some(error => /duplicate archive path/.test(error.code)),
        `${kind}: ${JSON.stringify(result.errors)}`);
      process.stdout.write(`npm mutation ${kind}: ${target[kind]?.[1] ?? (kind === 'trailing-file-name' ? 'regular file path ends with slash' : 'duplicate archive path')}\n`);
    }
    passed = true;
  } finally {
    if (passed) await rm(outputDir, { recursive: true, force: true });
  }
});
