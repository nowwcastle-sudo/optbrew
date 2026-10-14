import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRobots, robotsVerdict } from '../skills/optbrew/modules/naver-searchadvisor/scripts/robots.mjs';

const fixture = fileURLToPath(new URL('./fixtures/parsers/robots.txt', import.meta.url));

test('repeated matching groups combine before wildcard fallback', async () => {
  const parsed = parseRobots(await readFile(fixture, 'utf8'));
  assert.equal(robotsVerdict(parsed, 'Yeti/1.1', '/private/item').allowed, false);
  assert.equal(robotsVerdict(parsed, 'Yeti/1.1', '/private/public/page').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti/1.1', '/robots.txt').allowed, true);
  assert.equal(robotsVerdict(parsed, 'otherbot', '/private/public/page').allowed, false);
});

test('longest octet rule wins and Allow breaks equal-length ties', () => {
  const parsed = parseRobots('User-agent: Yeti\nDisallow: /a\nAllow: /a\nDisallow: /caf%C3%A9\nAllow: /caf%C3%A9/open\n');
  assert.equal(robotsVerdict(parsed, 'Yeti', '/a').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/caf%C3%A9/x').allowed, false);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/café/open').allowed, true);
});

test('comments, empty disallow, and percent encoded reserved octets', () => {
  const parsed = parseRobots('User-agent: Yeti # comment\nDisallow: # empty\nDisallow: /a%2Fb\n');
  assert.equal(robotsVerdict(parsed, 'Yeti', '/free').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/a%2Fb').allowed, false);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/a/b').allowed, true);
});

test('all matching agent groups merge before wildcard fallback', () => {
  const parsed = parseRobots('User-agent: *\nDisallow: /\nUser-agent: Yet\nDisallow: /x/private\nUser-agent: Yeti\nAllow: /x\n');
  assert.equal(robotsVerdict(parsed, 'Yeti/1.1', '/x').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti/1.1', '/x/private').allowed, false);
  assert.equal(robotsVerdict(parsed, 'other', '/x').allowed, false);
});

test('wildcard and end anchor match normalized paths', () => {
  const parsed = parseRobots('User-agent: Yeti\nDisallow: /shop/*/draft$\nAllow: /shop/open/\nDisallow: /a%7Eb\n');
  assert.equal(robotsVerdict(parsed, 'Yeti', '/shop/one/draft').allowed, false);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/shop/one/draft/final').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/shop/open/item').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/a~b').allowed, false);
});

test('empty Disallow ends a group before the next User-agent', () => {
  const parsed = parseRobots('User-agent: *\nDisallow:\nUser-agent: Yeti\nDisallow: /secret\n');
  assert.deepEqual(parsed.groups.map(group => group.agents), [['*'], ['yeti']]);
  assert.equal(robotsVerdict(parsed, 'OtherBot', '/secret').allowed, true);
  assert.equal(robotsVerdict(parsed, 'Yeti', '/secret').allowed, false);
});

test('audit checks path and query for page and resource robots rules', () => {
  const auditPath = fileURLToPath(new URL('../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs', import.meta.url));
  const source = `
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (path === '/robots.txt') return new Response('User-agent: Yeti\\nDisallow: /item?preview=1\\nDisallow: /asset.css?preview=1\\n', { headers: { 'content-type': 'text/plain' } });
      if (path === '/item') return new Response('<html><head><title>Article</title><link rel="stylesheet" href="/asset.css?preview=1"></head><body><h1>Article</h1></body></html>', { headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 404 });
    };
    process.argv = [process.execPath, ${JSON.stringify(auditPath)}, 'https://example.com/item?preview=1', '--json'];
    await import(${JSON.stringify(new URL('../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs', import.meta.url).href)});
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 1, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.ok(result.findings.some(finding => finding.code === 'robots-disallow' && finding.message.includes('/item?preview=1')));
  assert.ok(result.findings.some(finding => finding.code === 'resource-blocked' && finding.message.includes('/asset.css?preview=1')));
});
