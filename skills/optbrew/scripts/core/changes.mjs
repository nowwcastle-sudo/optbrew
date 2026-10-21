import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateEntity } from './contracts.mjs';
import { versions } from './config.mjs';

/**
 * The change helper behind `cli.mjs change start` and `change finish`. A change to one source file is two steps. `start` copies the
 * file to `<OUT>/changes/backup/<change_id>-<name>` once and writes `<OUT>/changes/pending/<change_id>.json` with the hash of the
 * bytes it copied. `finish` hashes the file as it is now, refuses when nothing changed, writes the complete ChangeRecord to
 * `<OUT>/changes/<change_id>.json` and removes the pending file. One file has one record in a result folder.
 */
const CHANGES = 'changes', PENDING = 'pending', BACKUP = 'backup';
/** Change ids are `c1`, `c2`, and so on: one more than the highest number any record, pending record or backup already uses. */
const NUMBERED = /^c(\d+)(?:\.json$|-)/;
const RECORD = /^c(\d+)\.json$/;
const HASH = /^[0-9a-f]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The note the record carries until the change is deployed and audited again. */
const NOT_VERIFIED = { status: 'pending', note: '배포 전이라 아직 확인하지 않음' };

const namesIn = directory => readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function writeNewJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return true;
}

async function readRecord(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`change record cannot be read: ${file}`); }
}

/** The records in one folder as `{ file, record }`, in number order; a record `accept` refuses is an error, not a record to skip. */
async function recordsIn(directory, accept = () => true) {
  const names = (await namesIn(directory)).filter(name => RECORD.test(name)).sort((a, b) => a.match(RECORD)[1] - b.match(RECORD)[1]);
  return Promise.all(names.map(async name => {
    const file = path.join(directory, name), record = await readRecord(file);
    if (!accept(record) || record.change_id !== name.slice(0, -'.json'.length)) throw new Error(`change record is damaged: ${file}`);
    return { file, record };
  }));
}
/** What `start` wrote: the words `finish` reads back. */
const isStarted = record => ['change_id', 'path', 'root', 'backup_ref'].every(key => typeof record?.[key] === 'string' && record[key]) &&
  HASH.test(record.before_hash) && Array.isArray(record.finding_ids);
const startedIn = changes => recordsIn(path.join(changes, PENDING), isStarted);
const isRecord = record => { try { validateEntity('ChangeRecord', record); return true; } catch { return false; } };
const finishedIn = changes => recordsIn(changes, isRecord);

/**
 * The real path of `file` (relative paths are read from `root`), which must be a file inside the real `root`. A `..` that leaves the
 * folder and a link that leads out of it are both refused, because the real path is what is compared.
 */
async function sourceFile(root, file) {
  const realRoot = await realpath(path.resolve(root)).catch(() => { throw new Error(`source folder not found: ${root}`); });
  const real = await realpath(path.resolve(realRoot, file)).catch(() => { throw new Error(`file not found: ${file}`); });
  if (!inside(realRoot, real)) throw new Error(`path is outside the source folder: ${file}`);
  if (!(await stat(real)).isFile()) throw new Error(`not a file: ${file}`);
  return { root: realRoot, file: real };
}

async function nextChangeId(changes) {
  const used = [changes, path.join(changes, PENDING), path.join(changes, BACKUP)];
  const numbers = (await Promise.all(used.map(namesIn))).flat().map(name => NUMBERED.exec(name)).filter(Boolean).map(match => Number(match[1]));
  return `c${Math.max(0, ...numbers) + 1}`;
}

/** Back up `file` and note the change as pending. Refuses a file that already has a pending or finished record. */
export async function startChange({ out, root, file, findings }) {
  const finding_ids = [...new Set(findings.map(id => id.trim()))];
  if (!finding_ids.length || finding_ids.includes('')) throw new Error('give at least one finding id with --finding');
  const source = await sourceFile(root, file);
  const changes = path.join(path.resolve(out), CHANGES);
  const covering = (found, refusal) => {
    const item = found.find(({ record }) => record.path === source.file);
    if (item) throw new Error(refusal(item.record.change_id));
  };
  covering(await startedIn(changes), id => `${id} is already started for ${file}; run change finish first`);
  covering(await finishedIn(changes), id => `${id} already holds the change record of ${file}; a result folder has one record per file, so name every finding that changes a file when you start`);
  for (;;) {
    const change_id = await nextChangeId(changes);
    const backup_ref = path.join(changes, BACKUP, `${change_id}-${path.basename(source.file)}`);
    await mkdir(path.dirname(backup_ref), { recursive: true });
    // The backup is made once and never replaced. Its bytes, not a second read of the file, give the hash the record claims.
    await copyFile(source.file, backup_ref, constants.COPYFILE_EXCL);
    const pending = { schema_version: versions().contract_schema, change_id, finding_ids, environment: 'local', path: source.file, root: source.root,
      before_hash: sha256(await readFile(backup_ref)), backup_ref };
    // Creating the pending file exclusively reserves the id: a start running at the same time for another file takes the next one.
    const written = await writeNewJson(path.join(changes, PENDING, `${change_id}.json`), pending)
      .catch(async error => { await rm(backup_ref, { force: true }); if (error.code === 'EEXIST') return false; throw error; });
    if (written) return { change_id, path: pending.path, backup_ref, before_hash: pending.before_hash, finding_ids };
  }
}

/** The pending record of `file` (a relative path is read from the source folder the record names), or null. */
async function pendingOf(changes, file) {
  for (const item of await startedIn(changes)) {
    const real = await realpath(path.resolve(item.record.root, file)).catch(() => null);
    if (real === item.record.path) return item;
  }
  return null;
}

/**
 * Write the ChangeRecord of a started change from the file as it is now. `analysis` is what the caller names: the tools and queries
 * it used, and `self_analysis` true when it read the code itself (the default when it names no tool, false when it names one).
 * Run again after a stop between the two writes, it removes the pending file and returns the record already written.
 */
export async function finishChange({ out, file, tools = [], queries = [], selfAnalysis }) {
  const changes = path.join(path.resolve(out), CHANGES);
  const begun = await pendingOf(changes, file);
  if (!begun) throw new Error(`no change was started for ${file}; run change start first (a finished change is not finished again)`);
  const { record: start } = begun;
  const backup = await readFile(start.backup_ref).catch(() => null);
  if (!backup || sha256(backup) !== start.before_hash) throw new Error(`the backup of ${file} is missing or changed: ${start.backup_ref}`);
  const current = await readFile(start.path).catch(() => { throw new Error(`file not found: ${file}`); });
  const after_hash = sha256(current);
  if (after_hash === start.before_hash) throw new Error(`${file} is unchanged since change start (${start.change_id}); change the file, then run change finish`);
  const names = values => [...new Set(values.map(value => value.trim()).filter(Boolean))];
  const record = { schema_version: versions().contract_schema, change_id: start.change_id, finding_ids: start.finding_ids, environment: start.environment,
    path: start.path, before_hash: start.before_hash, after_hash, backup_ref: start.backup_ref, verification: NOT_VERIFIED, evidence_ref: start.path,
    analysis: { tools: names(tools), queries: names(queries), self_analysis: selfAnalysis ?? (names(tools).length === 0) } };
  validateEntity('ChangeRecord', record);
  const finished = path.join(changes, `${record.change_id}.json`);
  const earlier = await stat(finished).then(() => readRecord(finished), error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (earlier && (earlier.before_hash !== record.before_hash || earlier.after_hash !== record.after_hash))
    throw new Error(`${record.change_id} was already finished with other bytes: ${finished}`);
  const result = earlier ?? record;
  if (!earlier) await writeJson(finished, record);
  await rm(begun.file, { force: true });
  return result;
}
