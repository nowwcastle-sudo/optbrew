import { mkdir, readFile, open, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { versions } from '../skills/optbrew/scripts/core/config.mjs';

export function validateInstallRecord(record) {
  if (record?.schema_version !== versions().install_record_schema) throw new Error('migration_required: unsupported install record schema; use a compatible optbrew release');
  if (!Array.isArray(record.targets) || !/^[a-f0-9]{64}$/.test(record.bundle_hash) ||
      typeof record.managed_root !== 'string' || typeof record.scope_id !== 'string' ||
      typeof record.release_version !== 'string' || !record.file_hashes || typeof record.file_hashes !== 'object' ||
      !Array.isArray(record.previous_releases) || !['pending', 'committed'].includes(record.transaction?.state)) throw new Error('invalid install record');
  if (Object.entries(record.file_hashes).some(([name, hash]) => path.isAbsolute(name) || name.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid install record file hashes');
  return record;
}

/** Flush bytes before atomic replacement; callers hold the scope lock. */
export async function writeDurableJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    // Windows cannot open directories for fsync. File flush + rename remains atomic there.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temp, { force: true }); }
}

export async function readInstallRecord(scopeRoot) {
  const file = path.join(scopeRoot, 'install-record.json');
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('install record is a link');
    const record = JSON.parse(await readFile(file, 'utf8'));
    return validateInstallRecord(record);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeInstallRecord(scopeRoot, record) {
  await mkdir(scopeRoot, { recursive: true });
  const file = path.join(scopeRoot, 'install-record.json');
  await writeDurableJson(file, record);
}
