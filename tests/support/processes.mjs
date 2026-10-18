import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const LIST_WINDOWS = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:OPTBREW_MARKER) } |
  ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;

/**
 * Processes whose command line contains `marker`, as `{ pid, commandLine }`. The marker travels in the environment, not on
 * this query's own command line, so the query never finds itself. Used to tell this test run's Chrome from anyone else's.
 */
export async function processesWith(marker) {
  const env = { ...process.env, OPTBREW_MARKER: marker };
  const { stdout } = process.platform === 'win32' ?
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOWS], { env, maxBuffer: 1 << 24 }) :
    await run('ps', ['-eo', 'pid=,args='], { maxBuffer: 1 << 24 });
  return stdout.split(/\r?\n/).map(line => /^\s*(\d+)[\t ]+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, commandLine]) => ({ pid: Number(pid), commandLine }))
    .filter(entry => entry.commandLine.includes(marker) && entry.pid !== process.pid);
}

/**
 * The processes still listed for `marker` after waiting for them to end: Windows keeps a killed process in the list for a
 * while on a busy machine, so "none left" is judged once the list is empty or `waitMs` has passed (then it is the last list).
 */
export async function remaining(marker, waitMs = 20000) {
  const deadline = Date.now() + waitMs;
  let found = await processesWith(marker);
  while (found.length && Date.now() < deadline) found = await processesWith(marker);
  return found;
}

/** Kill a process tree by pid (`taskkill /T /F` on Windows, the process group elsewhere). Never kills by image name. */
export async function killTreeByPid(pid) {
  if (process.platform === 'win32') await run('taskkill', ['/T', '/F', '/PID', String(pid)]).catch(() => {});
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
}
