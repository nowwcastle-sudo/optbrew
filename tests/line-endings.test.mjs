import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fileDigest } from '../skills/optbrew/scripts/core/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const inRepo = git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';

test('no .gitattributes at the root or inside the served skills/ plugin', { skip: inRepo ? false : 'not a git checkout' }, () => {
  // The Claude plugin directory refuses a .gitattributes at the root, above the plugin folder or inside it,
  // whatever its lines say (-text included).
  const listing = git(['ls-files', '--', '.gitattributes', 'skills/.gitattributes', 'skills/**/.gitattributes']);
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.split('\n').filter(Boolean), []);
});

test('a CRLF checkout hashes like the committed LF bytes; a binary file hashes as is', () => {
  const lf = Buffer.from('a\nb\n');
  assert.equal(fileDigest(Buffer.from('a\r\nb\r\n')), fileDigest(lf));
  assert.equal(fileDigest(lf), createHash('sha256').update(lf).digest('hex'));
  const binary = Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x00, 0x0d, 0x0a]);
  assert.equal(fileDigest(binary), createHash('sha256').update(binary).digest('hex'));
});

test('every committed file is stored with LF, so the bundle hashes match the committed bytes', { skip: inRepo ? false : 'not a git checkout' }, () => {
  const listing = git(['ls-files', '--eol']);
  assert.equal(listing.status, 0, listing.stderr);
  const crlf = listing.stdout.split('\n').filter(line => /^i\/(crlf|mixed)/.test(line));
  assert.deepEqual(crlf, [], 'commit these files with LF line endings');
});
