import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INDEX_FILE = 'evidence-index.json';
// Raw collected bodies keep their own extension; every other kind is a JSON record.
const RAW_KINDS = new Set(['html', 'bin', 'render-dom']);
// Written with the index so an audit that fetched nothing still has them; the others appear on first append.
const BASE_SECTIONS = ['raw', 'responses', 'failures'];
const ALL_SECTIONS = [...BASE_SECTIONS, 'renders', 'render_ledger', 'cwv'];
// One queue per index file for the whole process, so two stores on one directory never interleave a read-modify-write.
const queues = new Map();
const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

/**
 * Read evidence bytes after checking that the file stays inside root and matches its recorded hash.
 * `ref` is absolute or relative to root. Report replay and Store.read both read through this.
 */
export function readVerified(root, ref, sha256) {
  const file = path.resolve(root, ref);
  if (!within(path.resolve(root), file) || !within(realpathSync(root), realpathSync(file)))
    throw new Error(`evidence path outside run directory: ${ref}`);
  const bytes = readFileSync(file);
  if (sha256Of(bytes) !== sha256) throw new Error(`evidence hash mismatch: ${ref}`);
  return bytes;
}

/**
 * One directory of run evidence. Objects are content-addressed and written once; the index is a JSON file replaced
 * atomically on every append, so a crash leaves either the old index or the new one, never a half-written file.
 * `header` holds the index's leading fields and is used only when the run has no index yet.
 */
export function openStore(dir, header = null) {
  const indexRef = path.join(dir, INDEX_FILE);
  const empty = () => ({ ...header, ...Object.fromEntries(BASE_SECTIONS.map(name => [name, []])) });
  const queueKey = path.resolve(indexRef);
  const serial = job => {
    const run = (queues.get(queueKey) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => {}).then(() => { if (queues.get(queueKey) === tail) queues.delete(queueKey); });
    queues.set(queueKey, tail);
    return run;
  };
  const load = async () => {
    try { return JSON.parse(await readFile(indexRef, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const save = async index => {
    const temporary = `${indexRef}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`);
      await rename(temporary, indexRef);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  return {
    indexRef,
    /** Write `bytes` once. The file is named by its hash, or by `name` for a fixed-name run document. */
    async write(kind, bytes, { name } = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`invalid evidence kind: ${kind}`);
      if (name !== undefined && (!name || path.basename(name) !== name)) throw new Error(`invalid evidence name: ${name}`);
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const sha256 = sha256Of(data);
      const ref = path.join(dir, name ?? `${sha256}.${RAW_KINDS.has(kind) ? kind : `${kind}.json`}`);
      try { await writeFile(ref, data, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readFile(ref)).equals(data)) throw new Error(`evidence ${path.basename(ref)} already exists with different content`);
      }
      return { ref, sha256 };
    },
    /** Add one entry to a section of the index (created on first use) and replace the index file. */
    append(section, entry) {
      if (!/^[a-z][a-z0-9_]*$/.test(section)) throw new Error(`invalid index section: ${section}`);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`index entry must be an object: ${section}`);
      return serial(async () => {
        const index = (await load()) ?? empty();
        if (!Object.hasOwn(index, section)) index[section] = [];
        else if (!Array.isArray(index[section])) throw new Error(`not an index section: ${section}`);
        index[section].push(entry);
        await save(index);
      });
    },
    /** The current index with every section present. With a header and no index file yet, the index is created first. */
    index() {
      return serial(async () => {
        let index = await load();
        if (!index && header) await save(index = empty());
        return { ...Object.fromEntries(ALL_SECTIONS.map(name => [name, []])), ...index };
      });
    },
    /** Bytes of a ref returned by write or listed in the index; throws if the file is outside the store or its hash differs. */
    async read(ref, sha256) {
      // A ref from write() is dir-joined (cwd-relative when dir is); any other relative ref is relative to dir, as in readVerified.
      const returned = path.resolve(ref);
      return readVerified(dir, within(path.resolve(dir), returned) ? returned : ref, sha256);
    },
  };
}
