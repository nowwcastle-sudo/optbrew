import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBundle, evaluationSourcePaths, protocolSourcePaths } from '../skills/optbrew/scripts/core/bundle.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const prohibited = /(?:^|\/)(?:private|tests|evals|runs|dist|_백업_원본_[^/]*|__pycache__)(?:\/|$)|(?:^|\/)test_[^/]*\.py$|\.pyc$|modules\/naver-searchadvisor\/references\/guide\//i;

/** Source metadata must describe one release and one contained skill. */
export async function releaseMetadataErrors(root, version) {
  const read = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const [pkg, lock, portable, codex, claude, marketplace] = await Promise.all([
    read('package.json'), read('package-lock.json'), read('plugin.json'),
    read('.codex-plugin/plugin.json'), read('.claude-plugin/plugin.json'),
    read('.claude-plugin/marketplace.json'),
  ]);
  const errors = [];
  const expect = (condition, file, code) => { if (!condition) errors.push({ path: file, code }); };
  expect(pkg.name === 'optbrew' && lock.name === 'optbrew' && lock.packages?.['']?.name === 'optbrew' &&
    pkg.version === version && lock.version === version && lock.packages?.['']?.version === version,
    'package.json', 'release_version_mismatch');
  expect(pkg.bin?.optbrew === 'bin/optbrew.mjs' &&
    JSON.stringify(pkg.pi?.skills) === JSON.stringify(['./skills/optbrew']), 'package.json', 'package_skill_path_mismatch');
  for (const [file, value] of [['plugin.json', portable], ['.codex-plugin/plugin.json', codex]]) {
    expect(value.name === 'optbrew' &&
      value.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' &&
      value.version === version && value.extensions?.['com.openai']?.release_version === version &&
      JSON.stringify(value.extensions?.['com.openai']?.skills) === JSON.stringify(['./skills/optbrew']),
    file, 'plugin_release_mismatch');
  }
  expect(claude.name === 'optbrew' && claude.version === version &&
    JSON.stringify(claude.skills) === JSON.stringify(['./skills/optbrew']),
    '.claude-plugin/plugin.json', 'claude_release_mismatch');
  expect(marketplace.plugins?.length === 1 && marketplace.plugins[0]?.name === 'optbrew' &&
    marketplace.plugins[0]?.source === './' && marketplace.plugins[0]?.version === version,
  '.claude-plugin/marketplace.json', 'marketplace_release_mismatch');
  return errors;
}

async function expectedNpmFiles(root) {
  // npm supplies the packlist; trusted checkout bytes, never tar metadata, supply every expected hash.
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const result = spawnSync(command, process.platform === 'win32' ? [npmCli, ...args] : args,
    { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack dry-run failed: ${result.stderr || result.error?.message}`);
  const output = JSON.parse(result.stdout);
  const listing = Array.isArray(output) ? output[0] : output.optbrew;
  if (!Array.isArray(listing?.files) || !listing.files.length) throw new Error('npm pack dry-run returned no file list');
  const expected = new Map();
  for (const { path: name } of listing.files) {
    const archiveName = `package/${name}`;
    if (expected.has(archiveName)) throw new Error(`duplicate npm packlist path: ${name}`);
    expected.set(archiveName, hash(await readFile(path.join(root, name))));
  }
  return expected;
}

function inspectArchive(kind, archive) {
  const script = `import hashlib,json,sys,zipfile,tarfile\nout={}; seen={}\nif sys.argv[1]=='zip':\n with zipfile.ZipFile(sys.argv[2]) as z:\n  for item in z.infolist():\n   if item.filename in out: raise ValueError('duplicate archive path: '+item.filename)\n   if not item.is_dir(): out[item.filename]=hashlib.sha256(z.read(item)).hexdigest()\nelse:\n with tarfile.open(sys.argv[2], 'r:gz') as t:\n  for item in t:\n   if item.isfile() and item.name.endswith('/'): raise ValueError('regular file path ends with slash: '+item.name)\n   name=item.name.rstrip('/') if item.isdir() else item.name\n   if not name or name in seen: raise ValueError('duplicate archive path: '+item.name)\n   if item.isfile():\n    seen[name]='file'; out[name]=hashlib.sha256(t.extractfile(item).read()).hexdigest()\n   elif item.isdir(): seen[name]='directory'\n   else: raise ValueError('special archive path: '+item.name)\n for name in seen:\n  parts=name.split('/')\n  for index in range(1,len(parts)):\n   if seen.get('/'.join(parts[:index]))=='file': raise ValueError('archive path conflict: '+name)\nprint(json.dumps(out,sort_keys=True))\n`;
  const result = spawnSync('python', ['-c', script, kind, archive], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'archive inspection failed');
  return JSON.parse(result.stdout);
}

export async function verifyRelease({ root = projectRoot, artifacts }) {
  const errors = [];
  let checked_files = 0;
  const artifact_hashes = {};
  try {
    const bundleRoot = path.join(root, 'skills', 'optbrew');
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json')));
    const version = JSON.parse(await readFile(path.join(root, 'package.json'))).version;
    errors.push(...await releaseMetadataErrors(root, version));
    if (artifacts.version !== version || manifest.release_version !== version)
      errors.push({ path: 'bundle-manifest.json', code: 'artifact_release_mismatch' });
    const bundle = await verifyBundle({ bundleRoot, manifest });
    errors.push(...bundle.errors);
    if (manifest.evaluation_sources?.length !== evaluationSourcePaths.length ||
        manifest.protocol_sources?.length !== protocolSourcePaths.length)
      errors.push({ path: 'bundle-manifest.json', code: 'source_identity_incomplete' });
    const expected = new Map(manifest.files.map(file => [`optbrew/${file.path}`, file.sha256]));
    expected.set('optbrew/bundle-manifest.json', hash(await readFile(path.join(bundleRoot, 'bundle-manifest.json'))));
    const zip = inspectArchive('zip', artifacts.skill_zip);
    artifact_hashes.skill_zip = hash(await readFile(artifacts.skill_zip));
    if (artifacts.hashes?.skill_zip !== artifact_hashes.skill_zip) errors.push({ path: artifacts.skill_zip, code: 'artifact_hash_mismatch' });
    for (const [name, sha] of expected) if (zip[name] !== sha) errors.push({ path: name, code: 'zip_hash_mismatch' });
    for (const name of Object.keys(zip)) if (!expected.has(name) || prohibited.test(name)) errors.push({ path: name, code: 'zip_unexpected_file' });
    checked_files += Object.keys(zip).length;
    const skillNames = Object.keys(zip).filter(name => name.endsWith('/SKILL.md'));
    if (skillNames.length !== 1 || skillNames[0] !== 'optbrew/SKILL.md') errors.push({ path: 'SKILL.md', code: 'skill_count' });
    if (!(await readFile(path.join(root, 'LICENSE'))).equals(await readFile(path.join(bundleRoot, 'LICENSE'))))
      errors.push({ path: 'skills/optbrew/LICENSE', code: 'own_license_mismatch' });
    if (artifacts.npm_tarball) {
      const tar = inspectArchive('tar', artifacts.npm_tarball);
      artifact_hashes.npm_tarball = hash(await readFile(artifacts.npm_tarball));
      checked_files += Object.keys(tar).length;
      const npmExpected = await expectedNpmFiles(root);
      for (const [name, sha] of npmExpected)
        if (tar[name] !== sha) errors.push({ path: name, code: tar[name] ? 'npm_hash_mismatch' : 'npm_missing_file' });
      for (const name of Object.keys(tar)) if (!npmExpected.has(name)) errors.push({ path: name, code: 'npm_unexpected_file' });
      for (const name of Object.keys(tar)) if (prohibited.test(name)) errors.push({ path: name, code: 'npm_prohibited_file' });
      for (const required of ['package/bin/optbrew.mjs', 'package/LICENSE', 'package/skills/optbrew/LICENSE',
        'package/plugin.json', 'package/THIRD_PARTY_NOTICES.md', 'package/source-lock.json'])
        if (!npmExpected.has(required)) errors.push({ path: required, code: 'npm_source_missing_file' });
    }
    for (const name of ['THIRD_PARTY_NOTICES.md', 'source-lock.json']) {
      const a = await readFile(path.join(root, name));
      const b = await readFile(path.join(bundleRoot, name));
      const expected = name === 'THIRD_PARTY_NOTICES.md' ?
        Buffer.from(b.toString('utf8').replace(/\]\(licenses\//g, '](skills/optbrew/licenses/')) : b;
      if (!a.equals(expected)) errors.push({ path: name, code: 'mirror_mismatch' });
    }
    if (artifacts.hashes?.bundle !== manifest.bundle_hash || artifacts.hashes?.evaluation !== manifest.evaluation_hash || artifacts.hashes?.protocol !== manifest.protocol_hash)
      errors.push({ path: 'bundle-manifest.json', code: 'artifact_identity_mismatch' });
  } catch (error) { errors.push({ path: '', code: error.message }); }
  return { status: errors.length ? 'invalid' : 'valid', checked_files, artifact_hashes, errors,
    source_ref: 'skills/optbrew/bundle-manifest.json' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--dist') {
    process.stderr.write('usage: verify-release.mjs --dist <directory>\n');
    process.exitCode = 2;
  } else {
    const dist = path.resolve(args[1]);
    const version = JSON.parse(await readFile(path.join(projectRoot, 'package.json'))).version;
    const files = await readdir(dist);
    const tarName = files.find(name => name === `optbrew-${version}.tgz`);
    const zipPath = path.join(dist, `optbrew-${version}.zip`);
    const artifacts = { version, skill_zip: zipPath, npm_tarball: tarName ? path.join(dist, tarName) : null,
      hashes: { skill_zip: hash(await readFile(zipPath)) } };
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'skills/optbrew/bundle-manifest.json')));
    artifacts.hashes.bundle = manifest.bundle_hash;
    artifacts.hashes.evaluation = manifest.evaluation_hash;
    artifacts.hashes.protocol = manifest.protocol_hash;
    const result = await verifyRelease({ root: projectRoot, artifacts });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'valid') process.exitCode = 1;
  }
}
