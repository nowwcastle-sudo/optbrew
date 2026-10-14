import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, cp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { vendor } from '../scripts/vendor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcesRoot = process.env.OPTBREW_SOURCES_ROOT ?? path.resolve(root, '../../../work/seo-alternatives/sources');
const configPath = path.join(root, 'scripts/vendor.config.json');
const ids = ['mblode-seo', 'naver-searchadvisor', 'firecrawl-seo-audit', 'magnus-seo', 'seranking-seo', 'marketing-search'];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

test('vendored bundle has pinned files, notices and closed local links', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew-vendor-'));
  try {
    const lock = await vendor({ sourcesRoot, outputRoot: temp, configPath });
    assert.deepEqual(lock.modules.map(x => x.module_id), ids);
    assert.ok(lock.files.length > 30);
    for (const module of lock.modules) {
      const license = await readFile(path.join(temp, 'skills/optbrew/licenses', `${module.module_id}.txt`));
      assert.equal(module.license_blob_sha, lock.files.find(x => x.module_id === module.module_id && x.upstream_path === module.license_path).original_git_blob_sha);
      assert.ok(license.length > 100);
    }
    const bundle = path.join(temp, 'skills/optbrew/modules');
    assert.deepEqual(
      await readFile(path.join(bundle, 'naver-searchadvisor/scripts/robots.mjs')),
      await readFile(path.join(root, 'skills/optbrew/modules/naver-searchadvisor/scripts/robots.mjs'))
    );
    const firstParty = lock.files.find(x => x.package_path === 'skills/optbrew/modules/naver-searchadvisor/scripts/robots.mjs');
    assert.equal(firstParty.source_kind, 'first_party');
    assert.equal(firstParty.license, 'MIT');
    assert.equal(firstParty.original_git_blob_sha, null);
    const files = await walk(path.join(temp, 'skills/optbrew'));
    assert.equal(files.filter(x => path.basename(x) === 'SKILL.md').length, 0);
    assert.equal(files.filter(x => x.endsWith('GUIDE.md')).length, 24);
    assert.equal(files.filter(x => x.includes(`${path.sep}seranking-seo${path.sep}`) && x.endsWith('GUIDE.md')).length, 13);
    assert.equal(files.filter(x => x.includes(`${path.sep}marketing-search${path.sep}`) && x.endsWith('GUIDE.md')).length, 7);
    assert.equal(files.filter(x => x.includes(`${path.sep}naver-searchadvisor${path.sep}references${path.sep}guide${path.sep}`)).length, 0);
    for (const file of files.filter(x => x.endsWith('.md'))) {
      const text = await readFile(file, 'utf8');
      if (file.endsWith('GUIDE.md')) assert.ok(!text.startsWith('---\n'), `frontmatter in ${file}`);
      for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
        assert.ok(files.includes(resolved), `missing relative link ${file}: ${target}`);
      }
    }
    const index = await readFile(path.join(bundle, 'naver-searchadvisor/references/INDEX.md'), 'utf8');
    assert.match(index, /https:\/\/searchadvisor\.naver\.com\/guide\//);
    assert.doesNotMatch(index, /\]\(guide\//);
    assert.equal([...index.matchAll(/\]\(https:\/\/searchadvisor\.naver\.com\/guide\//g)].length, 55);
    for (const file of files.filter(x => x.includes(`${path.sep}seranking-seo${path.sep}`) && x.endsWith('.md'))) {
      const text = await readFile(file, 'utf8');
      assert.doesNotMatch(text, /extensions\/(?:google|firecrawl)\/install\.sh|scripts\/google_auth\.py/);
    }
    const notice = await readFile(path.join(temp, 'skills/optbrew/THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const module of lock.modules) assert.match(notice, new RegExp(module.license_blob_sha));
    assert.equal(JSON.parse(await readFile(path.join(temp, 'skills/optbrew/source-lock.json'), 'utf8')).files.length, lock.files.length);
    await writeFile(path.join(bundle, 'naver-searchadvisor/scripts/robots.mjs'), 'local edit');
    await assert.rejects(vendor({ sourcesRoot, outputRoot: temp, configPath }), /local edit|existing file differs/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('license drift and forbidden Naver guide copy fail closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew-vendor-bad-'));
  try {
    const original = path.join(sourcesRoot, 'JaceProgramming__naver-seo-expert');
    const source = path.join(temp, 'naver');
    await cp(original, source, { recursive: true });
    await writeFile(path.join(source, 'LICENSE'), 'bad license');
    await assert.rejects(vendor({ sourcesRoot, outputRoot: path.join(temp, 'out'), configPath, patchSet: { sourceOverrides: { 'naver-searchadvisor': source } } }), /license|blob|hash/i);
    const badConfig = JSON.parse(await readFile(configPath, 'utf8'));
    badConfig.modules.find(x => x.module_id === 'naver-searchadvisor').include.push('references/guide');
    const badConfigPath = path.join(temp, 'bad-config.json');
    await writeFile(badConfigPath, JSON.stringify(badConfig));
    await assert.rejects(vendor({ sourcesRoot, outputRoot: path.join(temp, 'out'), configPath: badConfigPath }), /forbidden|copyright|guide/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('reviewed parser replacement survives configured CLI regeneration and rejects local edits', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew-patch-'));
  try {
    const outputRoot = path.join(temp, 'out');
    const base = await vendor({ sourcesRoot, outputRoot, configPath });
    const original = base.files.find(x => x.module_id === 'magnus-seo' && x.upstream_path === 'seo/scripts/aeo_audit.py');
    assert.ok(original);
    const replacement = Buffer.concat([await readFile(path.join(outputRoot, original.package_path)), Buffer.from('\n# reviewed test change\n')]);
    const patchDir = path.join(temp, 'patches');
    await mkdir(patchDir);
    await cp(path.join(root, 'scripts/patches/naver-robots.mjs'), path.join(patchDir, 'naver-robots.mjs'));
    await writeFile(path.join(patchDir, 'aeo_audit.py'), replacement);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.reviewed_patches = [{
      id: 'T2-MAGNUS-PARSER', module_id: 'magnus-seo', upstream_path: 'seo/scripts/aeo_audit.py',
      expected_base_sha256: original.original_sha256,
      replacement_path: 'patches/aeo_audit.py',
      replacement_sha256: createHash('sha256').update(replacement).digest('hex'),
      reason: 'Reviewed parser correction fixture'
    }];
    const patchedConfig = path.join(temp, 'vendor.config.json');
    await writeFile(patchedConfig, JSON.stringify(config));
    execFileSync(process.execPath, ['scripts/vendor.mjs', '--sources-root', sourcesRoot, '--output-root', outputRoot, '--config-path', patchedConfig], { cwd: root });
    const patched = JSON.parse(await readFile(path.join(outputRoot, 'skills/optbrew/source-lock.json')));
    const record = patched.files.find(x => x.package_path === original.package_path);
    assert.equal(record.original_sha256, original.original_sha256);
    assert.equal(record.patch_id, 'T2-MAGNUS-PARSER');
    assert.equal(record.patch_reason, 'Reviewed parser correction fixture');
    assert.equal(record.distributed_sha256, config.reviewed_patches[0].replacement_sha256);
    assert.deepEqual(await readFile(path.join(outputRoot, original.package_path)), replacement);
    execFileSync(process.execPath, ['scripts/vendor.mjs', '--sources-root', sourcesRoot, '--output-root', outputRoot, '--config-path', patchedConfig], { cwd: root });
    await writeFile(path.join(outputRoot, original.package_path), 'local edit');
    await assert.rejects(vendor({ sourcesRoot, outputRoot, configPath: patchedConfig }), /local edit|existing file differs/i);
    config.reviewed_patches = [];
    await writeFile(patchedConfig, JSON.stringify(config));
    const apiLock = await vendor({ sourcesRoot, outputRoot: path.join(temp, 'api-out'), configPath: patchedConfig, patchSet: { patches: [badConfigPatch()] } });
    assert.equal(apiLock.files.find(x => x.package_path === original.package_path).patch_id, 'T2-MAGNUS-PARSER');
    const wrongHash = { ...badConfigPatch(), replacement_sha256: '0'.repeat(64) };
    await assert.rejects(vendor({ sourcesRoot, outputRoot: path.join(temp, 'bad-hash-out'), configPath: patchedConfig, patchSet: { patches: [wrongHash] } }), /replacement hash mismatch/i);
    config.first_party_files[0].sha256 = '0'.repeat(64);
    await writeFile(patchedConfig, JSON.stringify(config));
    await assert.rejects(vendor({ sourcesRoot, outputRoot: path.join(temp, 'bad-first-party'), configPath: patchedConfig }), /first-party artifact hash mismatch/i);
    function badConfigPatch() {
      return { id: 'T2-MAGNUS-PARSER', module_id: 'magnus-seo', upstream_path: 'seo/scripts/aeo_audit.py', expected_base_sha256: original.original_sha256, replacement_path: 'patches/aeo_audit.py', replacement_sha256: createHash('sha256').update(replacement).digest('hex'), reason: 'Reviewed parser correction fixture' };
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Google submission commands are disabled, never labelled read-only', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew-submit-'));
  try {
    await vendor({ sourcesRoot, outputRoot: temp, configPath });
    const guide = await readFile(path.join(temp, 'skills/optbrew/modules/seranking-seo/skills/seo-google/GUIDE.md'), 'utf8');
    const reference = await readFile(path.join(temp, 'skills/optbrew/modules/seranking-seo/skills/seo-google/references/indexing-api.md'), 'utf8');
    assert.match(guide, /index <url>[\s\S]{0,300}submission disabled/i);
    assert.match(guide, /index-batch <file>[\s\S]{0,300}submission disabled/i);
    assert.doesNotMatch(guide, /read-only capability[^\n]*(?:index|index-batch|<url>|<file>)/i);
    assert.doesNotMatch(guide, /scripts\/indexing_notify\.py/);
    assert.match(reference, /submission disabled/i);
    assert.match(reference, /separate.*authority/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
