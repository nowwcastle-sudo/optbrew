import { checkRegistry } from './config.mjs';

const GOOGLE = 'google';
const NAVER = 'naver';
const AI_GOAL = 'ai_citation';
const AI_FAMILY = 'ai-crawler-policy';
const QUESTION_FAMILIES = ['question-coverage', 'answer-clarity'];
/** Why a family the start answers switch off is not applicable; every other family of the registry is planned for every run. */
const NOT_APPLICABLE = {
  'naver-markup': { condition: 'naver_not_target', reason: 'Naver is not among the target engines of this run' },
  [AI_FAMILY]: { condition: 'ai_not_target', reason: 'No AI answer engine is among the target engines of this run' },
  'question-coverage': { condition: 'no_fixed_questions', reason: 'The start answers fixed no question list' },
  'answer-clarity': { condition: 'no_matching_questions', reason: 'The start answers fixed no question list to match answers against' },
};

/** The run's target engines: Google always, Naver when `naver` is true, and the AI answer engines the AI crawler check covers when a goal is AI citation. */
export const targetEngines = ({ goals, naver }) => [GOOGLE, ...(naver ? [NAVER] : []),
  ...(goals.includes(AI_GOAL) ? checkRegistry().families.find(family => family.family_id === AI_FAMILY).engines : [])];

/**
 * One plan per registry family. A family the registry binds to engines is planned when the run targets one of them, and a question
 * family when the start answers fixed questions; `evidence_ref` is the file whose answers decided the rest.
 */
export function planFamilies({ engines, questions, evidence_ref }) {
  const planned = ({ family_id, engines: covered }) => QUESTION_FAMILIES.includes(family_id) ? questions.length > 0 :
    !covered || covered.some(engine => engines.includes(engine));
  return checkRegistry().families.map(definition => planned(definition) ? { family_id: definition.family_id, applicable: true } :
    { family_id: definition.family_id, applicable: false, applicability_decision: { ...NOT_APPLICABLE[definition.family_id], evidence_ref } });
}
