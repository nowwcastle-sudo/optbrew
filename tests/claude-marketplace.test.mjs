import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
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

test('release metadata accepts the current marketplace layout', async () => {
  const { version } = await readJson('package.json');
  assert.deepEqual(await releaseMetadataErrors(root, version), []);
});
