import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function readInstallRecord(scopeRoot) {
  const file = path.join(scopeRoot, 'install-record.json');
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('install record is a link');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.schema_version !== '1.0.0' || !Array.isArray(record.targets) || !record.bundle_hash || !record.managed_root) throw new Error('invalid install record');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeInstallRecord(scopeRoot, record) {
  await mkdir(scopeRoot, { recursive: true });
  const file = path.join(scopeRoot, 'install-record.json');
  const temp = path.join(scopeRoot, `.install-record.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
