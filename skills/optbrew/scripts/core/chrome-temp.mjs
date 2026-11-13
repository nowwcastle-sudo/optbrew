import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { limits } from './config.mjs';

/** Chrome's temp folders: the environment it runs in, and the sweep of profile folders a killed launcher left (T22 M-7). */

const LIST_LINES_WINDOWS = '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:OPTBREW_MARKER) } | ForEach-Object { $_.CommandLine }';

/** Command lines (whole lines) that name `marker`; null when the listing failed or timed out, so a caller never mistakes "could not look" for "nothing there". */
function commandLinesNaming(marker, timeoutMs) {
  const [command, args] = process.platform === 'win32' ?
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', LIST_LINES_WINDOWS]] : ['ps', ['-ww', '-eo', 'args=']];
  return new Promise(resolve => {
    execFile(command, args, { env: { ...process.env, OPTBREW_MARKER: marker }, maxBuffer: 1 << 24, windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : stdout.split(/\r?\n/).filter(line => line.includes(marker)));
    });
  });
}

export const PROFILE_PREFIX = 'optbrew-chrome-';
const TEMP_VARIABLES = /^(?:temp|tmp|tmpdir)$/i;
/**
 * A profile folder younger than this may belong to a run still going (one whose command line this process cannot read, e.g. an elevated
 * Chrome), so the sweep leaves it. An audit takes minutes; a folder left for half a day is from a launcher that was killed.
 */
const YOUNG_PROFILE_MS = 12 * 60 * 60_000;

/**
 * The environment Chrome runs in: `tempDir`, a folder inside this run's profile folder, in place of the user's temporary folder.
 * What Chrome writes there (its `scoped_dir*` folders and component updates) is removed with the profile, even after a forced kill
 * skipped Chrome's own cleanup. Existing TEMP, TMP and TMPDIR entries are dropped in any letter case, so the child sees one value each.
 *
 * Off Windows, Chrome binds its single-instance socket at `<temp folder>/.org.chromium.Chromium.XXXXXX/SingletonSocket`, and a Unix
 * socket path is limited to 107 bytes on Linux and 104 on macOS; Chrome aborts at start when it is longer (Chromium
 * `process_singleton_posix.cc`: "Socket path too long"). A profile under a long folder (a macOS `/var/folders/...` temp folder, a
 * folder with Hangul, which takes three bytes a character) would put `tempDir` past that, so then Chrome keeps the user's own temp
 * folder, as it did before this redirect. `platform` is injectable for tests.
 */
const MAX_REDIRECTED_TEMP_BYTES = 48;
export function chromeEnv(env, tempDir, platform = process.platform) {
  if (platform !== 'win32' && Buffer.byteLength(tempDir) > MAX_REDIRECTED_TEMP_BYTES) return { ...env };
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !TEMP_VARIABLES.test(name)));
  return { ...kept, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };
}

/**
 * The temp folder Chrome gets. It is `<profile>/tmp` when that is short enough (always on Windows). Otherwise, off Windows, it is a
 * new folder in `/tmp` (`optbrew-t-XXXXXX`, owner-only, about 21 bytes), because keeping the user's temp folder let Chrome's
 * background downloads leave `chrome_url_fetcher_*` folders there (ubuntu CI, T22 M-7: a runner's mkdtemp names made `<profile>/tmp`
 * 57 bytes). That folder names its profile in an `owner` file; `close()` removes it, and `sweepStaleShortTemps` removes one whose
 * profile is gone. `null` = no short folder could be made (no writable `/tmp`): Chrome keeps the user's temp folder, as before.
 * Returns `{ dir, own }`: `own` is true when the folder is outside the profile and must be removed separately.
 */
const SHORT_TEMP_PREFIX = 'optbrew-t-';
const SHORT_TEMP_OWNER = 'owner';
export async function chromeTempDir(userDataDir, { platform = process.platform, shortRoot = '/tmp' } = {}) {
  const inside = path.join(userDataDir, 'tmp');
  await mkdir(inside);
  if (platform === 'win32' || Buffer.byteLength(inside) <= MAX_REDIRECTED_TEMP_BYTES) return { dir: inside, own: false };
  let dir;
  try { dir = await mkdtemp(path.join(shortRoot, SHORT_TEMP_PREFIX)); } catch { return null; }
  if (Buffer.byteLength(dir) > MAX_REDIRECTED_TEMP_BYTES) { await rm(dir, { recursive: true, force: true }); return null; }
  try { await writeFile(path.join(dir, SHORT_TEMP_OWNER), userDataDir, { mode: 0o600 }); }
  catch { await rm(dir, { recursive: true, force: true }); return null; }
  return { dir, own: true };
}

/**
 * Remove the short temp folders of earlier launches whose launcher was killed: a folder goes only when it is not young and the
 * profile its `owner` file names no longer exists (that profile is removed by `close()` or by `sweepStaleProfiles`). A folder
 * without a readable owner is left alone: it may not be ours. Returns the names removed.
 */
export async function sweepStaleShortTemps(shortRoot = '/tmp', { now = Date.now() } = {}) {
  let names;
  try { names = (await readdir(shortRoot)).filter(name => name.startsWith(SHORT_TEMP_PREFIX)); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const dir = path.join(shortRoot, name);
    try {
      if (now - (await stat(dir)).mtimeMs <= YOUNG_PROFILE_MS) continue;
      const owner = await readFile(path.join(dir, SHORT_TEMP_OWNER), 'utf8');
      if (!path.basename(owner).startsWith(PROFILE_PREFIX)) continue;
      if (await stat(owner).then(() => true, () => false)) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(name);
    } catch { /* unreadable, gone or locked: leave it */ }
  }
  return removed;
}

/**
 * Remove the profile folders of earlier launches whose launcher was killed before it could clean up. A folder goes only when it is not
 * young and no running process names it; when the process list cannot be read nothing is removed. `listLines(marker)` returns the
 * command lines that name the marker, or null (injectable for tests). Returns the names removed.
 */
export async function sweepStaleProfiles(tmpRoot, { now = Date.now(), listLines = marker => commandLinesNaming(marker, limits().chrome_close_grace_ms) } = {}) {
  let names;
  try { names = (await readdir(tmpRoot)).filter(name => name.startsWith(PROFILE_PREFIX)); } catch { return []; }
  const old = [];
  for (const name of names) {
    try { if (now - (await stat(path.join(tmpRoot, name))).mtimeMs > YOUNG_PROFILE_MS) old.push(name); } catch { /* gone already */ }
  }
  if (!old.length) return [];
  const lines = await listLines(PROFILE_PREFIX);
  if (lines === null) return [];
  const removed = [];
  for (const name of old) {
    if (lines.some(line => line.includes(name))) continue;
    try { await rm(path.join(tmpRoot, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); removed.push(name); } catch { /* in use or locked: the next start tries again */ }
  }
  return removed;
}
