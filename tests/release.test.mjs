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

test('ZIP contains a self-contained skill with exact selected guides and refuses tampering', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-release-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.2', outputDir });
    const first = await verifyRelease({ root, artifacts });
    assert.equal(first.status, 'valid', JSON.stringify(first.errors));
    const listing = spawnSync('python', ['-c', 'import sys,zipfile,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', artifacts.skill_zip], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const names = JSON.parse(listing.stdout);
    assert.ok(names.includes('optbrew/LICENSE'), 'standalone ZIP must include own MIT license');
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
    assert.deepEqual(await readFile(path.join(extracted, 'optbrew/LICENSE')),
      await readFile(path.join(root, 'LICENSE')));
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

test('final review I8: ZIP verifier records every member and rejects unextractable layouts', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'optbrew-zip-layout-'));
  let passed = false;
  try {
    const artifacts = await buildRelease({ root, version: '0.1.2', outputDir });
    const script = `import sys,zipfile\nsrc,dst,kind=sys.argv[1:]\nwith zipfile.ZipFile(src) as source, zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED) as target:\n for item in source.infolist(): target.writestr(item, source.read(item))\n if kind=='file-dir-conflict': target.writestr(zipfile.ZipInfo('optbrew/SKILL.md/'), b'')\n if kind=='dir-then-file-conflict':\n  target.writestr(zipfile.ZipInfo('optbrew/conflict/'), b''); target.writestr('optbrew/conflict', b'x')\n if kind=='ancestor-file-conflict': target.writestr('optbrew/SKILL.md/child.txt', b'x')\n if kind=='duplicate-directory':\n  for _ in range(2): target.writestr(zipfile.ZipInfo('optbrew/duplicate/'), b'')\n if kind=='duplicate-file': target.writestr('optbrew/SKILL.md', b'duplicate')\n if kind=='harmless-directory': target.writestr(zipfile.ZipInfo('optbrew/scripts/'), b'')\n if kind=='case-dir-conflict': target.writestr(zipfile.ZipInfo('optbrew/skill.md/'), b'')\n if kind=='case-file-duplicate': target.writestr('optbrew/skill.md', b'x')\n if kind=='case-ancestor-file': target.writestr('OPTBREW/SKILL.md/x', b'x')\n if kind=='trailing-dot-dir': target.writestr(zipfile.ZipInfo('optbrew/SKILL.md./'), b'')\n if kind=='trailing-space-dir': target.writestr(zipfile.ZipInfo('optbrew/scripts /'), b'')\n if kind=='trailing-dot-file': target.writestr('optbrew/notes.', b'x')\n`;
    const expected = {
      'file-dir-conflict': /archive path conflict/, 'dir-then-file-conflict': /archive path conflict/,
      'ancestor-file-conflict': /archive path conflict/, 'duplicate-directory': /duplicate archive path/,
      'duplicate-file': /duplicate archive path/, 'harmless-directory': null, 'unchanged-repack': null,
      'case-dir-conflict': /archive path conflict/, 'case-file-duplicate': /archive path conflict/,
      'case-ancestor-file': /archive path conflict/, 'trailing-dot-dir': /unsafe Windows path/,
      'trailing-space-dir': /unsafe Windows path/, 'trailing-dot-file': /unsafe Windows path/ };
    for (const [kind, pattern] of Object.entries(expected)) {
      const mutated = path.join(outputDir, `${kind}.zip`);
      const made = spawnSync('python', ['-W', 'ignore', '-c', script, artifacts.skill_zip, mutated, kind], { encoding: 'utf8' });
      assert.equal(made.status, 0, `${kind}: ${made.stderr}`);
      const result = await verifyRelease({ root, artifacts: { ...artifacts, skill_zip: mutated,
        hashes: { ...artifacts.hashes, skill_zip: createHash('sha256').update(await readFile(mutated)).digest('hex') } } });
      if (!pattern) assert.equal(result.status, 'valid', `${kind}: ${JSON.stringify(result.errors)}`);
      else {
        assert.equal(result.status, 'invalid', kind);
        assert.ok(result.errors.some(error => pattern.test(error.code)), `${kind}: ${JSON.stringify(result.errors)}`);
      }
      process.stdout.write(`zip layout ${kind}: ${result.status}\n`);
    }
    passed = true;
  } finally {
    if (passed) await rm(outputDir, { recursive: true, force: true });
  }
});
