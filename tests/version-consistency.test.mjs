import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versions } from '../skills/optbrew/scripts/core/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = versions().release;
const read = file => readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));

// The release version stands in these JSON fields. A manifest that carries no version field is not listed.
const jsonVersions = [
  ['package.json', manifest => manifest.version],
  ['package-lock.json', lock => lock.version],
  ['package-lock.json', lock => lock.packages[''].version],
  ['plugin.json', manifest => manifest.version],
  ['plugin.json', manifest => manifest.extensions['com.openai'].release_version],
  ['.claude-plugin/plugin.json', manifest => manifest.version],
  ['.codex-plugin/plugin.json', manifest => manifest.version],
  ['.codex-plugin/plugin.json', manifest => manifest.extensions['com.openai'].release_version],
  ['skills/optbrew/bundle-manifest.json', manifest => manifest.release_version],
];

// Where text names the release it installs or documents: an npm pin, a tag in a raw or blob URL, a clone branch, a heading sentence.
const pinPatterns = [
  /optbrew@(\d+\.\d+\.\d+)/g,
  /optbrew\/(?:blob\/)?v(\d+\.\d+\.\d+)\//g,
  /--branch v(\d+\.\d+\.\d+)/g,
  /Optbrew v(\d+\.\d+\.\d+)/g,
  /checkout is version (\d+\.\d+\.\d+)/g,
  /--version (\d+\.\d+\.\d+)/g,
];
/** The files that pin a version in text, with the fewest pins each must carry (`skills/README.md` has none today; a pin added there is checked). */
const textFiles = { 'README.md': 1, 'README.ko.md': 1, 'AGENT_INSTALL.md': 1, 'install.ps1': 1, 'docs/platforms.md': 1, 'docs/release.md': 1, 'skills/README.md': 0 };

const pinsIn = text => pinPatterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1]));
const stale = text => pinsIn(text).filter(version => version !== release);

test('the version sources agree on the release in versions.json', () => {
  assert.match(release, /^\d+\.\d+\.\d+$/);
  for (const [file, pick] of jsonVersions) assert.equal(pick(json(file)), release, `${file} must carry ${release}`);
});

test('a manifest that may carry a version either carries the release or carries none', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  const carried = [json('skills/.claude-plugin/plugin.json').version, marketplace.version, ...marketplace.plugins.map(plugin => plugin.version)];
  for (const version of carried.filter(value => value !== undefined)) assert.equal(version, release);
});

test('every pinned install value in the docs and the installer is the release', () => {
  for (const [file, minimum] of Object.entries(textFiles)) {
    const text = read(file);
    assert.ok(pinsIn(text).length >= minimum, `${file} lost its pinned versions (expected at least ${minimum})`);
    assert.deepEqual(stale(text), [], `${file} pins a version other than ${release}`);
  }
});

test('the pin scan finds each kind of pin, so a stale one cannot pass unseen', () => {
  const sample = [
    'npm install -g optbrew@0.0.9',
    'irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.0.8/install.ps1 | iex',
    'see https://github.com/nowwcastle-sudo/optbrew/blob/v0.0.7/docs/platforms.md',
    'git clone --depth 1 --branch v0.0.6 https://github.com/nowwcastle-sudo/optbrew',
    'Optbrew v0.0.5 contains one skill',
    'This checkout is version 0.0.4.',
    'node scripts/build-release.mjs --version 0.0.3 --output-dir dist',
    `current: optbrew@${release}`,
  ].join('\n');
  assert.deepEqual(stale(sample).sort(), ['0.0.3', '0.0.4', '0.0.5', '0.0.6', '0.0.7', '0.0.8', '0.0.9']);
});
