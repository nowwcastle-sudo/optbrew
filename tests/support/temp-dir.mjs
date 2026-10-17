import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const created = new Set();
// Importing this module registers one file-level hook, so helpers need no test context to guarantee cleanup.
after(() => Promise.all([...created].map(dir => rm(dir, { recursive: true, force: true }))));

/** Create a temp dir that is removed when the importing test file finishes. */
export async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}
