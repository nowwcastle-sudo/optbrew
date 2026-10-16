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

const text = async name => (await readFile(path.join(skill, name), 'utf8')).replaceAll('\r\n', '\n');
const json = async name => JSON.parse(await text(name));

test('SKILL.md walks the one-call flow in order and links the new references', async () => {
  const entry = await text('SKILL.md');
  const order = ['scripts/preflight.mjs', 'start_runbooks.blocking', '## 6단계', 'scripts/run.mjs', 'judge-queue.json', '--judgments', 'report.html', 'ChangeRecord'];
  const positions = order.map(marker => entry.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), `missing: ${order.filter((_, i) => positions[i] < 0)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const link of ['references/intake.md', 'references/judging.md', 'references/source-analysis.md']) assert.ok(entry.includes(`](${link})`), link);
});

test('the docs quote the limits that code reads from limits.json', async () => {
  const limit = await json('references/limits.json');
  const entry = await text('SKILL.md');
  assert.ok(entry.includes(`표본 ${limit.max_urls_default}쪽`) && entry.includes(`최대 ${limit.max_urls_cap}쪽`));
  assert.ok(entry.includes(`${limit.max_urls_default}을 넘을 때만`));
  const judging = await text('references/judging.md');
  assert.ok(judging.includes(`\`judge_span_min_bytes\` ${limit.judge_span_min_bytes}, \`judge_spans_per_unit\` ${limit.judge_spans_per_unit}`));
});

test('judging.md covers exactly the families the judge queue offers, with the states the merge accepts', async () => {
  const { isModelJudged } = await import('../skills/optbrew/scripts/core/judgments.mjs');
  const { families } = await json('references/check-registry.json');
  const offered = families.filter(family => isModelJudged(family.family_id));
  const judging = await text('references/judging.md');
  const rows = [...judging.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]);
  assert.deepEqual(rows.sort(), offered.map(family => family.family_id).sort());
  for (const family of offered) {
    const row = judging.split('\n').find(line => line.startsWith(`| \`${family.family_id}\``));
    assert.equal(row.includes('`partial`'), family.verdict_mode !== 'binary', `${family.family_id}: partial allowed only for non-binary families`);
  }
});
