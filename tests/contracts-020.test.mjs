// @optbrew-chrome
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { versions } from '../skills/optbrew/scripts/core/config.mjs';
import { ContractError, validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { MigrationRequired } from '../skills/optbrew/scripts/core/migration.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { prepareOutput, restoreState } from '../skills/optbrew/scripts/core/stages.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';
import { answersFor } from './support/run-scenario.mjs';
import { tempDir } from './support/temp-dir.mjs';

const skill = new URL('../skills/optbrew/', import.meta.url);
const json = async relative => JSON.parse(await readFile(new URL(relative, skill), 'utf8'));
const scoringInput = () => json('../../tests/fixtures/scoring/partial.json');
const OLD = { schema_version: '1.0.0', evaluation_version: '0.3.0', protocol_version: '0.1.0' };
// One sentence, no schema path, no stack: what is old, then what to do.
const plain = /^migration_required: this [\w ]+ was made with [\w ]+ \d+\.\d+\.\d+, which an older optbrew wrote; run the audit again with optbrew \d+\.\d+\.\d+ in a new --out folder$/;

const site = await startSite({ '/': page('', 'home page'), '/a': page('', 'a page') });
after(() => site.close());
let counter = 0;

test('0.1.x evidence is refused with migration_required', async () => {
  const input = await scoringInput();
  Object.assign(input.run_context, OLD);
  assert.throws(() => score(input), error => error instanceof MigrationRequired && plain.test(error.message), 'score input');
  assert.throws(() => buildReport({ ...OLD, run_context: input.run_context }), error => plain.test(error.message), 'report packet');
  // Each label alone is enough: the labels, not the shape of the file, say a release made it.
  for (const label of Object.keys(OLD)) {
    const one = await scoringInput();
    if (label === 'schema_version') one.schema_version = OLD[label]; else one.run_context[label] = OLD[label];
    assert.throws(() => score(one), error => error instanceof MigrationRequired && plain.test(error.message), label);
  }
  const current = await scoringInput();
  assert.equal(score(current)[0].schema_version, versions().contract_schema, 'a current input still scores');
});

test('an old run folder is refused in one plain sentence, never resumed or cleared', async t => {
  const out = await tempDir('optbrew-contracts-020-');
  t.after(() => rm(out, { recursive: true, force: true }));
  const input = await scoringInput();
  Object.assign(input.run_context, OLD);
  await writeFile(path.join(out, 'context.json'), JSON.stringify(input.run_context));
  await assert.rejects(prepareOutput(out), error => plain.test(error.message));
  assert.equal(JSON.parse(await readFile(path.join(out, 'context.json'), 'utf8')).protocol_version, OLD.protocol_version, 'the old file is left alone');
  await mkdir(path.join(out, 'evidence'));
  await writeFile(path.join(out, 'evidence', 'evidence-index.json'), JSON.stringify({ run_id: input.run_context.run_id, context_ref: 'context.json', documents: {} }));
  await assert.rejects(restoreState({ out, answers: answersFor(input.run_context.target) }), error => error instanceof MigrationRequired && plain.test(error.message));
});

test('compare reports an older input by its version labels, whatever its shape', async () => {
  const current = await scoringInput();
  for (const label of Object.keys(OLD)) {
    const older = await scoringInput();
    if (label === 'schema_version') older.schema_version = OLD[label]; else older.run_context[label] = OLD[label];
    assert.equal(compare(older, current).status, 'not_comparable', `${label} baseline`);
    assert.equal(compare(current, older).status, 'not_comparable', `${label} follow-up`);
    assert.equal(compare(older, null).status, 'no_after', `${label} alone`);
  }
});

test('a packet that plans no field Core Web Vitals reading is a migration, not a mismatch', async t => {
  const scenario = await buildScenario(site, ['/', '/a'], { name: `c20-${++counter}`, engines: ['google'] });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => {
    const at = list.findIndex(x => x.family_id === 'lcp-field');
    assert.notEqual(at, -1, 'the scenario plans an lcp-field unit');
    list.splice(at, 1);
  });
  assert.throws(() => buildReport(scenario.packet), error => error instanceof MigrationRequired && /lcp-field/.test(error.message));
  await scenario.forgeObservations(list => list.splice(list.findIndex(x => x.family_id === 'document-title'), 1));
  assert.throws(() => buildReport(scenario.packet), error => error instanceof ContractError && !(error instanceof MigrationRequired));
});

test('install records stay at schema 1.0.0', async () => {
  const schema = await json('references/schemas/contract.schema.json');
  assert.equal(schema.$defs.InstallRecord.properties.schema_version.const, '1.0.0');
  assert.equal(versions().install_record_schema, '1.0.0');
  assert.equal(versions().bundle_manifest_schema, '1.0.0');
  assert.equal((await json('bundle-manifest.json')).schema_version, '1.0.0');
  // Every other persisted entity that carries a version moves with the contract.
  for (const [name, rule] of Object.entries(schema.$defs)) {
    const version = rule.properties?.schema_version;
    if (!version || name === 'InstallRecord') continue;
    assert.equal(version.const, versions().contract_schema, `${name} follows contract_schema`);
  }
});

test('evaluation and protocol versions come from versions.json', async () => {
  const { evaluation, protocol } = versions();
  const manifest = await json('bundle-manifest.json');
  assert.equal(manifest.evaluation_version, evaluation);
  assert.equal(manifest.protocol_version, protocol);
  const context = (await scoringInput()).run_context;
  assert.equal(context.evaluation_version, evaluation, 'the scoring fixture is stamped with the current evaluation version');
  assert.equal(context.protocol_version, protocol);
  assert.equal(score(await scoringInput())[0].source_ref, `optbrew:scoring:${evaluation}`);
});

test('the answers file SKILL.md describes passes with the current version and 1.0.0 is refused in plain words', async () => {
  const texts = await Promise.all(['SKILL.md', 'references/intake.md'].map(file => readFile(new URL(file, skill), 'utf8')));
  for (const text of texts) assert.match(text, /versions\.json.*contract_schema/);
  const url = 'https://brew.test/';
  assert.doesNotThrow(() => validateEntity('IntakeAnswers', answersFor(url, { schema_version: versions().contract_schema })));
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(url, { schema_version: '1.0.0' })),
    error => /^IntakeAnswers\.schema_version: the answers file says "1\.0\.0" but this optbrew needs "2\.0\.0"; copy the contract_schema value from references\/versions\.json$/.test(error.message));
  assert.throws(() => validateEntity('IntakeAnswers', { ...answersFor(url), schema_version: undefined }), /schema_version/);
});
