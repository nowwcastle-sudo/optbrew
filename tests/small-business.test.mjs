// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { answersFor, memorySite, passJudgments, quietEnv, readQueue, SITE, workspace } from './support/run-scenario.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const GOALS = ['검색 유입', '네이버 노출', 'AI 답변 인용', '예약 문의'];
const VERIFICATION = '<meta name="naver-site-verification" content="0123abcd">';
const page = (title, body, head = '') => ({ body: `<!doctype html><html lang="ko"><head><title>${title}</title>` +
  `<meta name="description" content="마포구 동네 꽃집입니다"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>` +
  `<body><h1>${title}</h1><p>계절 꽃으로 꽃다발과 화분을 만들고, 매일 아침 시장에서 받은 꽃만 씁니다.</p>${body}</body></html>` });
/**
 * A small Korean flower shop: orders go through a KakaoTalk channel on the start page, the phone number is only written as text on
 * /about, there is no robots.txt (the in-memory site answers 404), and Search Advisor ownership was proven by an uploaded file, so
 * the start page carries no verification tag unless `head` adds one.
 */
const shop = head => memorySite({
  '/': page('동네 꽃집', '<p>주문은 <a href="https://pf.kakao.com/_xAbCd">카카오톡 채널</a>로 받습니다.</p><a href="/about">가게 소개</a>', head),
  '/about': page('가게 소개', '<p>전화: 02-555-0142</p><p>주소: 서울 마포구 성미산로 10</p><a href="/">처음으로</a>'),
});

/** Both calls of a run with every queued unit judged a pass. */
async function audit(site, answers) {
  const ws = await workspace(answers);
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  const judgmentsPath = path.join(ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(await readQueue(first))));
  const second = await run({ answersPath: ws.answersPath, out: ws.out, judgmentsPath }, overrides);
  return { report: await readJson(second.reports.json), html: await readFile(second.reports.html, 'utf8') };
}

test('a Kakao-only, text-phone, robots-less Korean shop verified by file upload: nothing new fails, and ownership is a remaining-work row only', async () => {
  const answers = answersFor(`${SITE}/`, { goals: GOALS, facts: [{ key: 'phone', value: '02-555-0142', source_url: `${SITE}/about` }] });
  const { report, html } = await audit(shop(''), answers);
  const { protocol } = report.run_context;
  assert.deepEqual([...protocol.goals].sort(), ['ai_citation', 'conversion', 'naver', 'search']);
  assert.deepEqual([...protocol.engines].sort(), ['chatgpt', 'claude', 'google', 'naver', 'perplexity']);
  const observations = report.baseline.input.observations;
  const of = family => observations.filter(observation => observation.family_id === family);
  for (const family of ['search-crawl-policy', 'ai-crawler-policy']) {
    assert.ok(of(family).length > 0, family);
    assert.deepEqual([...new Set(of(family).map(observation => observation.state))], ['pass'], `${family}: no robots.txt allows every crawler`);
  }
  const [conversion] = of('conversion-path');
  assert.equal(conversion.state, 'pass');
  assert.deepEqual(conversion.measurement.routes.map(route => [route.kind, route.url]), [['kakao_channel', `${SITE}/`], ['shown_phone', `${SITE}/about`]]);
  const facts = of('fact-consistency').find(observation => observation.unit_key.endsWith('/about'));
  assert.equal(facts.state, 'pass', 'the text phone matches the confirmed one');
  assert.match(facts.reason, /match the confirmed facts/);
  assert.deepEqual(report.baseline.scores.flatMap(result => result.blockers), []);
  const rows = report.follow_ups.filter(row => row.reason === 'naver_ownership_unconfirmed');
  assert.equal(rows.length, 1);
  assert.match(html, /네이버 소유확인 메타 태그\(naver-site-verification\)가 없고/);
  assert.match(html, /네이버 서치어드바이저 리포트 내려받기 런북의 1~4번/);

  const tagged = await audit(shop(VERIFICATION), answers);
  assert.equal(tagged.report.follow_ups.filter(row => row.reason === 'naver_ownership_unconfirmed').length, 0, 'the tag answers the question');
  assert.deepEqual(tagged.report.baseline.scores, report.baseline.scores, 'the tag changes no score');

  const moved = await audit(shop(''), { ...answers, facts: [{ key: 'phone', value: '02-555-0199', source_url: `${SITE}/about` }] });
  const differs = moved.report.baseline.input.observations.find(observation => observation.family_id === 'fact-consistency' && observation.unit_key.endsWith('/about'));
  assert.equal(differs.state, 'fail');
  assert.deepEqual(differs.problem_messages.map(item => item.message_key), ['fact-consistency.confirmed-differs']);
  assert.match(moved.html, /시작할 때 확인한 사실과 다릅니다/);
});
