import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
  const order = ['scripts/preflight.mjs', 'start_runbooks.blocking', '## 6단계', 'scripts/run.mjs', 'judge_pages', '--judgments', '## 9단계', '## 10단계', '## 11단계'];
  const positions = order.map(marker => entry.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), `missing: ${order.filter((_, i) => positions[i] < 0)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const link of ['references/intake.md', 'references/judging.md', 'references/source-analysis.md']) assert.ok(entry.includes(`](${link})`), link);
});

test('the docs quote the limits that code reads from limits.json', async () => {
  const limit = await json('references/limits.json');
  const intake = await text('references/intake.md');
  assert.ok(intake.includes(`표본 ${limit.max_urls_default}페이지`) && intake.includes(`최대 ${limit.max_urls_cap}페이지`));
  assert.ok(intake.includes('기본 상한으로 사이트맵의 쪽을 다 읽지 못하거나') && intake.includes('`max_urls_raise`'));
  assert.ok((await text('SKILL.md')).includes('`max_urls_raise`'));
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

const jsonBlocks = entry => [...entry.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));

test('the change commands fixing.md gives run as written, and the record they write passes the contract schema', async () => {
  const { validateEntity } = await import('../skills/optbrew/scripts/core/contracts.mjs');
  const entry = await text('references/fixing.md');
  assert.ok((await text('SKILL.md')).includes('](references/fixing.md)'), 'step 10 sends the agent to fixing.md');
  // The hash commands and the hand-written record are gone: the two commands do both.
  assert.doesNotMatch(entry, /Get-FileHash|sha256sum|shasum -a 256|_백업_원본_/);
  assert.equal(jsonBlocks(entry).find(block => block.change_id), undefined, 'fixing.md does not ask for a hand-written ChangeRecord');
  const commands = [...entry.matchAll(/^node "<SKILL_DIR>\/scripts\/cli\.mjs" (change (?:start|finish) .*)$/gm)].map(match => match[1]);
  assert.deepEqual(commands.map(command => command.split(' ')[1]), ['start', 'finish']);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew skill change '));
  try {
    const source = path.join(dir, 'site'), out = path.join(dir, 'out');
    await mkdir(source);
    await writeFile(path.join(source, 'index.html'), '<html></html>\n');
    const values = { '<OUT>': out, '<소스 폴더>': source, '<고칠 파일>': 'index.html', '<고친 파일>': 'index.html', '<finding_id>': 'f1', '<쓴 도구 이름>': 'graft', '<도구에 한 질의>': 'where is the title built' };
    const argv = command => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] === undefined ? match[2] : values[match[1]] ?? assert.fail(`unknown placeholder ${match[1]}`));
    const [start, finish] = commands.map(command => [path.join(skill, 'scripts/cli.mjs'), ...argv(command)]);
    const started = spawnSync(process.execPath, start, { encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    await writeFile(path.join(source, 'index.html'), '<html><head><title>t</title></head></html>\n');
    const finished = spawnSync(process.execPath, finish, { encoding: 'utf8' });
    assert.equal(finished.status, 0, finished.stderr);
    const record = JSON.parse(await readFile(path.join(out, 'changes', 'c1.json'), 'utf8'));
    validateEntity('ChangeRecord', record);
    assert.deepEqual(record.analysis, { tools: ['graft'], queries: ['where is the title built'], self_analysis: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the intake-answers template in SKILL.md has exactly the fields the IntakeAnswers schema accepts, each explained once', async () => {
  const entry = await text('SKILL.md');
  const answers = jsonBlocks(entry).find(block => block.guidance_level);
  const schema = (await json('references/schemas/contract.schema.json')).$defs.IntakeAnswers;
  assert.deepEqual(Object.keys(answers).sort(), Object.keys(schema.properties).sort());
  for (const field of ['schema_version', 'goals', 'facts', 'sample_mode', 'owner_exports', 'url']) assert.ok(entry.includes(`- \`${field}\``), field);
  assert.doesNotMatch(await text('references/intake.md'), /^\| `guidance_level` \|/m);
});

test('the runbooks SKILL.md and prepare.md name exist and fit the harness they are chosen for', async () => {
  const { loadRunbook } = await import('../skills/optbrew/scripts/core/runbooks.mjs');
  const { runbookHarnesses } = await import('../skills/optbrew/scripts/core/probe.mjs');
  const entry = `${await text('SKILL.md')}\n${await text('references/prepare.md')}`;
  const keyRunbook = { 'claude-code': 'key-set-local', other: 'key-set-local', codex: 'key-set-codex', 'claude-code-cloud': 'key-set-claude-cloud' };
  for (const [harness, id] of Object.entries(keyRunbook)) {
    assert.ok(entry.includes(`\`${id}\``), id);
    assert.ok(runbookHarnesses(harness).includes(loadRunbook(id, 'beginner', { skillRoot: skill }).harness), `${id} does not serve ${harness}`);
  }
  for (const id of ['google-api-key', 'chrome-install', 'gsc-export', 'naver-searchadvisor-export', 'network-codex-approval']) {
    assert.ok(entry.includes(`\`${id}\``), id);
    loadRunbook(id, 'beginner', { skillRoot: skill });
  }
});

test('the start screen shows at most one blocking runbook and three improving lines for any probe', async () => {
  const { startRunbooks } = await import('../skills/optbrew/scripts/core/runbooks.mjs');
  const { runbookHarnesses } = await import('../skills/optbrew/scripts/core/probe.mjs');
  for (const block_reason of [null, 'site_down', 'codex_sandbox', 'cloud_network_level']) for (const found of [true, false]) for (const google_key of [true, false])
    for (const harness of ['claude-code', 'codex', 'claude-code-cloud', 'other']) {
      const result = startRunbooks({ block_reason, chrome: { found }, google_key }, { level: 'beginner', skillRoot: skill, harnesses: runbookHarnesses(harness) });
      assert.ok(result.blocking.length <= 1 && result.improving.length <= 3, JSON.stringify({ block_reason, found, google_key, harness }));
    }
});

test('every error phrase judging.md lists is one the merge or the judgments reader can throw', async () => {
  const code = (await Promise.all(['judgments.mjs', 'judgment-files.mjs'].map(name => readFile(path.join(skill, 'scripts/core', name), 'utf8')))).join('\n');
  const table = (await text('references/judging.md')).split('| 오류 내용')[1];
  const phrases = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.ok(phrases.length >= 10);
  for (const phrase of phrases) assert.ok(code.includes(phrase), phrase);
});

test('the preflight failure codes SKILL.md reacts to are codes the code raises', async () => {
  const code = (await Promise.all(['probe.mjs', 'scope.mjs', 'collector.mjs'].map(name => readFile(path.join(skill, 'scripts/core', name), 'utf8')))).join('\n');
  for (const name of ['scope_rejected', 'redirect_outside_scope']) {
    assert.ok((await text('SKILL.md')).includes(`\`${name}\``), name);
    assert.ok(code.includes(name), name);
  }
});

test('every stderr text the step 7 failure table matches is a sentence the scripts write', async () => {
  const entry = await text('SKILL.md');
  const table = entry.slice(entry.indexOf('| stderr 마지막 줄 또는 상황 |'), entry.indexOf('| 그 밖의 문장 |'));
  const quoted = [...table.matchAll(/^\| (.+?) \|/gm)].slice(2).flatMap(([, cell]) => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]));
  assert.ok(quoted.length >= 7, quoted.join(' | '));
  const core = path.join(skill, 'scripts', 'core');
  const sources = (await Promise.all([path.join(skill, 'scripts', 'run.mjs'), ...(await readdir(core)).filter(name => name.endsWith('.mjs')).map(name => path.join(core, name))]
    .map(file => readFile(file, 'utf8')))).join('\n');
  for (const piece of quoted) assert.ok(sources.includes(piece), piece);
});
