import assert from 'node:assert/strict';
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
