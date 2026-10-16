import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rules = [
  ['anthropic_api_key', /sk-ant-api03-[A-Za-z0-9_-]{32,}/g],
  ['openai_project_key', /sk-proj-[A-Za-z0-9_-]{32,}/g],
  ['github_token', /ghp_[A-Za-z0-9]{36,}/g],
  ['aws_access_key', /AKIA[A-Z0-9]{16}/g],
  // 'AIza' plus 35 characters of [0-9A-Za-z_-] (39 in all), per Microsoft Purview's Google API key definition.
  // Keys with the newer 'AQ.' prefix are not scanned: Google has not documented their format
  // (announcement: discuss.ai.google.dev, 2026-06-12), so no pattern is guessed.
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/g],
];

function scanInputs(inputs) {
  const findings = [];
  const checkedPaths = new Set();
  for (const { path: relative, bytes: content } of inputs) {
    checkedPaths.add(relative);
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [rule, pattern] of rules) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) findings.push({ path: relative, line: i + 1, rule });
      }
    }
  }
  return { checked: inputs.length, checkedPaths: checkedPaths.size, checkedVersions: inputs.length, findings, exitCode: findings.length ? 1 : 0 };
}

export async function scanSecrets({ root, files }) {
  const inputs = [];
  for (const name of files) {
    const relative = name.replaceAll('\\', '/');
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`scan path outside root: ${relative}`);
    try { inputs.push({ path: relative, version: 'working-tree', bytes: await readFile(path.join(root, relative)) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return scanInputs(inputs);
}

export async function readGitScanInputs({ root }) {
  const names = args => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const tracked = [...new Set(names(['--cached']))];
  const untracked = names(['--others', '--exclude-standard']);
  const inputs = [];
  for (const name of tracked) {
    const relative = name.replaceAll('\\', '/');
    const staged = execFileSync('git', ['show', `:${name}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    inputs.push({ path: relative, version: 'index', bytes: staged });
    try {
      const working = await readFile(path.join(root, relative));
      if (!working.equals(staged)) inputs.push({ path: relative, version: 'working-tree', bytes: working });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of untracked) {
    const relative = name.replaceAll('\\', '/');
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`scan path outside root: ${relative}`);
    inputs.push({ path: relative, version: 'untracked', bytes: await readFile(path.join(root, relative)) });
  }
  return inputs;
}

export async function scanTrackedAndStaged({ root }) {
  return scanInputs(await readGitScanInputs({ root }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--tracked-and-staged')) {
    process.stderr.write('usage: node scripts/scan-secrets.mjs --tracked-and-staged\n');
    process.exitCode = 2;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    scanTrackedAndStaged({ root }).then(result => {
      for (const finding of result.findings) process.stdout.write(`${finding.path}:${finding.line} ${finding.rule}\n`);
      process.stdout.write(`checked_paths=${result.checkedPaths} checked_versions=${result.checkedVersions} findings=${result.findings.length}\n`);
      process.exitCode = result.exitCode;
    }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
  }
}
