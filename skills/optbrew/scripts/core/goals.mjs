/**
 * The audit goals a run can aim at, each with the Korean and English words that name it. The start answers keep the owner's own
 * words; a run reads them through this table, so a goal decides engines and checks the same way however it was phrased.
 * `\b` in these patterns sees only ASCII word characters, so `AI답변` still reads as AI.
 */
const GOALS = [
  { id: 'search', words: /검색|유입|\bseo\b|\bsearch|\btraffic|\borganic/i },
  { id: 'naver', words: /네이버|\bnaver/i },
  { id: 'ai_citation', words: /\bai\b|답변|인용|\bgeo\b|\baeo\b|\bllm|\bcit(?:e|ation)|\banswer|chatgpt|perplexity/i },
  { id: 'brand_facts', words: /사실|정확|브랜드|\bfacts?\b|\baccura|\bbrand/i },
  { id: 'conversion', words: /전환|문의|예약|상담|전화|구매|신청|\bconver|\binquir|\benquir|\bbook|\breserv|\bconsult|\bcontact|\bphone|\bcalls?\b|\bpurchase|\bbuy|\bsign.?up|\bleads?\b/i },
];

/** The goal ids the owner's goal strings name, in table order; a string that names no goal adds nothing. */
export const goalIds = goals => GOALS.filter(goal => goals.some(text => goal.words.test(text))).map(goal => goal.id);
