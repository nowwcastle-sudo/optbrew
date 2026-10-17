import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoints = new Set(['skills/optbrew/scripts/run.mjs', 'skills/optbrew/scripts/audit.mjs', 'skills/optbrew/scripts/cli.mjs',
  'skills/optbrew/scripts/key.mjs', 'skills/optbrew/scripts/preflight.mjs', 'lib/cli.mjs', 'bin/optbrew.mjs']);
const isEntry = file => entryPoints.has(file) || /^scripts\/[^/]+\.mjs$/.test(file);

/** Product code: skill scripts, lib, bin and the root build scripts. Tests and vendored modules are out of scope. */
async function productFiles() {
  const found = [];
  const walk = async (dir, deep) => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory() && deep) await walk(relative, true);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(relative);
    }
  };
  await walk('skills/optbrew/scripts', true);
  await walk('lib', true);
  await walk('bin', false);
  await walk('scripts', false);
  return Promise.all(found.sort().map(async file => ({ file, text: await readFile(path.join(root, file), 'utf8') })));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const hits = (files, pattern, { skip = () => false } = {}) => files.flatMap(({ file, text }) => skip(file) ? [] :
  [...text.matchAll(pattern)].map(match => `${file}:${lineOf(text, match.index)}: ${match[0].trim()}`));
const noViolations = (found, rule) => assert.deepEqual(found, [], `${rule}:\n${found.join('\n')}`);

const files = await productFiles();
const limitKeys = Object.keys(JSON.parse(await readFile(path.join(root, 'skills/optbrew/references/limits.json'), 'utf8')));
const squash = name => name.replaceAll('_', '').toLowerCase();
const limitNames = new Set([...limitKeys, 'max_urls'].map(squash));

test('product code is found', () => {
  assert.ok(files.length > 20);
  assert.ok(files.some(({ file }) => file === 'lib/update.mjs'));
  assert.ok(files.some(({ file }) => file === 'skills/optbrew/scripts/core/collector.mjs'));
  assert.ok(!files.some(({ file }) => file.includes('/modules/') || file.startsWith('tests/')));
});

test('no URL literal outside config', () => {
  noViolations(hits(files, /https?:\/\/[^\s'"`)]*/g), 'move URLs into references/endpoints.json');
});

test('no version literal outside config', () => {
  noViolations(hits(files, /['"]\d+\.\d+\.\d+['"]/g), 'move versions into references/versions.json');
});

test('no limit-named literal', () => {
  const found = files.flatMap(({ file, text }) => [...text.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=|:|\?\?|\|\|)\s*(\d[\d_]*)/g)]
    .filter(match => limitNames.has(squash(match[1])))
    .map(match => `${file}:${lineOf(text, match.index)}: ${match[0]}`));
  noViolations(found, 'read limits from references/limits.json');
});

test('limit-named literal check flags the documented shapes', () => {
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:=|:|\?\?|\|\|)\s*(\d[\d_]*)/g;
  const flagged = text => [...text.matchAll(pattern)].some(match => limitNames.has(squash(match[1])));
  for (const text of ['const max_urls = 50', 'const maxBytes = 5242880', 'f({ timeoutMs = 20000 })', 'x = { max_redirects: 10 }',
    'scope?.max_urls ?? 50', 'const MAX_DEPTH = 3']) assert.equal(flagged(text), true, text);
  for (const text of ['const retries = 3', 'a.timeoutMs > 1', 'const max = limits().max_bytes', 'n === 50']) assert.equal(flagged(text), false, text);
});

const importPattern = /^import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const reexportPattern = /^export\s+(?:(\{[\s\S]*?\}|\*(?:\s+as\s+[\w$]+)?))\s+from\s+['"]([^'"]+)['"]/gm;
const exportPattern = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)|^export\s*\{([^}]*)\}\s*;?\s*$/gm;

const importedNames = clause => {
  const names = new Set();
  if (!clause) return names;
  const named = /\{([\s\S]*?)\}/.exec(clause);
  if (named) for (const part of named[1].split(',')) { const name = part.trim().split(/\s+as\s+/)[0]; if (name) names.add(name); }
  const rest = clause.replace(/\{[\s\S]*?\}/, '').split(',').map(part => part.trim()).filter(Boolean);
  if (rest.some(part => part.startsWith('*'))) names.add('*');
  if (rest.some(part => !part.startsWith('*'))) names.add('default');
  return names;
};

/** Which names each product file receives from other product files, by static import and re-export. */
function usedExports(productFiles) {
  const used = new Map(productFiles.map(({ file }) => [file, new Set()]));
  for (const { file, text } of productFiles) {
    const record = (specifier, names) => {
      if (!specifier.startsWith('.')) return;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (used.has(target)) for (const name of names) used.get(target).add(name);
    };
    for (const match of text.matchAll(importPattern)) record(match[2], importedNames(match[1]));
    for (const match of text.matchAll(reexportPattern)) record(match[2], importedNames(match[1]));
  }
  return used;
}

const exportsOf = text => [...text.matchAll(exportPattern)].flatMap(match => match[1] ? [match[1]] :
  match[2].split(',').map(part => part.trim().split(/\s+as\s+/).at(-1)).filter(Boolean));

test('every product export is imported by product code', async () => {
  const pending = JSON.parse(await readFile(path.join(root, 'tests/hygiene-pending.json'), 'utf8'));
  const used = usedExports(files);
  const found = [];
  for (const { file, text } of files) {
    if (isEntry(file) || Object.hasOwn(pending, file)) continue;
    for (const name of exportsOf(text)) if (!used.get(file).has(name) && !used.get(file).has('*')) found.push(`${file}: export ${name}`);
  }
  noViolations(found, 'export is unused: import it from product code, drop `export`, or list the file in tests/hygiene-pending.json');
});

test('export scan sees named, default-less and re-exported names', () => {
  const sample = [{ file: 'a.mjs', text: 'export function one() {}\nexport const two = 1;\nexport { three };\n' },
    { file: 'b.mjs', text: "import { one,\n  two as deux } from './a.mjs';\nexport { x } from './a.mjs';\n" }];
  assert.deepEqual(exportsOf(sample[0].text), ['one', 'two', 'three']);
  assert.deepEqual([...usedExports(sample).get('a.mjs')].sort(), ['one', 'two', 'x']);
});

test('no console.log outside entry points', () => {
  noViolations(hits(files, /\bconsole\.log\b/g, { skip: isEntry }), 'only entry points print');
});

/** Start lines of runs of 3+ `//` lines that read as code: a statement end, an arrow, or a call such as `f(x)`. Prose parentheses do not count. */
function commentedCode(text) {
  const lines = text.split('\n');
  const found = [];
  for (let start = 0; start < lines.length;) {
    if (!lines[start].trimStart().startsWith('//')) { start++; continue; }
    let end = start;
    while (end < lines.length && lines[end].trimStart().startsWith('//')) end++;
    const block = lines.slice(start, end).map(line => line.trimStart().slice(2));
    if (end - start >= 3 && block.some(line => /;\s*$|=>|\w\([^)]*\)/.test(line))) found.push(start + 1);
    start = end;
  }
  return found;
}

test('no commented-out code', () => {
  const found = files.flatMap(({ file, text }) => commentedCode(text).map(line => `${file}:${line}`));
  noViolations(found, 'delete commented-out code or rewrite the comment as prose');
});

test('commented-out code check flags code and passes prose', () => {
  assert.deepEqual(commentedCode('// const a = 1;\n// run(a);\n// done\nx();'), [1]);
  assert.deepEqual(commentedCode('// items.map(x => x);\n// next\n// last'), [1]);
  assert.deepEqual(commentedCode('// A note on the order (see above), written in prose\n// and spread over\n// three lines.'), []);
  assert.deepEqual(commentedCode('// const a = 1;\n// run(a);'), []);
});

test('every test file that creates a temp dir also removes it', async () => {
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith('.mjs')) {
        const text = await readFile(path.join(root, relative), 'utf8');
        if (/\bmkdtemp(?:Sync)?\(/.test(text) && !/\b(?:rm|rmSync)\(/.test(text)) found.push(relative);
      }
    }
  };
  await walk('tests');
  noViolations(found, 'pair mkdtemp with rm/rmSync, or create the dir through tests/support/temp-dir.mjs');
});

test('every test file that uses the Chrome or render core carries the Chrome marker', async () => {
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith('.test.mjs')) {
        const text = await readFile(path.join(root, relative), 'utf8');
        // run.mjs and stages.mjs launch Chrome indirectly (the render stage), so a test that imports either runs serially too.
        // This file only names run.mjs as an entry point; it imports no product code. A bare 'scripts/run.mjs' in prose
        // (skill-bundle checks SKILL.md step order) is not a module path, so only paths under skills/optbrew/ count.
        if (relative !== 'tests/hygiene.test.mjs' && /skills\/optbrew\/scripts\/(?:core\/(?:chrome|render|stages)|run)\.mjs/.test(text) && !text.startsWith('// @optbrew-chrome')) found.push(relative);
      }
    }
  };
  await walk('tests');
  noViolations(found, 'add "// @optbrew-chrome" as the first line so npm test runs the file serially');
});
