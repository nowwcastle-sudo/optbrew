import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../scripts/build-release.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';
import { verifiedBundle } from '../lib/transaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ZIP contains a self-contained skill with exact selected guides and refuses tampering', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-release-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.0', outputDir });
    const first = await verifyRelease({ root, artifacts });
    assert.equal(first.status, 'valid', JSON.stringify(first.errors));
    const listing = spawnSync('python', ['-c', 'import sys,zipfile,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', artifacts.skill_zip], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const names = JSON.parse(listing.stdout);
    assert.equal(names.filter(name => name.endsWith('/SKILL.md')).length, 1);
    assert.equal(names.filter(name => name.endsWith('/GUIDE.md') && name.includes('/marketing-search/skills/')).length, 7);
    assert.equal(names.filter(name => name.endsWith('/GUIDE.md') && name.includes('/seranking-seo/skills/')).length, 13);
    for (const module of ['mblode-seo', 'naver-searchadvisor', 'firecrawl-seo-audit', 'magnus-seo'])
      assert.ok(names.includes(`optbrew/modules/${module}/GUIDE.md`), module);
    for (const module of ['mblode-seo', 'naver-searchadvisor', 'firecrawl-seo-audit', 'magnus-seo', 'seranking-seo', 'marketing-search'])
      assert.ok(names.includes(`optbrew/licenses/${module}.txt`), module);
    for (const required of ['optbrew/SKILL.md', 'optbrew/scripts/cli.mjs', 'optbrew/scripts/core/score.mjs', 'optbrew/THIRD_PARTY_NOTICES.md', 'optbrew/source-lock.json'])
      assert.ok(names.includes(required), required);
    assert.ok(names.every(name => !/(?:references\/guide\/|private|_백업_원본_|\/tests\/|\/evals\/|\/runs\/|\/test_[^/]*\.py$)/i.test(name)));
    const extracted = path.join(outputDir, 'extract');
    const unzip = spawnSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', artifacts.skill_zip, extracted], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stderr);
    const isolatedCli = path.join(extracted, 'optbrew/scripts/cli.mjs');
    const scoreFile = path.join(outputDir, 'score.json');
    const score = spawnSync(process.execPath, [isolatedCli, 'score', '--input', path.join(root, 'tests/fixtures/scoring/before.json'), '--output', scoreFile], { encoding: 'utf8' });
    assert.equal(score.status, 0, score.stderr);
    assert.equal(JSON.parse(await readFile(scoreFile, 'utf8')).length, 4);
    const reportInputDir = path.join(outputDir, 'report-input');
    await mkdir(reportInputDir);
    await cp(path.join(root, 'tests/fixtures/reports'), reportInputDir, { recursive: true });
    const reportDir = path.join(outputDir, 'report-output');
    const report = spawnSync(process.execPath, [isolatedCli, 'report', '--input', path.join(reportInputDir, 'remote-only.json'), '--output-dir', reportDir], { encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr);
    assert.ok((await readFile(path.join(reportDir, 'report.md'), 'utf8')).includes('noindex'));
    const bytes = await readFile(artifacts.skill_zip);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    await writeFile(artifacts.skill_zip, bytes);
    const tampered = await verifyRelease({ root, artifacts });
    assert.equal(tampered.status, 'invalid');
    passed = true;
  } finally {
    if (passed) await rm(outputDir, { recursive: true, force: true });
  }
});

test('source-lock keeps excluded provenance but still guards distributed bytes', async () => {
  const bundleRoot = await mkdtemp(path.join(tmpdir(), 'optbrew-lock-'));
  let passed = false;
  try {
    await writeFile(path.join(bundleRoot, 'SKILL.md'), 'runtime');
    const runtimeSha = (await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' })).files[0].sha256;
    const lock = { schema_version: '1.0.0', modules: [], files: [
      { package_path: 'skills/optbrew/SKILL.md', distributed_sha256: runtimeSha },
      { package_path: 'skills/optbrew/modules/example/evals/evals.json', distributed_sha256: '0'.repeat(64) },
      { package_path: 'skills/optbrew/modules/example/scripts/test_example.py', distributed_sha256: '0'.repeat(64) },
    ] };
    await writeFile(path.join(bundleRoot, 'source-lock.json'), `${JSON.stringify(lock)}\n`);
    const manifest = await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' });
    await writeFile(path.join(bundleRoot, 'bundle-manifest.json'), `${JSON.stringify(manifest)}\n`);
    assert.equal((await verifiedBundle(bundleRoot)).verification.status, 'valid');
    lock.files[0].distributed_sha256 = '0'.repeat(64);
    await writeFile(path.join(bundleRoot, 'source-lock.json'), `${JSON.stringify(lock)}\n`);
    await writeFile(path.join(bundleRoot, 'bundle-manifest.json'), `${JSON.stringify(await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' }))}\n`);
    await assert.rejects(verifiedBundle(bundleRoot), /source-lock hash\/mapping mismatch/);
    passed = true;
  } finally {
    if (passed) await rm(bundleRoot, { recursive: true, force: true });
  }
});

test('official schema validates portable plugin and rejects extra root fields', () => {
  const schema = path.join(root, 'docs/validation/plugin.schema.json');
  const good = spawnSync('python', ['scripts/validate-plugin.py', '--schema', schema, '--manifest', 'plugin.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  const bad = spawnSync('python', ['scripts/validate-plugin.py', '--schema', schema, '--manifest', 'tests/fixtures/plugins/invalid-root.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Additional properties/);
});

test('npm tarball includes matching skill bytes and excludes authoring files', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-npm-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.0', outputDir });
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(packed.status, 0, packed.stderr);
    const info = JSON.parse(packed.stdout);
    const { filename, files } = Array.isArray(info) ? info[0] : info.optbrew;
    assert.equal(files.filter(file => file.path.endsWith('/SKILL.md')).length, 1);
    assert.ok(!files.some(file => /(?:^|\/)(?:tests|evals|dist|private|runs|_백업_원본_)|(?:^|\/)test_[^/]*\.py$/.test(file.path)));
    artifacts.npm_tarball = path.join(outputDir, filename);
    const receipt = await verifyRelease({ root, artifacts });
    assert.equal(receipt.status, 'valid', JSON.stringify(receipt.errors));
    passed = true;
  } finally {
    if (passed) await rm(outputDir, { recursive: true, force: true });
  }
});
