import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunbook, remainingRunbooks, startRunbooks } from '../skills/optbrew/scripts/core/runbooks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'skills/optbrew/references/runbooks');
const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
const registry = JSON.parse(await readFile(path.join(root, 'skills/optbrew/references/check-registry.json'), 'utf8'));
const familyIds = new Set(registry.families.map(family => family.family_id));
const levels = ['beginner', 'brief'];
const skillRoot = 'C:\\Program Files\\optbrew 한글\\skills$&optbrew';

const rawOf = async id => (await readFile(path.join(dir, `${id}.md`), 'utf8')).replace(/\r\n/g, '\n');
const sectionOf = (raw, name) => new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(raw)?.[1].trim();

/** An EnvironmentProbe literal with the field names Task 11 defines; `over` replaces top-level fields. */
const probe = over => ({ harness: 'other', transport: 'direct', address_vetting: 'direct', block_reason: null,
  chrome: { found: true, kind: 'chrome' }, google_key: true, source_tools: [], sitemap_pages: null, ...over });

test('every runbook has checked, source, harness and both levels', async () => {
  assert.ok(index.length > 0);
  for (const { id } of index) {
    const raw = await rawOf(id);
    const head = /^---\n([\s\S]*?)\n---\n/.exec(raw)?.[1];
    assert.ok(head, `${id}: front matter`);
    const fields = Object.fromEntries(head.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    assert.deepEqual(Object.keys(fields).sort(), ['checked', 'harness', 'source'], id);
    assert.match(fields.checked, /^\d{4}-\d{2}-\d{2}$/, `${id}: checked`);
    assert.match(fields.harness, /^[a-z][a-z-]*$/, `${id}: harness`);
    const sources = fields.source.split(/\s+/);
    assert.ok(sources.length > 0 && sources.every(url => /^https:\/\/[^\s]+$/.test(url)), `${id}: source`);
    for (const level of levels) assert.ok(sectionOf(raw, level), `${id}: ## ${level}`);
    assert.match(sectionOf(raw, 'beginner'), /^1\. /m, `${id}: beginner is numbered`);
    const briefLines = sectionOf(raw, 'brief').split('\n').filter(line => line.trim());
    assert.ok(briefLines.length >= 3 && briefLines.length <= 6, `${id}: brief has ${briefLines.length} lines`);
  }
});

test('index ids match files', async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort();
  assert.deepEqual(index.map(entry => entry.id).sort(), files);
  assert.equal(new Set(index.map(entry => entry.id)).size, index.length);
  assert.deepEqual(files, ['chrome-install', 'cwv-site-collection', 'google-api-key', 'gsc-export', 'key-set-claude-cloud',
    'key-set-codex', 'key-set-local', 'naver-searchadvisor-export', 'network-claude-cloud-custom', 'network-codex-approval', 'network-codex-config',
    'seranking']);
});

test('only the two network runbooks block; every entry names real families and a one-line improving text', () => {
  const blocking = index.filter(entry => entry.kind === 'blocking');
  assert.deepEqual(blocking.map(entry => [entry.id, entry.when.block_reason]),
    [['network-codex-approval', 'codex_sandbox'], ['network-claude-cloud-custom', 'cloud_network_level']]);
  for (const entry of index) {
    assert.ok(['blocking', 'improving'].includes(entry.kind), entry.id);
    assert.ok(Array.isArray(entry.fills) && entry.fills.every(id => familyIds.has(id)), `${entry.id}: fills`);
    assert.ok(Object.keys(entry.when).every(key => ['block_reason', 'missing', 'unknown_reason'].includes(key)), `${entry.id}: when`);
    if (entry.when.missing !== undefined) assert.ok(['google_key', 'chrome', 'owner_export'].includes(entry.when.missing), entry.id);
    const startable = entry.when.block_reason !== undefined || entry.when.missing !== undefined;
    if (entry.kind === 'improving' && startable) {
      assert.equal(typeof entry.line, 'string', `${entry.id}: line`);
      assert.ok(entry.line.length > 0 && !entry.line.includes('\n'), `${entry.id}: line is one line`);
    }
  }
  const reasonsOf = id => index.filter(entry => entry.when.unknown_reason === id).map(entry => entry.id);
  assert.deepEqual(reasonsOf('field_data_unavailable'), ['google-api-key', 'cwv-site-collection']);
  assert.deepEqual(reasonsOf('chrome_missing'), ['chrome-install']);
});

test('no placeholder remains after loadRunbook', async () => {
  for (const { id } of index) {
    const raw = await rawOf(id);
    for (const [, name] of raw.matchAll(/\{\{(.*?)\}\}/g)) assert.equal(name, 'skill_root', `${id}: unknown placeholder ${name}`);
    for (const level of levels) {
      const runbook = loadRunbook(id, level, { skillRoot });
      assert.ok(!runbook.text.includes('{{'), `${id}/${level}: placeholder left`);
      assert.ok(!runbook.text.includes('\r'), `${id}/${level}: CRLF left`);
      assert.deepEqual(Object.keys(runbook).sort(), ['checked', 'harness', 'id', 'kind', 'source', 'text', 'title']);
    }
  }
  const text = loadRunbook('key-set-local', 'beginner', { skillRoot }).text;
  assert.ok(text.includes(`${skillRoot}/scripts/key.mjs`) || text.includes(`${skillRoot}\\scripts\\key.mjs`), 'skill root is inserted as given');
});

test('loadRunbook rejects an unknown id, an unknown level and a missing skill root', () => {
  assert.throws(() => loadRunbook('nope', 'brief', { skillRoot }), /unknown runbook/);
  assert.throws(() => loadRunbook('chrome-install', 'expert', { skillRoot }), /level/);
  assert.throws(() => loadRunbook('key-set-local', 'brief', {}), /skillRoot/);
  assert.equal(loadRunbook('chrome-install', 'brief', {}).id, 'chrome-install');
});

test('runbooks carry no key or token value', async () => {
  for (const { id } of index) assert.doesNotMatch(await rawOf(id), /AIza[0-9A-Za-z_-]{20,}|sk-ant-[0-9A-Za-z_-]{10,}|Bearer\s+[0-9A-Za-z._-]{20,}/, id);
});

test('startRunbooks shows at most one blocking runbook', () => {
  for (const reason of ['codex_sandbox', 'cloud_network_level']) {
    const { blocking } = startRunbooks(probe({ block_reason: reason, google_key: false, chrome: { found: false, kind: null } }), { level: 'beginner', skillRoot });
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].kind, 'blocking');
  }
  assert.equal(startRunbooks(probe({ block_reason: 'codex_sandbox' }), { level: 'brief', skillRoot }).blocking[0].id, 'network-codex-approval');
  assert.equal(startRunbooks(probe({ block_reason: 'cloud_network_level' }), { level: 'brief', skillRoot }).blocking[0].id, 'network-claude-cloud-custom');
  for (const reason of [null, 'site_down']) assert.deepEqual(startRunbooks(probe({ block_reason: reason }), { level: 'brief', skillRoot }).blocking, []);
});

test('a harness list filters start runbooks before the blocking cap', () => {
  const missing = probe({ block_reason: 'codex_sandbox', google_key: false, chrome: { found: false, kind: null } });
  const shown = harnesses => startRunbooks(missing, { level: 'brief', skillRoot, harnesses });
  assert.deepEqual(shown(['any', 'claude-code-cloud']).blocking, []);
  assert.deepEqual(shown(['any', 'codex']).blocking.map(runbook => runbook.id), ['network-codex-approval']);
  assert.ok(!shown(['any']).improving.some(item => item.id === 'chrome-install'));
  assert.ok(shown(['any', 'local']).improving.some(item => item.id === 'chrome-install'));
  assert.deepEqual(shown(null).improving.map(item => item.id), ['google-api-key', 'chrome-install', 'gsc-export']);
});

test('the blocking runbook follows the chosen level', () => {
  const beginner = startRunbooks(probe({ block_reason: 'codex_sandbox' }), { level: 'beginner', skillRoot }).blocking[0];
  const brief = startRunbooks(probe({ block_reason: 'codex_sandbox' }), { level: 'brief', skillRoot }).blocking[0];
  assert.equal(beginner.text, loadRunbook('network-codex-approval', 'beginner', { skillRoot }).text);
  assert.equal(brief.text, loadRunbook('network-codex-approval', 'brief', { skillRoot }).text);
  assert.ok(beginner.text.length > brief.text.length);
});

test('improving items are one line each and only for what is missing', () => {
  const none = startRunbooks(probe({}), { level: 'beginner', skillRoot }).improving.map(item => item.id);
  assert.ok(!none.includes('google-api-key') && !none.includes('chrome-install'));
  const missing = startRunbooks(probe({ google_key: false, chrome: { found: false, kind: null } }), { level: 'beginner', skillRoot }).improving;
  assert.ok(missing.some(item => item.id === 'google-api-key') && missing.some(item => item.id === 'chrome-install'));
  for (const item of missing) {
    assert.deepEqual(Object.keys(item).sort(), ['harness', 'id', 'line']);
    assert.ok(item.line.length > 0 && !item.line.includes('\n'), item.id);
    assert.equal(index.find(entry => entry.id === item.id).kind, 'improving');
  }
  const ids = missing.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.some(id => ['network-codex-approval', 'network-claude-cloud-custom'].includes(id)));
});

test('the start screen shows at most one blocking runbook and three one-liners', () => {
  for (const reason of ['codex_sandbox', 'cloud_network_level', 'site_down', null]) {
    const shown = startRunbooks(probe({ block_reason: reason, google_key: false, chrome: { found: false, kind: null } }), { level: 'beginner', skillRoot });
    assert.ok(shown.blocking.length <= 1, reason);
    assert.deepEqual(shown.improving.map(item => item.id), ['google-api-key', 'chrome-install', 'gsc-export'], reason);
  }
});

test('the owner-export line expands to both export runbooks', () => {
  assert.deepEqual(index.find(item => item.id === 'gsc-export').expands_to, ['gsc-export', 'naver-searchadvisor-export']);
  assert.equal(index.find(item => item.id === 'google-api-key').expands_to, undefined);
  const line = startRunbooks(probe({}), { level: 'brief', skillRoot }).improving.find(item => item.id === 'gsc-export').line;
  assert.ok(line.includes('Search Console') && line.includes('네이버 서치어드바이저') && line.includes('두 서비스'));
});

test('a naver-only user reaches the naver runbook', async () => {
  const entry = index.find(item => item.id === 'gsc-export');
  assert.ok(entry.expands_to.every(id => index.some(item => item.id === id)));
  assert.ok(entry.expands_to.includes('naver-searchadvisor-export'));
  for (const level of levels) {
    const naver = loadRunbook('naver-searchadvisor-export', level, { skillRoot });
    assert.match(naver.text.split('\n').find(line => line.trim()), /네이버 서치어드바이저.*이 서비스를 쓰지 않으면 이 절차는 건너뛰세요/);
  }
});

test('each export runbook opens by naming its service and when to skip', () => {
  for (const [id, service] of [['gsc-export', 'Search Console'], ['naver-searchadvisor-export', '네이버 서치어드바이저']])
    for (const level of levels) {
      const first = loadRunbook(id, level, { skillRoot }).text.split('\n').find(line => line.trim());
      assert.ok(first.includes(service) && first.includes('이 서비스를 쓰지 않으면 이 절차는 건너뛰세요'), `${id}/${level}`);
    }
});

test('runbooks reached only from another runbook or a user request never appear at start', () => {
  const reached = ['network-codex-config', 'naver-searchadvisor-export', 'key-set-local', 'key-set-claude-cloud', 'key-set-codex', 'cwv-site-collection', 'seranking'];
  const { improving } = startRunbooks(probe({ block_reason: 'codex_sandbox', google_key: false, chrome: { found: false, kind: null } }), { level: 'brief', skillRoot });
  assert.deepEqual(improving.filter(item => reached.includes(item.id)), []);
});

test('remainingRunbooks maps unknown reasons to ids', () => {
  const observation = (state, reason) => ({ family_id: 'lcp-field', state, reason });
  assert.deepEqual(remainingRunbooks([observation('unknown', 'field_data_unavailable')]), ['google-api-key', 'cwv-site-collection']);
  assert.deepEqual(remainingRunbooks([observation('unknown', 'chrome_missing')]), ['chrome-install']);
  assert.deepEqual(remainingRunbooks([observation('unknown', 'chrome_missing'), observation('unknown', 'field_data_unavailable'),
    observation('unknown', 'field_data_unavailable')]), ['google-api-key', 'cwv-site-collection', 'chrome-install']);
  assert.deepEqual(remainingRunbooks([observation('pass', 'field_data_unavailable'), observation('fail', 'chrome_missing')]), []);
  assert.deepEqual(remainingRunbooks([observation('unknown', 'something_else')]), []);
  assert.deepEqual(remainingRunbooks([]), []);
});
