import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_NAME = 'OPTBREW_GOOGLE_API_KEY';
const HASH_CHARS = 8;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** The home folder the key file lives in: USERPROFILE on Windows, HOME elsewhere, then the OS answer. Never a site or output folder. */
export function keyHome(env = process.env, platform = process.platform) {
  return (platform === 'win32' ? env?.USERPROFILE : env?.HOME) || os.homedir();
}

const credentialsPath = home => path.join(home, '.optbrew', 'credentials.json');

const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The key file as a plain object for code that rewrites it. A missing file is empty; an unreadable, corrupt or
 * non-object file is refused, so a hand-edited file with a typo is never overwritten or deleted. The error names
 * the path only, never the file's contents.
 */
function loadCredentials(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`credentials file at ${file} is not a valid JSON object; fix it or delete it, then run the command again`);
  return value;
}

/** The same file for readers: anything unusable means "no key". */
function readCredentials(file) {
  try { return loadCredentials(file); } catch { return {}; }
}

/** Environment variable first, then the key file. An empty variable, a missing file or a corrupt file all mean "no key". */
export function readGoogleKey({ env = process.env, home = keyHome(env) } = {}) {
  return clean(env?.[ENV_NAME]) ?? clean(readCredentials(credentialsPath(home)).google);
}

/** Presence and the first 8 hex characters of the SHA-256; the key value itself is never returned. */
export function googleKeyStatus({ env = process.env, home = keyHome(env) } = {}) {
  const key = readGoogleKey({ env, home });
  return { google: { present: key !== null, sha256_8: key === null ? null : createHash('sha256').update(key).digest('hex').slice(0, HASH_CHARS) } };
}

/** Replace the key file atomically (temp file, then rename) so a reader never sees a half-written file. */
async function writeCredentials(file, credentials) {
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: OWNER_ONLY_DIR });
  try {
    await writeFile(temp, `${JSON.stringify(credentials)}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    // Windows has no POSIX modes (chmod only toggles read-only there); the home folder's own ACL protects the file.
    if (process.platform !== 'win32') {
      await chmod(path.dirname(file), OWNER_ONLY_DIR);
      await chmod(temp, OWNER_ONLY_FILE);
    }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

/** Store the key and keep every other entry already in the file. */
export async function saveGoogleKey({ home = keyHome(), key }) {
  const file = credentialsPath(home);
  await writeCredentials(file, { ...loadCredentials(file), google: key });
}

/** Drop only the google entry; the file itself goes away once nothing else is left in it. Returns whether an entry existed. */
export async function removeGoogleKey({ home = keyHome() } = {}) {
  const file = credentialsPath(home);
  const { google, ...rest } = loadCredentials(file);
  if (google === undefined) return false;
  if (Object.keys(rest).length) await writeCredentials(file, rest);
  else await rm(file, { force: true });
  return true;
}
