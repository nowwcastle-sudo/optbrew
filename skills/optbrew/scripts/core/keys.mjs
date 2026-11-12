import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_NAME = 'OPTBREW_GOOGLE_API_KEY';
// The Claude plugin's `google_api_key` setting (userConfig, sensitive) reaches only hook processes. The plugin's SessionStart
// hook writes it to the owner-only `plugin-key.json` beside the key file, never to the session environment, so the shell
// commands of the session (a site project's scripts among them) do not inherit it. A session started by a release before
// 0.3.5 still has it in its environment under this name, so that is read after the plugin key file.
const PLUGIN_ENV_NAME = 'CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY';
const HASH_CHARS = 8;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** The home folder the key file lives in: USERPROFILE on Windows, HOME elsewhere, then the OS answer. Never a site or output folder. */
export function keyHome(env = process.env, platform = process.platform) {
  return (platform === 'win32' ? env?.USERPROFILE : env?.HOME) || os.homedir();
}

const credentialsPath = home => path.join(home, '.optbrew', 'credentials.json');
const pluginKeyPath = home => path.join(home, '.optbrew', 'plugin-key.json');

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

/** The Claude plugin setting: the file the SessionStart hook wrote, then the environment of a session started before 0.3.5. */
const pluginSetting = (env, home) => clean(readCredentials(pluginKeyPath(home)).google) ?? clean(env?.[PLUGIN_ENV_NAME]);

/**
 * The Claude plugin setting first, then the environment variable, then the key file. An empty value, a missing file or a
 * corrupt file all mean "no key".
 */
export function readGoogleKey({ env = process.env, home = keyHome(env) } = {}) {
  return pluginSetting(env, home) ?? clean(env?.[ENV_NAME]) ?? clean(readCredentials(credentialsPath(home)).google);
}

/**
 * Presence and the first 8 hex characters of the SHA-256; the key value itself is never returned. A key file that exists but is
 * not a JSON object adds `corrupt: true` (the file is only read, never changed), so the user is told to fix it instead of
 * being told there is no key. `sources` says, without values, what each source held: the Claude plugin setting, the
 * environment variable, the key file (`present`, `absent` or `corrupt`), and which one is `used` (null when none).
 */
export function googleKeyStatus({ env = process.env, home = keyHome(env) } = {}) {
  const key = readGoogleKey({ env, home });
  let credentials = null;
  try { credentials = loadCredentials(credentialsPath(home)); } catch { /* corrupt, reported below */ }
  const corrupt = credentials === null;
  const plugin = pluginSetting(env, home) !== null;
  const envVar = clean(env?.[ENV_NAME]) !== null;
  const keyFile = corrupt ? 'corrupt' : clean(credentials.google) === null ? 'absent' : 'present';
  const used = plugin ? 'plugin_setting' : envVar ? 'env' : keyFile === 'present' ? 'key_file' : null;
  return { google: {
    present: key !== null,
    sha256_8: key === null ? null : createHash('sha256').update(key).digest('hex').slice(0, HASH_CHARS),
    ...(corrupt ? { corrupt: true } : {}),
    sources: { plugin_setting: plugin, env: envVar, key_file: keyFile, used },
  } };
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

/** The SessionStart hook's half: keep the Claude plugin setting in the owner-only plugin key file (temp file, then rename). */
export async function writePluginKey({ home = keyHome(), key }) {
  await writeCredentials(pluginKeyPath(home), { google: key });
}

/**
 * Drop only the google entry; the file itself goes away once nothing else is left in it. The plugin key file goes too, so a
 * copy left behind after the plugin was removed can be cleared (a plugin setting still in Claude Code writes it again at the
 * next session start). Returns whether either held a key.
 */
export async function removeGoogleKey({ home = keyHome() } = {}) {
  const pluginFile = pluginKeyPath(home);
  const hadPlugin = clean(readCredentials(pluginFile).google) !== null;
  await rm(pluginFile, { force: true });
  const file = credentialsPath(home);
  const { google, ...rest } = loadCredentials(file);
  if (google === undefined) return hadPlugin;
  if (Object.keys(rest).length) await writeCredentials(file, rest);
  else await rm(file, { force: true });
  return true;
}
