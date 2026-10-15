import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { releaseMetadataErrors } from '../scripts/verify-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));

test('the Claude marketplace serves a plugin root that claude.ai accepts', async () => {
  const marketplace = await readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.match(entry.source, /^\.\/[^.]/, 'source is a relative folder inside the repository, not the repository root');
  const pluginRoot = path.join(root, entry.source);

  // claude.ai and Cowork refuse to install a plugin with a top-level bin/ directory.
  const top = await readdir(pluginRoot);
  assert.ok(!top.includes('bin'), `${entry.source} must not contain bin/`);

  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, entry.name);
  for (const skill of manifest.skills) {
    assert.ok((await stat(path.join(pluginRoot, skill, 'SKILL.md'))).isFile(), `${skill}/SKILL.md exists`);
  }
});

test('the served plugin has no pinned version, so every commit reaches marketplace sync', async () => {
  const [entry] = (await readJson('.claude-plugin/marketplace.json')).plugins;
  const manifest = await readJson(path.join(entry.source, '.claude-plugin/plugin.json'));
  assert.ok(!('version' in entry));
  assert.ok(!('version' in manifest));
});

// The directory submission reads only the plugin folder (Plugin path = the marketplace source).
// Limits from https://claude.com/docs/plugins/pre-submission-checklist, checked 2026-10-15.
test('the served plugin folder meets the directory listing rules', async () => {
  const [entry] = (await readJson('.claude-plugin/marketplace.json')).plugins;
  const pluginRoot = path.join(root, entry.source);
  const manifest = await readJson(path.join(entry.source, '.claude-plugin/plugin.json'));

  const readme = await readFile(path.join(pluginRoot, 'README.md'), 'utf8');
  const words = readme.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 40, `README.md has ${words.length} words outside code blocks; the directory needs 40`);
  assert.equal(manifest.license, 'MIT');
  for (const field of ['description', 'author', 'homepage', 'repository']) assert.ok(manifest[field], `plugin.json sets ${field}`);

  // Icon: square PNG, 512 to 2048 px, under 2 MB, read from the PNG header.
  const icon = await readFile(path.join(pluginRoot, manifest.icon));
  assert.deepEqual([...icon.subarray(1, 4)], [0x50, 0x4e, 0x47], 'icon is a PNG');
  const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.equal(width, height, 'icon is square');
  assert.ok(width >= 512 && width <= 2048, `icon is ${width} px`);
  assert.ok(icon.length < 2 * 1024 * 1024, 'icon is under 2 MB');

  // Files: at most 512, non-images under 256 KiB, no system files. Tracked files only, as the directory reads the commit.
  const listed = spawnSync('git', ['ls-files', '-z', '--', entry.source], { cwd: root, encoding: 'utf8' });
  const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  if (!files.length) return; // not a git checkout: the size rules are checked in the repository
  assert.ok(files.length <= 512, `${files.length} files in the plugin folder`);
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)/i, `${file} is a system file`);
    if (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(file)) continue;
    assert.ok((await stat(path.join(root, file))).size < 256 * 1024, `${file} is 256 KiB or larger`);
  }
});

test('release metadata accepts the current marketplace layout', async () => {
  const { version } = await readJson('package.json');
  assert.deepEqual(await releaseMetadataErrors(root, version), []);
});
