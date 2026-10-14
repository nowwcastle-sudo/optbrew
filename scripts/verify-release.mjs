import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBundle, evaluationSourcePaths, protocolSourcePaths } from '../skills/optbrew/scripts/core/bundle.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const prohibited = /(?:^|\/)(?:private|tests|evals|runs|dist|_백업_원본_[^/]*|__pycache__)(?:\/|$)|(?:^|\/)test_[^/]*\.py$|\.pyc$|modules\/naver-searchadvisor\/references\/guide\//i;

function inspectArchive(kind, archive) {
  const script = `import hashlib,json,sys,zipfile,tarfile\nout={}\nif sys.argv[1]=='zip':\n with zipfile.ZipFile(sys.argv[2]) as z:\n  for item in z.infolist():\n   if not item.is_dir(): out[item.filename]=hashlib.sha256(z.read(item)).hexdigest()\nelse:\n with tarfile.open(sys.argv[2], 'r:gz') as t:\n  for item in t:\n   if item.isfile(): out[item.name]=hashlib.sha256(t.extractfile(item).read()).hexdigest()\nprint(json.dumps(out,sort_keys=True))\n`;
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
    if (artifacts.npm_tarball) {
      const tar = inspectArchive('tar', artifacts.npm_tarball);
      artifact_hashes.npm_tarball = hash(await readFile(artifacts.npm_tarball));
      checked_files += Object.keys(tar).length;
      for (const [name, sha] of expected) {
        const tarName = `package/skills/${name}`;
        if (tar[tarName] !== sha) errors.push({ path: tarName, code: 'npm_hash_mismatch' });
      }
      for (const name of Object.keys(tar)) if (name.startsWith('package/skills/') &&
        !expected.has(name.slice('package/skills/'.length))) errors.push({ path: name, code: 'npm_unexpected_skill_file' });
      for (const name of Object.keys(tar)) if (prohibited.test(name)) errors.push({ path: name, code: 'npm_prohibited_file' });
      for (const required of ['package/bin/optbrew.mjs', 'package/LICENSE', 'package/plugin.json', 'package/THIRD_PARTY_NOTICES.md', 'package/source-lock.json'])
        if (!tar[required]) errors.push({ path: required, code: 'npm_missing_file' });
    }
    for (const name of ['THIRD_PARTY_NOTICES.md', 'source-lock.json']) {
      const a = await readFile(path.join(root, name));
      const b = await readFile(path.join(bundleRoot, name));
      if (!a.equals(b)) errors.push({ path: name, code: 'mirror_mismatch' });
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
