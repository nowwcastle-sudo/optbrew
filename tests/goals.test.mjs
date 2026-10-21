import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goalIds } from '../skills/optbrew/scripts/core/goals.mjs';

const skill = readFileSync(new URL('../skills/optbrew/SKILL.md', import.meta.url), 'utf8');

test('each goal name the start question offers reads as exactly one goal', () => {
  const menu = skill.match(/고를 수 있는 목표는 (.+?)이다\./)[1].split(', ');
  assert.deepEqual(menu.map(name => goalIds([name])), [['search'], ['naver'], ['ai_citation'], ['brand_facts'], ['conversion']]);
});

test('Korean and English words name the five goals', () => {
  const cases = {
    conversion: ['문의', '예약', '상담', '전화', '구매', '신청', 'more bookings', 'contact form', 'inquiries', 'conversion rate'],
    ai_citation: ['AI', 'AI답변에 나오기', '답변', '인용', 'GEO', 'AEO', 'LLM', 'LLMO', 'cited by ChatGPT'],
    naver: ['네이버', 'naver', 'Naver 검색 노출'],
    brand_facts: ['사실', '정확', '브랜드', 'brand facts', 'accuracy'],
    search: ['검색', '유입', 'SEO', 'organic search traffic'],
  };
  for (const [id, words] of Object.entries(cases))
    for (const word of words) assert.ok(goalIds([word]).includes(id), `${word} names ${id}`);
});

test('a sentence can name several goals; ids come once each, in table order', () => {
  assert.deepEqual(goalIds(['네이버 검색 노출을 늘리고 싶다', 'AI 답변에 인용되기', '예약 문의']), ['search', 'naver', 'ai_citation', 'conversion']);
  assert.deepEqual(goalIds(['문의', '상담', '예약']), ['conversion']);
});

test('words that name no goal add nothing', () => {
  assert.deepEqual(goalIds([]), []);
  assert.deepEqual(goalIds(['그냥 좋아지게', 'Thai restaurant', 'geography lessons']), []);
});
