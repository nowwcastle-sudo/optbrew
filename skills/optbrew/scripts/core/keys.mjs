import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_NAME = 'OPTBREW_GOOGLE_API_KEY';
const HASH_CHARS = 8;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** The key file lives under the user's home, never in a site or output folder. */
const credentialsPath = home => path.join(home, '.optbrew', 'credentials.json');

const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Environment variable first, then the key file. An empty variable, a missing file or a corrupt file all mean "no key". */
export function readGoogleKey({ env = process.env, home }) {
  const fromEnv = clean(env?.[ENV_NAME]);
  if (fromEnv) return fromEnv;
  try { return clean(JSON.parse(readFileSync(credentialsPath(home), 'utf8'))?.google); }
  catch { return null; }
}

/** Presence and the first 8 hex characters of the SHA-256; the key value itself is never returned. */
export function googleKeyStatus({ env, home }) {
  const key = readGoogleKey({ env, home });
  return { google: { present: key !== null, sha256_8: key === null ? null : createHash('sha256').update(key).digest('hex').slice(0, HASH_CHARS) } };
}

/** Replace the key file atomically (temp file, then rename) so a reader never sees a half-written file. */
export async function saveGoogleKey({ home, key }) {
  const file = credentialsPath(home);
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: OWNER_ONLY_DIR });
  try {
    await writeFile(temp, `${JSON.stringify({ google: key })}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    // Windows has no POSIX modes (chmod only toggles read-only there); the home folder's own ACL protects the file.
    if (process.platform !== 'win32') await chmod(temp, OWNER_ONLY_FILE);
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export async function removeGoogleKey({ home }) {
  await rm(credentialsPath(home), { force: true });
}
