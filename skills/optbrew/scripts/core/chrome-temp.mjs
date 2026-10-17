import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { limits } from './config.mjs';

/** Chrome's temp folders: the environment it runs in, and the sweep of profile folders a killed launcher left (T22 M-7). */

const LIST_LINES_WINDOWS = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:OPTBREW_MARKER) } | ForEach-Object { $_.CommandLine }';

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
/** A profile folder this young may still be starting (created, Chrome not yet running), so the sweep leaves it. */
const YOUNG_PROFILE_MS = 60_000;

/**
 * The environment Chrome runs in: `tempDir`, a folder inside this run's profile folder, in place of the user's temporary folder.
 * What Chrome writes there (its `scoped_dir*` folders and component updates) is removed with the profile, even after a forced kill
 * skipped Chrome's own cleanup. Existing TEMP, TMP and TMPDIR entries are dropped in any letter case, so the child sees one value each.
 */
export function chromeEnv(env, tempDir) {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !TEMP_VARIABLES.test(name)));
  return { ...kept, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };
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
