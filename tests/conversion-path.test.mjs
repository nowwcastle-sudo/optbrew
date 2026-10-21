import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { prepare } from '../skills/optbrew/scripts/core/checks/prepare.mjs';
import { conversionPath } from '../skills/optbrew/scripts/core/checks/conversion-path.mjs';
import { contactRoutes } from '../skills/optbrew/scripts/core/contact-routes.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const ORIGIN = 'https://cafe.test';
const url = route => `${ORIGIN}${route}`;
const doc = (body, title = '동네 카페') => `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>매일 아침 원두를 볶고 빵을 굽습니다.</p>${body}</body></html>`;
const kinds = (body, route = '/') => contactRoutes(doc(body), url(route)).map(route => route.kind);

test('each kind of contact route a small Korean business uses is found', () => {
  assert.deepEqual(kinds('<a href="tel:02-555-0142">전화</a>'), ['tel_link']);
  assert.deepEqual(kinds('<a href="sms:010-1234-5678">문자</a>'), ['sms_link']);
  assert.deepEqual(kinds('<a href="mailto:hello@cafe.test">메일</a>'), ['mailto_link']);
  assert.deepEqual(kinds('<a href="https://pf.kakao.com/_xAbCd">채널 추가</a>'), ['kakao_channel']);
  assert.deepEqual(kinds('<a href="https://open.kakao.com/o/sAbCd">오픈채팅</a>'), ['kakao_open_chat']);
  assert.deepEqual(kinds('<a href="https://talk.naver.com/ct/w4abcd">톡톡</a>'), ['naver_talktalk']);
  assert.deepEqual(kinds('<a href="https://m.booking.naver.com/booking/6/bizes/123">바로가기</a>'), ['naver_booking']);
  assert.deepEqual(kinds('<a href="/page/12">상담 신청</a>'), ['inquiry_page'], 'the link text names a consultation');
  assert.deepEqual(kinds('<a href="/inquiry">Q&amp;A</a>'), ['inquiry_page'], 'the path names an inquiry');
  assert.deepEqual(kinds('<a href="/%EB%AC%B8%EC%9D%98">바로가기</a>'), ['inquiry_page'], 'a Korean path is read decoded');
  assert.deepEqual(kinds(`<a href="${ORIGIN.replace('://', '://www.')}/reservation">Book</a>`), ['inquiry_page'], 'www. is the same site');
});

test('a phone number counts when the page shows it, labelled or in a dialling shape', () => {
  assert.deepEqual(kinds('<p>매장 02-555-0142</p>'), ['shown_phone'], 'a plain-text landline');
  assert.deepEqual(kinds('<footer>010-1234-5678 · 서울 마포구</footer>'), ['shown_phone'], 'a plain-text mobile number');
  assert.deepEqual(kinds('<p>대표번호 1588-1234</p>'), ['shown_phone']);
  assert.deepEqual(kinds('<p>사업자등록번호 123-45-67890</p><p>국민은행 123456-01-234567</p><p>2026.10.18 영업</p>'), [],
    'registration, account and date numbers are not phones');
});

test('a link to another site or with no inquiry word is no route', () => {
  assert.deepEqual(kinds('<a href="https://other.test/contact">문의</a>'), []);
  assert.deepEqual(kinds('<a href="/menu">메뉴</a><a href="/about">소개</a>'), []);
});

/** The prepared values for collected pages; `renderPlanned` plans render-content, and `renderHtml` gives the stored render of a route. */
function prepared(pages, { renderPlanned = true, renderHtml = {}, chrome = { found: true, reason: null } } = {}) {
  const artifacts = Object.entries(pages).map(([route, body]) => ({ normalized_url: url(route), requested_url: url(route), final_url: url(route),
    capability: 'raw_html', status: 200, content_hash: 'hash', evidence_ref: `evidence${route}.html`, redirect_chain: [], header_lines: [], body }));
  const routes = Object.keys(pages);
  const families = ['conversion-path', ...(renderPlanned ? ['render-content'] : [])].map(family_id => ({ family_id, applicable: true }));
  const context = { protocol: { engines: ['google'], goals: ['conversion'], auxiliary_resources: [], families,
    page_types: [{ id: 'primary', urls: routes.map(route => ({ normalized: url(route) })) }],
    render: { enabled: true, pages: [{ normalized: url(routes[0]) }], max_render_requests: 10 } } };
  const renders = Object.keys(renderHtml).map(route => ({ url: url(route), final_url: url(route), status: 200, dom_ref: `dom${route}`,
    title: '동네 카페', links: [], evidence_ref: `evidence${route}.render.json` }));
  return prepare({ context, artifacts, textOf: artifact => artifact.body, renders, renderTextOf: record => renderHtml[record.url.slice(ORIGIN.length)] ?? '', chrome });
}
const verdict = (pages, options) => {
  const observations = conversionPath.derive(prepared(pages, options));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].unit_key, 'conversion-path|site');
  return observations[0];
};

test('a KakaoTalk channel as the only contact passes', () => {
  const result = verdict({ '/': doc(`<a href="https://pf.kakao.com/_xAbCd">카카오톡 채널</a>`), '/menu': doc('', '메뉴') }, { renderPlanned: false });
  assert.equal(result.state, 'pass');
  assert.deepEqual(result.measurement.routes.map(route => [route.kind, route.url, route.from]), [['kakao_channel', url('/'), 'raw']]);
  assert.equal(result.evidence_ref, 'evidence/.html');
});

test('a phone number written only as text passes', () => {
  const result = verdict({ '/': doc(''), '/about': doc('<p>오시는 길: 마포구 · 02-555-0142</p>', '소개') }, { renderPlanned: false });
  assert.equal(result.state, 'pass');
  assert.deepEqual(result.measurement.routes, [{ kind: 'shown_phone', value: '025550142', url: url('/about'), from: 'raw' }]);
  assert.equal(result.evidence_ref, 'evidence/about.html');
});

test('no route on a site that does not need rendering fails and says what was looked for', () => {
  // The render matches the raw page (same text, title and links), so render-content finds no dependence on rendering.
  const pages = { '/': doc('<p>메뉴는 매장에서 보세요</p>'), '/menu': doc('', '메뉴') };
  for (const options of [{ renderPlanned: false }, { renderHtml: { '/': pages['/'] } }]) {
    const result = verdict(pages, options);
    assert.equal(result.state, 'fail', JSON.stringify(options));
    assert.match(result.reason, /^No audited page offers a contact route: no tel:, sms: or mailto: link, no shown phone number/);
    assert.deepEqual(result.problem_messages, [{ message_key: 'conversion-path.no-contact-route', message_values: {} }]);
    assert.equal(result.evidence_ref, 'evidence/.html', 'the home page is the evidence');
  }
});

test('no route where content shows only after rendering is unknown, and a route in the render passes', () => {
  const shell = '<html><head><title>동네 카페</title></head><body><div id="app"></div></body></html>';
  const rendered = verdict({ '/': shell }, { renderHtml: { '/': doc('') } });
  assert.equal(rendered.state, 'unknown');
  assert.match(rendered.reason, /only after rendering/);
  const noChrome = verdict({ '/': shell }, { chrome: { found: false, reason: 'chrome_not_found' } });
  assert.deepEqual([noChrome.state, noChrome.reason], ['unknown', 'chrome_missing'], 'the Chrome runbook can fill it');
  const inRender = verdict({ '/': shell }, { renderHtml: { '/': doc(`<a href="https://talk.naver.com/ct/w4abcd">네이버 톡톡</a>`) } });
  assert.equal(inRender.state, 'pass');
  assert.deepEqual(inRender.measurement.routes.map(route => [route.kind, route.from]), [['naver_talktalk', 'render']]);
  assert.equal(inRender.evidence_ref, 'evidence/.render.json');
});

test('no collected page gives no verdict', () => {
  assert.deepEqual(conversionPath.derive(prepared({})), []);
});

const sites = [];
after(() => Promise.all(sites.map(site => site.close())));

test('report replay re-derives the conversion verdict of a Kakao-only small business site', async t => {
  const site = await startSite({ '/': { body: page('', `<p>주문은 <a href="https://pf.kakao.com/_xAbCd">카카오톡 채널</a>로 받습니다</p>`, '동네 꽃집') } });
  sites.push(site);
  const scenario = await buildScenario(site, ['/'], { goals: ['conversion'], name: 'kakao-only' });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  assert.equal(scenario.packet.baseline.input.observations.find(x => x.family_id === 'conversion-path').state, 'pass');
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => Object.assign(list.find(x => x.family_id === 'conversion-path'), { state: 'fail', q: 0, reason: 'forged' }));
  assert.throws(() => buildReport(scenario.packet), /collector verdict differs from raw evidence: conversion-path\|site/);
});
