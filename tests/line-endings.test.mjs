import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const inRepo = git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';

test('.gitattributes sets no attribute that rewrites files at checkout', async () => {
  const lines = (await readFile(path.join(root, '.gitattributes'), 'utf8')).split('\n').filter(line => line.trim() && !line.startsWith('#'));
  // Claude marketplace validation rejects checkout rewrites; -text only turns conversion off.
  for (const line of lines) {
    const attrs = line.trim().split(/\s+/).slice(1);
    for (const attr of attrs) assert.match(attr, /^-text$/, `.gitattributes line "${line}" sets ${attr}`);
  }
});

test('every committed file is stored with LF, so a checkout without conversion matches the bundle hashes', { skip: inRepo ? false : 'not a git checkout' }, () => {
  const listing = git(['ls-files', '--eol']);
  assert.equal(listing.status, 0, listing.stderr);
  const crlf = listing.stdout.split('\n').filter(line => /^i\/(crlf|mixed)/.test(line));
  assert.deepEqual(crlf, [], 'commit these files with LF line endings');
});
