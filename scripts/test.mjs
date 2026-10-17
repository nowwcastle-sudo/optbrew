// Runs the test suite: Chrome test files one at a time after all other files.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const chromeMarker = '// @optbrew-chrome';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(relative);
    return entry.name.endsWith('.test.mjs') ? [relative] : [];
  });
}

const run = (label, files, args) => {
  if (!files.length) return 0;
  console.log(`\n== ${label}: ${files.length} file(s) ==`);
  return spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit' }).status ?? 1;
};

const all = testFiles('tests').sort();
const chrome = all.filter(file => readFileSync(path.join(root, file), 'utf8').startsWith(chromeMarker));
const passthrough = process.argv.slice(2);
const statuses = [
  run('parallel', all.filter(file => !chrome.includes(file)), passthrough),
  run('chrome, one at a time', chrome, ['--test-concurrency', '1', ...passthrough]),
];
process.exitCode = statuses.some(status => status !== 0) ? 1 : 0;
