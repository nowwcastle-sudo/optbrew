import assert from 'node:assert/strict';
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
