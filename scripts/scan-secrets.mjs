import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rules = [
  ['anthropic_api_key', /sk-ant-api03-[A-Za-z0-9_-]{32,}/g],
  ['openai_project_key', /sk-proj-[A-Za-z0-9_-]{32,}/g],
  ['github_token', /ghp_[A-Za-z0-9]{36,}/g],
  ['aws_access_key', /AKIA[A-Z0-9]{16}/g],
];

export async function scanSecrets({ root, files }) {
  const findings = [];
  let checked = 0;
  for (const name of files) {
    const relative = name.replaceAll('\\', '/');
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`scan path outside root: ${relative}`);
    let content;
    try { content = await readFile(path.join(root, relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    checked++;
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [rule, pattern] of rules) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) findings.push({ path: relative, line: i + 1, rule });
      }
    }
  }
  return { checked, findings, exitCode: findings.length ? 1 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--tracked-and-staged')) {
    process.stderr.write('usage: node scripts/scan-secrets.mjs --tracked-and-staged\n');
    process.exitCode = 2;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
    const files = listed.toString('utf8').split('\0').filter(Boolean);
    scanSecrets({ root, files }).then(result => {
      for (const finding of result.findings) process.stdout.write(`${finding.path}:${finding.line} ${finding.rule}\n`);
      process.stdout.write(`checked=${result.checked} findings=${result.findings.length}\n`);
      process.exitCode = result.exitCode;
    }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
  }
}
