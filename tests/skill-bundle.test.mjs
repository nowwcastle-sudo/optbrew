import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills/optbrew');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
}

test('one discoverable skill and closed progressive references', async () => {
  const files = await walk(skill);
  assert.deepEqual(files.filter(file => path.basename(file) === 'SKILL.md'), [path.join(skill, 'SKILL.md')]);
  const entry = await readFile(path.join(skill, 'SKILL.md'), 'utf8');
  // skills/ has no .gitattributes, so a core.autocrlf checkout reads CRLF here.
  assert.match(entry, /^---\r?\nname: optbrew\r?\ndescription:/);
  assert.ok(entry.split('\n').length < 500);
  const metadata = await readFile(path.join(skill, 'agents/openai.yaml'), 'utf8');
  assert.match(metadata, /\$optbrew/);
  assert.doesNotMatch(metadata, /allow_implicit_invocation:\s*false/);
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const body = await readFile(file, 'utf8');
    for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^(?:https?:|mailto:)/i.test(match[1])) continue;
      assert.ok(files.includes(path.resolve(path.dirname(file), decodeURIComponent(match[1]))), `${file}: ${match[1]}`);
    }
  }
  const scenarios = JSON.parse(await readFile(path.join(root, 'evals/scenarios.json'), 'utf8'));
  assert.ok(scenarios.length >= 9);
  assert.ok(scenarios.every(s => s.id && s.request && s.allowed_material && s.required_output && s.pass_criteria));
});

test('final review M5: the distributed Magnus guide does not instruct a pytest run of an excluded test file', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const guide = await readFile(path.join(root, 'skills/optbrew/modules/magnus-seo/GUIDE.md'), 'utf8');
  const patch = await readFile(path.join(root, 'scripts/patches/magnus-guide.patch'), 'utf8');
  for (const [name, text] of [['GUIDE.md', guide], ['magnus-guide.patch', patch]]) {
    assert.doesNotMatch(text, /pytest/, name);
    assert.match(text, /source-maintenance/, name);
  }
  assert.equal(guide, patch);
});
