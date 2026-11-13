// Diagnostic only (branch diag/chrome-temp, never merged): which Chrome process writes chrome_url_fetcher folders into the
// temp folder the audit started from? Launch Chrome as the T22 M-7 test does, then read every process's TMPDIR from /proc.
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChrome, launchChrome } from '../skills/optbrew/scripts/core/chrome.mjs';

const found = findChrome();
const rounds = Number(process.argv[2] ?? 20);
const root = await mkdtemp(path.join(os.tmpdir(), 'ob5-'));
const runDir = path.join(root, 'run');
await mkdir(runDir);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chromeProcesses() {
  const out = [];
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (!cmd.some(part => /chrome/i.test(part))) continue;
      const env = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
      const tmp = env.find(v => v.startsWith('TMPDIR='))?.slice(7) ?? '(unset)';
      const type = cmd.find(part => part.startsWith('--type='))?.slice(7) ?? 'browser';
      out.push({ pid: Number(pid), exe: path.basename(cmd[0]), type, tmp });
    } catch { /* gone */ }
  }
  return out;
}

let leaks = 0;
for (let round = 1; round <= rounds; round++) {
  const hostTemp = path.join(root, `host-temp-${round}`);
  await mkdir(hostTemp);
  const names = ['TEMP', 'TMP', 'TMPDIR'], saved = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = hostTemp;
  let seen = [];
  try {
    const chrome = await launchChrome({ path: found.path, tmpRoot: runDir });
    try {
      for (let t = 0; t < 6; t++) { await sleep(1000); seen = await chromeProcesses(); }
    } finally { await chrome.close(); }
  } finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
  await sleep(500);
  const left = await readdir(hostTemp);
  const wrongTmp = seen.filter(p => p.tmp === hostTemp);
  if (left.length) leaks++;
  console.log(JSON.stringify({ round, left, leaked: left.length > 0,
    processes_with_host_tmp: wrongTmp, process_types: [...new Set(seen.map(p => `${p.exe}:${p.type}:${p.tmp === hostTemp ? 'HOST' : p.tmp.includes('optbrew-chrome-') ? 'profile' : p.tmp}`))] }));
  for (const name of left) {
    const s = await stat(path.join(hostTemp, name)).catch(() => null);
    console.log(JSON.stringify({ round, leftover: name, mtime: s?.mtime, entries: await readdir(path.join(hostTemp, name)).catch(() => []) }));
  }
}
console.log(JSON.stringify({ rounds, leaks }));
await rm(root, { recursive: true, force: true });
