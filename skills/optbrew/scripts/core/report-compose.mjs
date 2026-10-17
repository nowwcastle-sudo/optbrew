import { compileUnits, scoreWeighted } from './weights.mjs';
import { CWV_FAMILIES } from './checks/cwv-field.mjs';
import { CONTENT_AFTER_RENDER } from './checks/render-content.mjs';
import { messageKey } from './findings.mjs';
import { koText, messageOf } from './messages.mjs';
import { OBSERVATION_SOURCES, QUESTION_UNIT } from './judgments.mjs';
import { keySetRunbook, runbookHarnesses } from './probe.mjs';
import { remainingRunbooks, runbookEntry, startRunbooks } from './runbooks.mjs';

/** The optbrew operating rule (design spec, scoring.md): at least 80% of the applicable weight must be measured. */
const COVERAGE_THRESHOLD = 80;
const KEY_RUNBOOK = 'google-api-key';

/** Said under the run conditions only when a page showed its content after rendering; it never feeds a score (R36, R51). */
const JAVASCRIPT_NOTE = '네이버와 AI 크롤러는 자바스크립트를 실행하지 못할 수 있어서, 내용을 자바스크립트로 그리는 페이지는 이들에게 비어 보일 수 있습니다. 이 안내는 어떤 점수에도 들어가지 않습니다.';

/** Report text is Korean (R64); the ids and JSON keys around it stay English. */
export const UNKNOWN = '알 수 없음';
const LOCATION_NEEDED = '고칠 위치는 사이트 소유자가 정해야 합니다';
/** Said at the top of a report built from a synthetic example, in report.md and report.html alike. */
export const SYNTHETIC_BANNER = '예시 보고서 — 실제 사이트나 외부 서비스의 결과가 아닙니다.';
/** The section names, shared by report.md, report.html and the sentences that point to a section. */
export const SECTION_TITLES = { fixes: '먼저 고칠 것', completeness: '얼마나 확인했나', blank: '아직 비어 있는 곳', conditions: '실행 조건',
  remaining: '남은 일', outcomes: '실제 결과', judgments: '모델 판단' };

const html = value => String(value ?? UNKNOWN).replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (columns, rows) => `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(html).join(' | ')} |`).join('\n') || `| ${columns.map(() => '—').join(' | ')} |`}`;
/** One rounding rule for every coverage the report shows: the floor to a tenth, the value the 80% threshold is judged on. */
const floorTenth = value => value === null ? null : Math.floor(value * 10 + 1e-9) / 10;
export const coverageOf = headline => floorTenth(headline.coverage_exact);
/** A percentage as text, or the unknown word when there is no number. */
export const percent = value => typeof value === 'number' ? `${value}%` : UNKNOWN;
const count = value => typeof value === 'number' ? `${value}건` : UNKNOWN;

const PRIORITY_LABELS = { P0: '가장 급함', P1: '중요', P2: '보통' };
const STATUS_LABELS = { confirmed: '확인됨', unknown: '확인하지 못함', proposed_only: '제안만 함', modified_unverified: '고쳤지만 확인 전', verification_failed: '고친 뒤 확인에 실패함',
  verified_local: '내 컴퓨터에서 해결 확인됨', verified_production: '해결 확인됨' };
const CHROME_REASONS = { chrome_not_found: '설치된 크롬을 찾지 못함', optbrew_chrome_missing: '환경 변수 OPTBREW_CHROME가 가리키는 곳에 크롬이 없음' };
const HARNESS_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', 'claude-code-cloud': 'Claude Code 클라우드', other: '기타' };
const TRANSPORT_NAMES = { direct: '직접 연결', proxy: '프록시' };

/** One headline per profile. Below the coverage threshold the single number is withheld and only the measured subset is shown. */
function scoreHeadline(result) {
  const exact = result.A > 0 ? 100 * result.M / result.A : null;
  // Sufficiency reads the value the report shows, so a shown 79.9% is never called sufficient.
  const coverageOk = result.score !== null && exact !== null && floorTenth(exact) >= COVERAGE_THRESHOLD;
  // The design spec also asks for verdicts on the core access and indexing checks before a score counts as sufficient.
  const coreOk = (result.unknown_core ?? []).length === 0;
  const status = !coverageOk ? 'insufficient_coverage' : !coreOk ? 'insufficient_core' : 'sufficient';
  return { profile: result.profile, status, headline_score: status === 'sufficient' ? result.score : null,
    measured_subset_score: result.score, coverage: floorTenth(exact), coverage_exact: exact, coverage_threshold: COVERAGE_THRESHOLD,
    unresolved_core: (result.unknown_core ?? []).length, missing_bounds: result.missing_bounds, readiness_status: result.readiness_status };
}

/** A phase with no audit cannot replay its verdicts: its score is never the headline (R49), and every status says so. */
const phaseOf = (result, input) => {
  const headline = scoreHeadline(result);
  const audited = input.run_context.audited === true;
  return { headline: { ...headline, audited, ...(!audited && headline.status === 'sufficient' ? { status: 'unaudited', headline_score: null } : {}) },
    coverage: headline.coverage, missing_bounds: result.missing_bounds, readiness_status: result.readiness_status };
};

const withoutCwv = (input, profile) => {
  const { A, M } = scoreWeighted(compileUnits(input, profile).filter(unit => !CWV_FAMILIES.includes(unit.family_id)));
  return A === 0 ? null : floorTenth(100 * M / A);
};

export const resolved = finding => finding.status === 'verified_production';
const priorityRank = priority => /^P(\d+)$/.test(priority) ? Number(priority.slice(1)) : Infinity;
const compareRank = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const affectedKey = finding => `${finding.check_id}\0${messageKey(finding.message)}`;
/** The pages a finding affects: the ones it lists, or its own unit. */
const pagesOf = finding => finding.unit_keys ?? [finding.unit_key];
const PAGES_SHOWN = 5;
const SITE_UNIT = 'site';
/** A unit key is `<check>|<address>`; the address may hold `|` itself, so it is everything after the first one. */
const ENGINE_LABELS = { naver: '네이버', google: '구글' };
/** A unit of a check judged per engine reads `<engine>|<address>`: the address first, the engine in parentheses. */
const addressOf = unit => {
  const address = unit.slice(unit.indexOf('|') + 1);
  const engine = /^([A-Za-z][\w-]*)\|(.+)$/.exec(address);
  if (engine) return `${engine[2]} (${ENGINE_LABELS[engine[1]] ?? engine[1]})`;
  return address === SITE_UNIT ? '사이트 전체' : address;
};
/** How a fix row names its pages: the one address (a site-level check reads 「사이트 전체」), or the count and the first few addresses. */
export const pagesLabel = finding => {
  const units = pagesOf(finding);
  if (units.length === 1) return addressOf(units[0]);
  const shown = units.slice(0, PAGES_SHOWN).map(addressOf).join(', ');
  return `(${units.length}개 페이지: ${shown}${units.length > PAGES_SHOWN ? `, 외 ${units.length - PAGES_SHOWN}개` : ''})`;
};

const REMEDIATION_FIELDS = ['mechanism', 'validation', 'effort', 'cost', 'location_hint'];
/**
 * The Korean text of one fix: the sentence for its message key and, when a remediation was chosen, the sentence for each of that
 * remediation's fields. Anything the catalog has no entry for (a model's finding, a remediation of someone's own catalog) keeps its own words.
 */
const fixTextKo = finding => ({ message: koText(finding.message_key, finding.message_values, finding.message),
  cited: citedOf(finding),
  remediation: finding.remediation ? Object.fromEntries(REMEDIATION_FIELDS.map(field =>
    [field, koText(`remediation.${finding.remediation.remediation_id}.${field}`, {}, finding.remediation[field])])) : stepsOf(finding) });

/** A model's fix (and the question coverage's) has no catalogued remediation; the catalog gives its steps under the key of its problem (R100). */
const MODEL_FIX_STEPS = ['mechanism', 'validation', 'effort'];
const stepsOf = finding => {
  const steps = Object.fromEntries(MODEL_FIX_STEPS.map(field => [field, koText(finding.message_key && `${finding.message_key}.${field}`, finding.message_values, null)]));
  return steps.mechanism ? { ...steps, cost: null, location_hint: null } : null;
};
/** Where to look for a model's fix: the body text of the page it names (every page it names, for a grouped one). */
const modelWhere = finding => finding.message_key?.startsWith('model-fix.') ? koText('model-fix.where', { pages: pagesLabel(finding) }, null) : null;
/** The text a model's verdict cites, as the page shows it, so the owner sees where to look. */
const citedOf = finding => finding.message_values?.quote ? koText('model-fix.cited', { quote: finding.message_values.quote }, null) : null;
/** What a fix row says in each column: the problem with its pages and cited text, the method, and the effort. */
const fixProblem = fix => [fix.text_ko.message, pagesLabel(fix), fix.text_ko.cited].filter(Boolean).join(' ');
export const fixMethod = fix => fix.remediation ? `${fix.text_ko.remediation.mechanism} (${fix.remediation.source_url}, 확인일 ${fix.remediation.checked_date})` : fix.text_ko.remediation?.mechanism ?? UNKNOWN;
export const fixEffort = fix => fix.remediation ? `${fix.text_ko.remediation.cost}; ${fix.text_ko.remediation.effort}` : fix.text_ko.remediation?.effort ?? UNKNOWN;

/** Open before resolved, then blocking, then priority (P0 first, an unknown one last), then the problem on the most pages, then the unit. */
function sortedFixes(findings, changes) {
  const pages = new Map();
  for (const finding of findings) pages.set(affectedKey(finding), new Set([...(pages.get(affectedKey(finding)) ?? []), ...pagesOf(finding)]));
  const withPaths = findings.map(finding => {
    const change_paths = changes.filter(change => change.finding_ids.some(id => finding.finding_ids.includes(id))).map(change => change.path);
    const text_ko = fixTextKo(finding);
    return { ...finding, change_paths, text_ko, where: change_paths.join('; ') || modelWhere(finding) || text_ko.remediation?.location_hint || LOCATION_NEEDED,
      priority_label: PRIORITY_LABELS[finding.priority] ?? finding.priority, status_label: STATUS_LABELS[finding.status] ?? finding.status };
  });
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

const FINDING_ROW = 'follow-up.finding';
const FOLLOW_UP_LINES = { problem: 'problem', reason: 'reason', required_input_or_authority: 'input', next_action: 'next', reobserve_when: 'when' };
/**
 * The Korean text of one remaining-work row. A row about a fix is told from the fix: its Korean message, its status word, the chosen
 * remediation's sentences. Any other row that names a catalog key fills that key's lines with its values. A row with no key keeps its own words.
 */
function followUpText(row, fixes) {
  const fix = row.message_key === FINDING_ROW ? fixes.find(item => item.finding_ids.includes(row.finding_id)) : null;
  if (fix) {
    const { remediation } = fix.text_ko;
    const authority = fix.remediation && koText(`authority.${fix.remediation.required_authority}`, {}, row.required_input_or_authority);
    return { problem: fixProblem(fix), reason: fix.status_label,
      required_input_or_authority: authority ?? koText(`${FINDING_ROW}.input`, {}, row.required_input_or_authority),
      next_action: remediation?.mechanism ?? koText(`${FINDING_ROW}.next`, {}, row.next_action),
      reobserve_when: remediation?.validation ?? koText(`${FINDING_ROW}.when`, {}, row.reobserve_when) };
  }
  const named = row.finding_id ? fixes.find(item => item.finding_ids.includes(row.finding_id)) : null;
  const values = { ...row.message_values, ...(named ? { fix: named.text_ko.message } : {}) };
  return Object.fromEntries(Object.entries(FOLLOW_UP_LINES).map(([field, line]) =>
    [field, koText(row.message_key && `${row.message_key}.${line}`, values, row[field])]));
}

const OUTCOME_CODES = /\b(?:comparable_windows|not_comparable_or_missing_window|measured|unknown|zero_or_missing|not_applicable)\b/g;
/** The codes in a cell of the actual-outcome table (the checked data keeps them) read as Korean words. */
const outcomeCell = cell => typeof cell === 'string' ? cell.replace(OUTCOME_CODES, code => koText(`outcome-word.${code}`, {}, code)) : cell;

/** A word the catalog has for a code (a check state, a readiness status); the code itself when it has none. */
const wordFor = (table, code) => koText(`${table}.${code}`, {}, code);

/** The cost and feature limits, one Korean sentence each; a note without a catalog key keeps its English text. */
const costIssuesKo = verified => verified.cost_issues.map((text, index) => {
  const message = verified.cost_issue_messages?.[index];
  return koText(message?.message_key, message?.message_values, text);
});

/** How many units the model declared not applicable in the latest phase, for each family: its own decision, shown apart from the coverage it affects. */
function modelNotApplicable(verified) {
  const phase = verified.after ? 'after' : 'baseline';
  const counts = {};
  for (const row of verified.model_judgments) if (row.phase === phase && row.state === 'not_applicable') counts[row.family_id] = (counts[row.family_id] ?? 0) + 1;
  return counts;
}
/** How many fails of the absence families (a missing operator or date) rest on absence and how many on text the verdict cites, in the latest phase. */
function absenceBasisCounts(verified) {
  const phase = verified.after ? 'after' : 'baseline';
  const counts = { absence: 0, shown: 0 };
  for (const row of verified.model_judgments) if (row.phase === phase && row.basis) counts[row.basis]++;
  return counts;
}
const NOT_ACCEPTED_REASONS = { queue_coverage: '조각이 페이지를 충분히 덮지 못함', visible: '페이지에 날짜나 운영 주체가 보임', chrome: '인용한 조각이 모두 사이트 공통 글', empty_page: '페이지에 글이 없음' };
/** The model verdicts of the latest phase that rested on absence and were turned into unknown by the code, by reason. */
function notAcceptedCounts(input) {
  const counts = {};
  for (const obs of input.observations) {
    const code = obs.evaluator_type === 'host_model' && obs.state === 'unknown' ? obs.measurement?.not_accepted : undefined;
    if (NOT_ACCEPTED_REASONS[code]) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}
/** Which audited pages answer which question of the fixed panel, from the derived question-coverage verdict of a phase; null when it has none. */
function questionCoverageList(input) {
  const verdict = input.observations.find(obs => obs.unit_key === QUESTION_UNIT && obs.source_ref === OBSERVATION_SOURCES.derived);
  if (!verdict) return null;
  const questions = new Map(input.run_context.protocol.question_panel.map(question => [question.id, question.question]));
  return verdict.measurement.list.map(({ question_id, answered_by }) => ({ question_id, question: questions.get(question_id) ?? question_id, pages: answered_by.map(addressOf) }));
}
const notApplicableText = counts => {
  const entries = Object.entries(counts);
  return entries.length ? `${count(entries.reduce((sum, [, n]) => sum + n, 0))} (${entries.map(([family, n]) => `${family} ${count(n)}`).join(', ')})` : '없음';
};

const blockerSummary = scores => ({ count: scores[0]?.blockers.length ?? 0, items: scores[0]?.blockers.map(x => `${x.family_id} ${x.unit_key}`) ?? [],
  core_unknown: scores[0]?.unknown_core.length ?? 0 });

function completenessOf(verified) {
  const { baseline, after } = verified;
  return baseline.scores.map(first => {
    const last = after?.scores.find(result => result.profile === first.profile) ?? null;
    const before = phaseOf(first, baseline.input), later = last ? phaseOf(last, after.input) : null;
    const delta = verified.comparison.score_deltas.find(x => x.profile === first.profile)?.percentage_point_delta ?? null;
    return { profile: first.profile, pass_rate_in_measured: (last ?? first).score, coverage: coverageOf((later ?? before).headline),
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

/** The pages the run treated as deliberately not indexed (no index checks, no blocker), with the catalog key and values of the sentence that says so; null when there are none. */
function notIndexedOf(context) {
  const pages = context.protocol.page_types.flatMap(type => type.urls).filter(url => url.public_indexing === false).map(url => url.normalized);
  return pages.length ? { count: pages.length, pages, ...messageOf('conditions.not-indexed', { count: pages.length, pages: pages.join(', ') }) } : null;
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
  const conditions = { probe: latest.run_context.environment_probe, model_judgments: verified.model_judgments, model_not_applicable: modelNotApplicable(verified), empty_pages: verified.empty_pages ?? [], absence_basis: absenceBasisCounts(verified), not_accepted: notAcceptedCounts(latest), question_coverage: questionCoverageList(latest), lab_cwv: verified.lab_cwv, start_redirect: verified.start_redirect ?? null,
    not_indexed: notIndexedOf(latest.run_context),
    blockers: { before: blockerSummary(verified.baseline.scores), after: verified.after ? blockerSummary(verified.after.scores) : null },
    notes: afterRender ? [JAVASCRIPT_NOTE] : [] };
  conditions.lines = conditionLines(conditions, verified);
  return {
    headline: conclusionOf(fixes, completeness),
    fixes,
    completeness,
    remaining: remainingBlanks(verified, latest),
    conditions,
    follow_ups: verified.follow_ups.map(row => ({ ...row, text_ko: followUpText(row, fixes) })),
  };
}

/** Why a phase's single number is shown or withheld, in one sentence: the line under the summary, and the one the HTML report folds away. */
export const headlineLine = h => (h.status === 'sufficient' ? `${h.profile}: ${h.headline_score}점 (확인 범위 ${percent(coverageOf(h))})` :
  h.status === 'unaudited' ? `${h.profile}: 감사 안 됨 — 확인한 범위 안의 통과율은 ${h.measured_subset_score ?? UNKNOWN}이지만, 이를 뒷받침하는 감사가 없어 점수로 내지 않습니다 (확인 범위 ${percent(coverageOf(h))})` :
  h.status === 'insufficient_core' ? `${h.profile}: 핵심 검사 부족 (접근·색인 검사 ${count(h.unresolved_core)}에 결과가 없습니다. 확인 범위는 ${percent(coverageOf(h))}입니다); 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}, 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN}` :
  `${h.profile}: 확인 범위 부족 (적용 가중치의 ${percent(coverageOf(h))}만 확인했습니다. 점수를 내려면 ${h.coverage_threshold}% 이상 필요합니다); 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}, 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN}`) +
  (h.audited || h.status === 'unaudited' ? '' : '; 이 단계는 감사되지 않아 판정을 다시 계산할 수 없었습니다');

const headlineCell = h => (h.status === 'sufficient' ? `${h.headline_score}점 (확인 범위 ${percent(coverageOf(h))})` :
  h.status === 'unaudited' ? `감사 안 됨 (확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${percent(coverageOf(h))})` :
  h.status === 'insufficient_core' ? `핵심 검사 부족 (${count(h.unresolved_core)} 결과 없음; 확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${percent(coverageOf(h))}; 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN})` :
  `확인 범위 부족 (확인한 범위의 통과율 ${h.measured_subset_score ?? UNKNOWN}; 확인 범위 ${percent(coverageOf(h))}; 점수 범위 ${h.missing_bounds?.join('–') ?? UNKNOWN})`) +
  (h.audited || h.status === 'unaudited' ? '' : ' (감사 안 됨)');

/** The rows of every table, from the composed report and the checked data around it. */
function tableRows(composed, verified) {
  const score = composed.completeness.map(({ profile, before, after, difference, between_measured_subsets: between, coverage_without_cwv: withoutField }) => [
    profile, headlineCell(before.headline), after ? headlineCell(after.headline) : UNKNOWN,
    `${difference ?? UNKNOWN}${between ? ' (확인한 범위끼리의 비교)' : ''}`,
    `${percent(coverageOf(before.headline))} → ${after ? percent(coverageOf(after.headline)) : UNKNOWN}`,
    `${before.missing_bounds?.join('–') ?? UNKNOWN} → ${after?.missing_bounds?.join('–') ?? UNKNOWN}`,
    `${wordFor('readiness', before.readiness_status)} → ${after ? wordFor('readiness', after.readiness_status) : UNKNOWN}`, percent(withoutField)]);
  const remediation = composed.fixes.map(f => [f.priority_label, fixProblem(f), f.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; '),
    fixMethod(f), f.where, fixEffort(f), f.text_ko.remediation?.validation ?? UNKNOWN,
    f.resolution ? `${f.status_label} (${f.resolution.source_ref}의 ${f.resolution.evaluator_type} 관찰로 해결 확인)` : f.status_label]);
  return { score, remediation,
    actual_outcomes: verified.outcome_rows.map(cells => cells.map(outcomeCell)),
    remaining_work: composed.follow_ups.map(({ text_ko: x }) => [x.problem, x.reason, x.required_input_or_authority, x.next_action, x.reobserve_when]),
    model_judgments: composed.conditions.model_judgments.map(x => [x.phase, `${x.family_id} ${x.unit_key}`, wordFor('state', x.state) + (x.identity_basis ? ` (${wordFor('identity-basis', x.identity_basis)})` : ''),
      `${x.evidence_ref} 바이트 ${x.evidence_span.map(span => `${span.start}–${span.end}`).join(', ')}`, x.label]) };
}

/** The run conditions as label and value pairs, the one list both formats print. */
function conditionLines(conditions, verified) {
  const { probe, lab_cwv: lab } = conditions;
  const { before, after } = conditions.blockers;
  const listed = summary => `${count(summary.count)} (${summary.items.map(item => item.replace(/ [^ |]+\|/, ' ').replace(/ site$/, ' 사이트 전체')).join('; ') || '없음'})`;
  return [
    { label: '실행 환경', value: `${HARNESS_NAMES[probe.harness] ?? probe.harness}; 전송 방식 ${TRANSPORT_NAMES[probe.transport] ?? probe.transport ?? UNKNOWN}` },
    { label: '크롬', value: probe.chrome.found ? probe.chrome.kind : `찾지 못함 (${CHROME_REASONS[probe.chrome.reason] ?? probe.chrome.reason ?? UNKNOWN})` },
    { label: 'Google 키', value: probe.google_key ? '있음' : '없음' },
    { label: '분석 도구', value: probe.source_tools.join(', ') || '지정 없음' },
    { label: '확인한 모델 판단', value: count(conditions.model_judgments.length) },
    { label: '모델이 해당 없음으로 판정한 단위', value: notApplicableText(conditions.model_not_applicable) },
    ...(conditions.empty_pages.length ? [{ label: '본문이 빈 페이지', value: `${conditions.empty_pages.length}페이지 (${conditions.empty_pages.join(', ')})` }] : []),
    ...(conditions.absence_basis.absence + conditions.absence_basis.shown ? [{ label: '날짜·운영 주체 판정(fail)의 근거',
      value: `페이지에 없다는 근거 ${conditions.absence_basis.absence}건, 인용한 글에서 직접 확인 ${conditions.absence_basis.shown}건` }] : []),
    ...(Object.keys(conditions.not_accepted).length ? [{ label: '페이지에 없다는 판정 중 받아들이지 않은 것',
      value: Object.entries(conditions.not_accepted).map(([code, n]) => `${NOT_ACCEPTED_REASONS[code]} ${n}건`).join(', ') }] : []),
    ...(conditions.not_indexed ? [{ label: '색인하지 않는 페이지', value: koText(conditions.not_indexed.message_key, conditions.not_indexed.message_values) }] : []),
    { label: '이전 막는 문제', value: listed(before) },
    { label: '이후 막는 문제', value: after ? listed(after) : `${UNKNOWN} (이후 단계를 보지 않음)` },
    { label: '이후 결과 없는 핵심 검사', value: count(after?.core_unknown ?? null) },
    { label: '실제 결과', value: verified.metrics.length ? "아래 '실제 결과'의 측정·빈칸 상태 참고" : '연결 안 됨 / 알 수 없음' },
    { label: '비용·기능 제한', value: costIssuesKo(verified).join('; ') || '기록 없음' },
    { label: '지표 출처 제한', value: verified.metric_origin_limitations.map((text, index) => koText(verified.metric_origin_limitation_messages?.[index]?.message_key, {}, text)).join('; ') || '측정된 제공자 입력 없음' },
    { label: '실험실 Core Web Vitals (참고용, 점수에 넣지 않음)', value: lab ? `LCP ${lab.lcp ?? UNKNOWN} ms; CLS ${lab.cls ?? UNKNOWN}` : '측정하지 않음' },
    ...(conditions.start_redirect ? [{ label: '시작 주소', value: `${conditions.start_redirect.from} → ${conditions.start_redirect.to} (이 주소로 연결되므로 감사는 ${conditions.start_redirect.to}에서 실행했습니다)` }] : []),
  ];
}

/** The questions of the fixed panel and the pages that answer each, as a table for the model-judgment section; empty when there is no coverage verdict. */
const questionLines = list => list ? `${table(['질문', '답하는 페이지'], list.map(item => [item.question, item.pages.join(', ') || koText('question-coverage.not-found')]))}\n\n` +
  `${list.some(item => !item.pages.length) ? `${html(koText('question-coverage.note'))}\n\n` : ''}` : '';

/** `report.md` and the table rows `report.json` carries, both rendered from the composed report. */
export function renderReport(composed, verified) {
  const tables = tableRows(composed, verified);
  const { run_context: context } = verified;
  const blanks = composed.remaining.map(x => [x.item, x.runbook_ids.join(', ')]);
  const latest = composed.completeness.map(row => row.after ?? row.before);
  const markdown = `# optbrew 보고서\n\n${verified.data_class === 'synthetic' ? `**${SYNTHETIC_BANNER}**\n\n` : ''}` +
    `대상: ${html(context.target)}  \n환경: ${html(context.environment)}  \n목표: ${html(context.goals.join(', '))}  \n` +
    `비교: ${html(verified.comparison.status)} (${html(verified.comparison.reasons.join(', ') || '없음')})  \n` +
    `결론: ${html(composed.headline.text)}\n\n` +
    `## ${SECTION_TITLES.fixes}\n\n${table(['우선순위', '문제 / 주소', '근거', '고르는 해결 방법', '고칠 위치 또는 사이트 소유자', '비용 / 노력', '확인 방법', '상태'], tables.remediation)}\n\n` +
    `## ${SECTION_TITLES.completeness} (확인한 범위 안의 통과율)\n\n요약:  \n${latest.map(phase => `- ${html(headlineLine(phase.headline))}  \n`).join('')}\n` +
    `${table(['영역', '이전', '이후', '차이', '확인 범위 이전 → 이후', '점수 범위', '상태', '방문자 실측(CWV)을 뺀 확인 범위(최신)'], tables.score)}\n\n` +
    `## ${SECTION_TITLES.blank}\n\n${table(['비어 있는 것과 채우면 알 수 있는 것', '런북'], blanks)}\n\n` +
    `## ${SECTION_TITLES.conditions}\n\n${[...composed.conditions.lines.map(({ label, value }) => `${label}: ${value}`), ...composed.conditions.notes].map(line => `- ${html(line)}\n`).join('')}\n` +
    `## ${SECTION_TITLES.remaining}\n\n${table(['문제', '이유', '필요한 입력 / 권한', '다음 행동', '다시 볼 때'], tables.remaining_work)}\n\n` +
    `## ${SECTION_TITLES.outcomes}\n\n${table(['검색 엔진 / 속성', '지표', '기간 / 표본', '이전 원값', '이후 원값', '차이', '완료 여부', '한계'], tables.actual_outcomes)}\n\n` +
    (tables.model_judgments.length ? `## ${SECTION_TITLES.judgments}\n\n${html(`모델이 해당 없음으로 판정한 단위: ${notApplicableText(composed.conditions.model_not_applicable)}`)}\n\n${questionLines(composed.conditions.question_coverage)}${table(['단계', '검사 / 대상', '상태', '근거 구간 (UTF-8 바이트, 끝 제외)', '근거'], tables.model_judgments)}\n\n` : '') +
    `증거 폴더: ${html(verified.evidence_root)}; 실행 ID: ${html(context.run_id)}. 점수 계산에 쓴 원본 값은 report.json에서 다시 계산할 수 있습니다.\n`;
  return { markdown, tables };
}
