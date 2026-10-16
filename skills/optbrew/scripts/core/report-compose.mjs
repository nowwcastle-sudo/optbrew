import { compileUnits, scoreWeighted } from './weights.mjs';
import { CWV_FAMILIES } from './checks/cwv-field.mjs';
import { CONTENT_AFTER_RENDER } from './checks/render-content.mjs';
import { messageKey } from './findings.mjs';
import { keySetRunbook, runbookHarnesses } from './probe.mjs';
import { remainingRunbooks, runbookEntry, startRunbooks } from './runbooks.mjs';

/** The optbrew operating rule (design spec, scoring.md): at least 80% of the applicable weight must be measured. */
const COVERAGE_THRESHOLD = 80;
const KEY_RUNBOOK = 'google-api-key';

/** Said under the run conditions only when a page showed its content after rendering; it never feeds a score (R36, R51). */
const JAVASCRIPT_NOTE = '네이버와 AI 크롤러는 자바스크립트를 실행하지 못할 수 있어서, 내용을 자바스크립트로 그리는 페이지는 이들에게 비어 보일 수 있습니다. 이 안내는 어떤 점수에도 들어가지 않습니다.';

/** Report text is Korean (R64); the ids and JSON keys around it stay English. */
export const UNKNOWN = '알 수 없음';
export const LOCATION_NEEDED = '고칠 위치는 사이트 담당자가 정해야 합니다';
/** The section names, shared by report.md, report.html and the sentences that point to a section. */
export const SECTION_TITLES = { fixes: '먼저 고칠 것', completeness: '얼마나 확인했나', blank: '아직 비어 있는 곳', conditions: '실행 조건',
  remaining: '남은 일', outcomes: '실제 결과', judgments: '모델 판단' };

const html = value => String(value ?? UNKNOWN).replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (columns, rows) => `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(html).join(' | ')} |`).join('\n') || `| ${columns.map(() => '—').join(' | ')} |`}`;
const floorTenth = value => value === null ? UNKNOWN : Math.floor(value * 10 + 1e-9) / 10;

/** One headline per profile. Below the coverage threshold the single number is withheld and only the measured subset is shown. */
function scoreHeadline(result) {
  const exact = result.A > 0 ? 100 * result.M / result.A : null;
  const coverageOk = result.score !== null && exact !== null && exact >= COVERAGE_THRESHOLD - 1e-9;
  // The design spec also asks for verdicts on the core access and indexing checks before a score counts as sufficient.
  const coreOk = (result.unknown_core ?? []).length === 0;
  const status = !coverageOk ? 'insufficient_coverage' : !coreOk ? 'insufficient_core' : 'sufficient';
  return { profile: result.profile, status, headline_score: status === 'sufficient' ? result.score : null,
    measured_subset_score: result.score, coverage: result.coverage, coverage_exact: exact, coverage_threshold: COVERAGE_THRESHOLD,
    unresolved_core: (result.unknown_core ?? []).length, missing_bounds: result.missing_bounds, readiness_status: result.readiness_status };
}

/** A phase with no audit cannot replay its verdicts: its score is never the headline (R49), and every status says so. */
const phaseOf = (result, input) => {
  const headline = scoreHeadline(result);
  const audited = input.run_context.audited === true;
  return { headline: { ...headline, audited, ...(!audited && headline.status === 'sufficient' ? { status: 'unaudited', headline_score: null } : {}) },
    coverage: result.coverage, missing_bounds: result.missing_bounds, readiness_status: result.readiness_status };
};

const withoutCwv = (input, profile) => scoreWeighted(compileUnits(input, profile).filter(unit => !CWV_FAMILIES.includes(unit.family_id))).coverage;

export const resolved = finding => finding.status === 'verified_production';
const priorityRank = priority => /^P(\d+)$/.test(priority) ? Number(priority.slice(1)) : Infinity;
const compareRank = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const affectedKey = finding => `${finding.check_id}\0${messageKey(finding.message)}`;
/** The pages a finding affects: the ones it lists, or its own unit. */
const pagesOf = finding => finding.unit_keys ?? [finding.unit_key];
const PAGES_SHOWN = 5;
/** How a fix row names its pages: the one unit, or the count and the first few addresses. */
export const pagesLabel = finding => {
  const units = pagesOf(finding);
  if (units.length === 1) return units[0];
  const shown = units.slice(0, PAGES_SHOWN).map(unit => unit.split('|').at(-1)).join(', ');
  return `(${units.length}개 페이지: ${shown}${units.length > PAGES_SHOWN ? `, 외 ${units.length - PAGES_SHOWN}개` : ''})`;
};

/** Open before resolved, then blocking, then priority (P0 first, an unknown one last), then the problem on the most pages, then the unit. */
function sortedFixes(findings, changes) {
  const pages = new Map();
  for (const finding of findings) pages.set(affectedKey(finding), new Set([...(pages.get(affectedKey(finding)) ?? []), ...pagesOf(finding)]));
  const withPaths = findings.map(finding => ({ ...finding,
    change_paths: changes.filter(change => change.finding_ids.some(id => finding.finding_ids.includes(id))).map(change => change.path) }));
  return withPaths.sort((a, b) => Number(resolved(a)) - Number(resolved(b)) || Number(b.blocker) - Number(a.blocker) ||
    compareRank(priorityRank(a.priority), priorityRank(b.priority)) || pages.get(affectedKey(b)).size - pages.get(affectedKey(a)).size ||
    a.unit_key.localeCompare(b.unit_key));
}

/**
 * A clean result never hides a thin one (D4): with no open fix but an incomplete check, the line says so and points to the
 * completeness section, where the cause is shown. A report with no completeness row at all is as thin as it gets.
 */
function conclusionOf(fixes, completeness) {
  const open = fixes.filter(finding => !resolved(finding));
  const blocking = open.filter(finding => finding.blocker).length;
  const thin = completeness.length === 0 || completeness.some(row => (row.after ?? row.before).headline.status !== 'sufficient');
  const none = thin ? `확인한 범위에서는 실패한 것이 없지만 점검이 끝나지 않았습니다. '${SECTION_TITLES.completeness}' 구역에서 이유를 확인하세요.` : '확인한 범위에서는 고칠 것이 남지 않았습니다.';
  return { open: open.length, blocking, already_fixed: fixes.length - open.length,
    text: open.length ? `먼저 고칠 것이 ${open.length}건 있습니다${blocking ? ` (그중 ${blocking}건이 가장 급합니다)` : ''}.` : none };
}

const blockerSummary = scores => ({ count: scores[0]?.blockers.length ?? 0, items: scores[0]?.blockers.map(x => `${x.family_id} ${x.unit_key}`) ?? [],
  core_unknown: scores[0]?.unknown_core.length ?? 0 });

function completenessOf(verified) {
  const { baseline, after } = verified;
  return baseline.scores.map(first => {
    const last = after?.scores.find(result => result.profile === first.profile) ?? null;
    const before = phaseOf(first, baseline.input), later = last ? phaseOf(last, after.input) : null;
    const delta = verified.comparison.score_deltas.find(x => x.profile === first.profile)?.percentage_point_delta ?? null;
    return { profile: first.profile, pass_rate_in_measured: (last ?? first).score, coverage: (last ?? first).coverage,
      coverage_without_cwv: withoutCwv(last ? after.input : baseline.input, first.profile), before, after: later, difference: delta,
      between_measured_subsets: delta !== null && [before, later].some(phase => phase && phase.headline.status !== 'sufficient') };
  });
}

/**
 * What is still blank in the latest phase: the runbooks for its unknown reasons, then the start items the user left
 * unanswered (D25). Nothing the probe already has is offered again, and the Google key item adds the runbook that saves
 * the key for the probe's harness.
 */
function remainingBlanks(verified, { observations, run_context: context }) {
  const probe = context.environment_probe;
  const has = { google_key: probe.google_key, chrome: probe.chrome.found };
  // The blocking runbooks are not remaining work: a run that reached a report was not blocked.
  const { improving } = startRunbooks({ ...probe, block_reason: null }, { level: 'brief', skillRoot: null, harnesses: runbookHarnesses(probe.harness) });
  const answered = new Set(verified.answered_runbooks);
  const ids = [...new Set([...remainingRunbooks(observations), ...improving.map(entry => entry.id).filter(id => !answered.has(id))])]
    .filter(id => !has[runbookEntry(id).when.missing]);
  return ids.map(id => {
    const entry = runbookEntry(id);
    const runbookIds = entry.expands_to ?? [id];
    return { item: entry.item, fills: entry.fills, runbook_ids: id === KEY_RUNBOOK ? [...runbookIds, keySetRunbook(probe.harness)] : runbookIds };
  });
}

/**
 * The report, composed once: the conclusion, what to fix, how complete the audit is, what is blank, and the run conditions.
 * `verified` is the checked report data: run_context, baseline and after ({ input, scores }), comparison, findings,
 * model_judgments, lab_cwv and answered_runbooks. Headline, completeness and the blanks all read the latest phase (the after
 * phase when there is one). Every format renders this and decides nothing.
 */
export function composeReport(verified) {
  const latest = (verified.after ?? verified.baseline).input;
  const fixes = sortedFixes(verified.findings, verified.changes);
  const completeness = completenessOf(verified);
  const afterRender = latest.observations.some(obs => obs.family_id === 'render-content' && obs.state === 'pass' && obs.reason.startsWith(CONTENT_AFTER_RENDER));
  return {
    headline: conclusionOf(fixes, completeness),
    fixes,
    completeness,
    remaining: remainingBlanks(verified, latest),
    conditions: { probe: latest.run_context.environment_probe, model_judgments: verified.model_judgments, lab_cwv: verified.lab_cwv, start_redirect: verified.start_redirect ?? null,
      blockers: { before: blockerSummary(verified.baseline.scores), after: verified.after ? blockerSummary(verified.after.scores) : null },
      notes: afterRender ? [JAVASCRIPT_NOTE] : [] },
  };
}

/** Why a phase's single number is shown or withheld, in one sentence: the line under Headline, and the one the HTML report reads. */
export const headlineLine = h => (h.status === 'sufficient' ? `${h.profile}: ${h.headline_score}점 (확인 범위 ${h.coverage}%)` :
  h.status === 'unaudited' ? `${h.profile}: 감사 안 됨 — 확인한 범위 안의 통과율은 ${h.measured_subset_score ?? UNKNOWN}이지만, 이를 뒷받침하는 감사가 없어 점수로 내지 않습니다 (확인 범위 ${h.coverage}%)` :
  h.status === 'insufficient_core' ? `${h.profile}: 핵심 검사 부족 (접근·색인 검사 ${h.unresolved_core}건에 결과가 없습니다. 확인 범위는 ${h.coverage}%입니다); 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}, 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN}` :
  `${h.profile}: 확인 범위 부족 (적용 가중치의 ${floorTenth(h.coverage_exact)}%만 확인했습니다. 점수를 내려면 ${h.coverage_threshold}% 이상 필요합니다); 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}, 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN}`) +
  (h.audited || h.status === 'unaudited' ? '' : '; 이 단계는 감사되지 않아 판정을 다시 계산할 수 없었습니다');

const headlineCell = h => (h.status === 'sufficient' ? `${h.headline_score}점 (확인 범위 ${h.coverage}%)` :
  h.status === 'unaudited' ? `감사 안 됨 (확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${h.coverage ?? UNKNOWN}%)` :
  h.status === 'insufficient_core' ? `핵심 검사 부족 (${h.unresolved_core}건 결과 없음; 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${h.coverage ?? UNKNOWN}%; 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN})` :
  `확인 범위 부족 (확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${h.coverage ?? UNKNOWN}%; 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN})`) +
  (h.audited || h.status === 'unaudited' ? '' : ' (감사 안 됨)');

/** The rows of every table, from the composed report and the checked data around it. */
function tableRows(composed, verified) {
  const score = composed.completeness.map(({ profile, before, after, difference, between_measured_subsets: between, coverage_without_cwv: withoutField }) => [
    profile, headlineCell(before.headline), after ? headlineCell(after.headline) : UNKNOWN,
    `${difference ?? UNKNOWN}${between ? ' (확인한 범위끼리의 비교)' : ''}`,
    `${before.coverage ?? UNKNOWN} → ${after?.coverage ?? UNKNOWN}`,
    `${before.missing_bounds?.join('–') ?? UNKNOWN} → ${after?.missing_bounds?.join('–') ?? UNKNOWN}`,
    `${before.readiness_status} → ${after?.readiness_status ?? UNKNOWN}`, withoutField ?? UNKNOWN]);
  const remediation = composed.fixes.map(f => [f.priority, `${f.message} ${pagesLabel(f)}`, f.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; '),
    f.remediation ? `${f.remediation.mechanism} (${f.remediation.source_url}, 확인일 ${f.remediation.checked_date})` : UNKNOWN,
    f.change_paths.join('; ') || f.remediation?.location_hint || LOCATION_NEEDED,
    f.remediation ? `${f.remediation.cost}; ${f.remediation.effort}` : UNKNOWN, f.remediation?.validation ?? UNKNOWN,
    f.resolution ? `${f.status} (${f.resolution.source_ref}의 ${f.resolution.evaluator_type} 관찰로 해결 확인)` : f.status]);
  return { score, remediation,
    actual_outcomes: verified.outcome_rows,
    remaining_work: verified.follow_ups.map(x => [x.problem, x.reason, x.required_input_or_authority, x.next_action, x.reobserve_when]),
    model_judgments: composed.conditions.model_judgments.map(x => [x.phase, `${x.family_id} ${x.unit_key}`, x.state,
      `${x.evidence_ref} 바이트 ${x.evidence_span.map(span => `${span.start}–${span.end}`).join(', ')}`, x.label]) };
}

const conditionLines = (conditions, verified) => {
  const { probe, lab_cwv: lab } = conditions;
  const { before, after } = conditions.blockers;
  const listed = summary => `${summary.count}건 (${summary.items.join('; ') || '없음'})`;
  return [
    `실행 환경: ${probe.harness}; 전송 방식: ${probe.transport ?? UNKNOWN}; 크롬: ${probe.chrome.found ? probe.chrome.kind : `찾지 못함 (${probe.chrome.reason ?? UNKNOWN})`}; Google 키: ${probe.google_key ? '있음' : '없음'}`,
    `분석 도구: ${probe.source_tools.join(', ') || '지정 없음'}; 확인한 모델 판단: ${conditions.model_judgments.length}건`,
    `이전 막는 문제: ${listed(before)} → 이후 막는 문제: ${after ? listed(after) : `${UNKNOWN} (이후 단계를 보지 않음)`}; ` +
      `이후 결과 없는 핵심 검사: ${after?.core_unknown ?? UNKNOWN}건; 실제 결과: ${verified.metrics.length ? "아래 '실제 결과'의 측정·빈칸 상태 참고" : '연결 안 됨 / 알 수 없음'}`,
    `비용·기능 제한: ${verified.cost_issues.join('; ') || '기록 없음'}`,
    `지표 출처 제한: ${verified.metric_origin_limitations.join('; ') || '측정된 제공자 입력 없음'}`,
    `실험실 Core Web Vitals (참고용, 점수에 넣지 않음): ${lab ? `LCP ${lab.lcp ?? UNKNOWN} ms; CLS ${lab.cls ?? UNKNOWN}` : '측정하지 않음'}`,
    ...(conditions.start_redirect ? [`시작 주소: ${conditions.start_redirect.from} → ${conditions.start_redirect.to} (이 주소로 연결되므로 감사는 ${conditions.start_redirect.to}에서 실행했습니다)`] : []),
    ...conditions.notes,
  ];
};

/** `report.md` and the table rows `report.json` carries, both rendered from the composed report. */
export function renderReport(composed, verified) {
  const tables = tableRows(composed, verified);
  const { run_context: context } = verified;
  const blanks = composed.remaining.map(x => [x.item, x.runbook_ids.join(', ')]);
  const latest = composed.completeness.map(row => row.after ?? row.before);
  const markdown = `# optbrew 보고서\n\n${verified.data_class === 'synthetic' ? '**예시 보고서 — 실제 사이트나 외부 서비스의 결과가 아닙니다.**\n\n' : ''}` +
    `대상: ${html(context.target)}  \n환경: ${html(context.environment)}  \n목표: ${html(context.goals.join(', '))}  \n` +
    `비교: ${html(verified.comparison.status)} (${html(verified.comparison.reasons.join(', ') || '없음')})  \n` +
    `결론: ${html(composed.headline.text)}\n\n` +
    `## ${SECTION_TITLES.fixes}\n\n${table(['우선순위', '문제 / 주소', '근거', '고르는 해결 방법', '고칠 위치 또는 사이트 담당자', '비용 / 노력', '확인 방법', '상태'], tables.remediation)}\n\n` +
    `## ${SECTION_TITLES.completeness} (확인한 범위 안의 통과율)\n\n요약:  \n${latest.map(phase => `- ${html(headlineLine(phase.headline))}  \n`).join('')}\n` +
    `${table(['영역', '이전', '이후', '차이', '확인 범위 이전 → 이후', '점수 범위', '상태', '방문자 실측(CWV)을 뺀 확인 범위(최신)'], tables.score)}\n\n` +
    `## ${SECTION_TITLES.blank}\n\n${table(['비어 있는 것과 채우면 알 수 있는 것', '런북'], blanks)}\n\n` +
    `## ${SECTION_TITLES.conditions}\n\n${conditionLines(composed.conditions, verified).map(line => `- ${html(line)}\n`).join('')}\n` +
    `## ${SECTION_TITLES.remaining}\n\n${table(['문제', '이유', '필요한 입력 / 권한', '다음 행동', '다시 볼 때'], tables.remaining_work)}\n\n` +
    `## ${SECTION_TITLES.outcomes}\n\n${table(['검색 엔진 / 속성', '지표', '기간 / 표본', '이전 원값', '이후 원값', '차이', '완료 여부', '한계'], tables.actual_outcomes)}\n\n` +
    (tables.model_judgments.length ? `## ${SECTION_TITLES.judgments}\n\n${table(['단계', '검사 / 대상', '상태', '근거 구간 (UTF-8 바이트, 끝 제외)', '근거'], tables.model_judgments)}\n\n` : '') +
    `증거 폴더: ${html(verified.evidence_root)}; 실행 ID: ${html(context.run_id)}. 점수 계산에 쓴 원본 값은 report.json에서 다시 계산할 수 있습니다.\n`;
  return { markdown, tables };
}
