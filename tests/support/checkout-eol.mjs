import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listing = spawnSync('git', ['ls-files', '--eol', '--', 'skills'], { cwd: root, encoding: 'utf8' });
// skills/ has no .gitattributes, so a core.autocrlf=true checkout holds CRLF skill files. The ZIP and npm
// verifiers compare exact bytes and refuse them; docs/release.md builds releases from a core.autocrlf=false clone.
export const skipCrlfCheckout = listing.status === 0 && /\sw\/crlf\s/.test(listing.stdout)
  ? 'skill files are CRLF in this checkout (core.autocrlf=true); release artifacts are built from a core.autocrlf=false clone'
  : false;
