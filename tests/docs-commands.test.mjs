import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, cp, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/optbrew.mjs');
const docs = ['README.md', 'README.ko.md', 'docs/platforms.md', 'docs/release.md', 'skills/optbrew/references/api.md'];

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: path.join(cwd, 'unused-home') } });
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('documented local commands parse and operate in isolated project', async () => {
  const text = (await Promise.all(docs.map(name => readFile(path.join(root, name), 'utf8')))).join('\n');
  const required = [
    'install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --dry-run --json',
    'install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --json',
    'doctor --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --json',
    'check-updates --json',
    'update --scope project --project ./site --json',
    'rollback --scope project --project ./site --release-version 0.1.0 --json',
    'score --input ./before.json --output ./score.json',
    'compare --before ./before.json --after ./after.json --output ./comparison.json',
    'report --input ./remote-only.json --output-dir ./report-output',
  ];
  for (const args of required) assert.ok(text.includes(`node bin/optbrew.mjs ${args}`), `missing documented command: ${args}`);
  const documented = [...new Set([...text.matchAll(/^node bin\/optbrew\.mjs (.+)$/gm)].map(match => match[1]))].sort();
  assert.deepEqual(documented, [...required].sort(), 'every checkout CLI example must have an isolated execution case');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew-docs-'));
  await mkdir(path.join(temp, 'site'));
  await cp(path.join(root, 'tests/fixtures/scoring/before.json'), path.join(temp, 'before.json'));
  await cp(path.join(root, 'tests/fixtures/scoring/after.json'), path.join(temp, 'after.json'));
  for (const name of ['remote-only.json', 'context.json', 'intake.json', 'raw.html', 'module-a.html', 'module-b.html', 'cost-ledger.json'])
    await cp(path.join(root, 'tests/fixtures/reports', name), path.join(temp, name));
  const commands = [];
  for (const args of required) {
    const result = run(args.split(' '), temp);
    commands.push({ argv: [process.execPath, cli, ...args.split(' ')], cwd: temp, ...result });
    if (args.startsWith('rollback ')) {
      // A fresh install has no retained earlier version. This must reach that boundary, not fail argument parsing.
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stderr, /unknown or repeated option|usage:/);
    } else {
      assert.equal(result.code, 0, `${args}: ${result.stderr}`);
      assert.ok(result.stdout.trim());
    }
  }
  await access(path.join(temp, 'score.json'));
  await access(path.join(temp, 'comparison.json'));
  await access(path.join(temp, 'report-output/report.md'));
  const status = JSON.parse(run(['check-updates', '--json'], temp).stdout);
  assert.equal(status.status, 'local_only');
  if (process.env.OPTBREW_DOCS_RECEIPT) {
    const outputs = {};
    for (const name of ['score.json', 'comparison.json', 'report-output/report.md', 'report-output/report.json'])
      outputs[name] = sha256(await readFile(path.join(temp, name)));
    await writeFile(process.env.OPTBREW_DOCS_RECEIPT, `${JSON.stringify({ commands, outputs }, null, 2)}\n`);
  }
});

test('README relative links resolve and package includes the linked documentation', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['README.md', 'README.ko.md']) {
    const body = await readFile(path.join(root, name), 'utf8');
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^[a-z]+:\/\//i.test(href)) continue;
      const target = path.join(root, href.split('#')[0]);
      await access(target);
      if (href.startsWith('docs/')) assert.ok(pkg.files.includes(href) || pkg.files.includes('docs/'), `${href} is linked from ${name} but absent from npm files`);
    }
  }
});
