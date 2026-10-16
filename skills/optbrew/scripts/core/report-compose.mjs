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
const JAVASCRIPT_NOTE = 'Naver and AI crawlers may not run JavaScript, so a page that needs JavaScript to show its content can look empty to them. This note is not part of any score.';

const html = value => String(value ?? 'unknown').replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (columns, rows) => `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(html).join(' | ')} |`).join('\n') || `| ${columns.map(() => '—').join(' | ')} |`}`;
const floorTenth = value => value === null ? 'unknown' : Math.floor(value * 10 + 1e-9) / 10;

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

const resolved = finding => finding.status === 'verified_production';
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
  return `(${units.length} pages: ${shown}${units.length > PAGES_SHOWN ? `, and ${units.length - PAGES_SHOWN} more` : ''})`;
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

/** A clean result never hides a thin one (D4): with no open fix but an incomplete check, the line says so. */
function conclusionOf(fixes, completeness) {
  const open = fixes.filter(finding => !resolved(finding));
  const blocking = open.filter(finding => finding.blocker).length;
  const thin = completeness.some(row => (row.after ?? row.before).headline.status !== 'sufficient');
  const none = thin ? 'Nothing failed in what was checked, but the check is incomplete; see Still blank.' : 'Nothing is left to fix in what was checked.';
  return { open: open.length, blocking, already_fixed: fixes.length - open.length,
    text: open.length ? `${open.length} thing(s) to fix first${blocking ? `, ${blocking} of them blocking` : ''}.` : none };
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

const headlineLine = h => (h.status === 'sufficient' ? `${h.profile}: ${h.headline_score} (coverage ${h.coverage}%)` :
  h.status === 'unaudited' ? `${h.profile}: not audited: ${h.measured_subset_score ?? 'unknown'} is the pass rate within what was measured, and no audit backs it (coverage ${h.coverage}%)` :
  h.status === 'insufficient_core' ? `${h.profile}: insufficient core checks (${h.unresolved_core} access or indexing check(s) have no verdict, although ${h.coverage}% is measured); measured subset ${h.measured_subset_score ?? 'unknown'}, bounds ${h.missing_bounds?.join('–') ?? 'unknown'}` :
  `${h.profile}: insufficient coverage (${floorTenth(h.coverage_exact)}% of the applicable weight is measured; at least ${h.coverage_threshold}% is needed); measured subset ${h.measured_subset_score ?? 'unknown'}, bounds ${h.missing_bounds?.join('–') ?? 'unknown'}`) +
  (h.audited || h.status === 'unaudited' ? '' : '; this phase was not audited, so its verdicts could not be replayed');

const headlineCell = h => (h.status === 'sufficient' ? `${h.headline_score} (coverage ${h.coverage}%)` :
  h.status === 'unaudited' ? `not audited (measured subset ${h.measured_subset_score ?? 'unknown'}; coverage ${h.coverage ?? 'unknown'}%)` :
  h.status === 'insufficient_core' ? `insufficient core checks (${h.unresolved_core} unresolved; measured subset ${h.measured_subset_score ?? 'unknown'}; coverage ${h.coverage ?? 'unknown'}%; bounds ${h.missing_bounds?.join('–') ?? 'unknown'})` :
  `insufficient coverage (measured subset ${h.measured_subset_score ?? 'unknown'}; coverage ${h.coverage ?? 'unknown'}%; bounds ${h.missing_bounds?.join('–') ?? 'unknown'})`) +
  (h.audited || h.status === 'unaudited' ? '' : ' (not audited)');

/** The rows of every table, from the composed report and the checked data around it. */
function tableRows(composed, verified) {
  const score = composed.completeness.map(({ profile, before, after, difference, between_measured_subsets: between, coverage_without_cwv: withoutField }) => [
    profile, headlineCell(before.headline), after ? headlineCell(after.headline) : 'unknown',
    `${difference ?? 'unknown'}${between ? ' (between measured subsets)' : ''}`,
    `${before.coverage ?? 'unknown'} → ${after?.coverage ?? 'unknown'}`,
    `${before.missing_bounds?.join('–') ?? 'unknown'} → ${after?.missing_bounds?.join('–') ?? 'unknown'}`,
    `${before.readiness_status} → ${after?.readiness_status ?? 'unknown'}`, withoutField ?? 'unknown']);
  const remediation = composed.fixes.map(f => [f.priority, `${f.message} ${pagesLabel(f)}`, f.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; '),
    f.remediation ? `${f.remediation.mechanism} (${f.remediation.source_url}, checked ${f.remediation.checked_date})` : 'unknown',
    f.change_paths.join('; ') || f.remediation?.location_hint || 'owner implementation location required',
    f.remediation ? `${f.remediation.cost}; ${f.remediation.effort}` : 'unknown', f.remediation?.validation ?? 'unknown',
    f.resolution ? `${f.status} (resolved by ${f.resolution.evaluator_type} observation from ${f.resolution.source_ref})` : f.status]);
  return { score, remediation,
    actual_outcomes: verified.outcome_rows,
    remaining_work: verified.follow_ups.map(x => [x.problem, x.reason, x.required_input_or_authority, x.next_action, x.reobserve_when]),
    model_judgments: composed.conditions.model_judgments.map(x => [x.phase, `${x.family_id} ${x.unit_key}`, x.state,
      `${x.evidence_ref} bytes ${x.evidence_span.map(span => `${span.start}–${span.end}`).join(', ')}`, x.label]) };
}

const conditionLines = (conditions, verified) => {
  const { probe, lab_cwv: lab } = conditions;
  const { before, after } = conditions.blockers;
  const listed = summary => `${summary.count} (${summary.items.join('; ') || 'none'})`;
  return [
    `Host: ${probe.harness}; transport: ${probe.transport ?? 'unknown'}; Chrome: ${probe.chrome.found ? probe.chrome.kind : `not found (${probe.chrome.reason ?? 'unknown'})`}; Google key: ${probe.google_key ? 'present' : 'absent'}`,
    `Analysis tools: ${probe.source_tools.join(', ') || 'none named'}; model judgments checked: ${conditions.model_judgments.length}`,
    `Baseline blockers: ${listed(before)} → After blockers: ${after ? listed(after) : 'unknown (after not observed)'}; ` +
      `after core unknown: ${after?.core_unknown ?? 'unknown'}; actual outcomes: ${verified.metrics.length ? 'see measured and missing states below' : 'not_connected / unknown'}`,
    `Cost and capability limitations: ${verified.cost_issues.join('; ') || 'none recorded'}`,
    `Metric source limitations: ${verified.metric_origin_limitations.join('; ') || 'no measured provider input'}`,
    `Lab Core Web Vitals (reference, not scored): ${lab ? `LCP ${lab.lcp ?? 'unknown'} ms; CLS ${lab.cls ?? 'unknown'}` : 'not measured'}`,
    ...(conditions.start_redirect ? [`Start address: ${conditions.start_redirect.from} leads to ${conditions.start_redirect.to}, so the audit ran on ${conditions.start_redirect.to}`] : []),
    ...conditions.notes,
  ];
};

/** `report.md` and the table rows `report.json` carries, both rendered from the composed report. */
export function renderReport(composed, verified) {
  const tables = tableRows(composed, verified);
  const { run_context: context } = verified;
  const blanks = composed.remaining.map(x => [x.item, x.runbook_ids.join(', ')]);
  const latest = composed.completeness.map(row => row.after ?? row.before);
  const markdown = `# optbrew report\n\n${verified.data_class === 'synthetic' ? '**Synthetic example — no real site or provider outcome.**\n\n' : ''}` +
    `Target: ${html(context.target)}  \nEnvironment: ${html(context.environment)}  \nGoals: ${html(context.goals.join(', '))}  \n` +
    `Comparison: ${html(verified.comparison.status)} (${html(verified.comparison.reasons.join(', ') || 'none')})  \n` +
    `Result: ${html(composed.headline.text)}\n\n` +
    `## Fix first\n\n${table(['Priority', 'Problem / URL', 'Evidence', 'Selected remedy', 'Change path or owner location', 'Cost / effort', 'Verification', 'Status'], tables.remediation)}\n\n` +
    `## Completeness (pass rate within what was measured)\n\nHeadline:  \n${latest.map(phase => `- ${html(headlineLine(phase.headline))}  \n`).join('')}\n` +
    `${table(['Area', 'Before', 'After', 'Difference', 'Coverage before → after', 'Missing bounds', 'Status', 'Coverage without field CWV (latest)'], tables.score)}\n\n` +
    `## Still blank\n\n${table(['Missing, and what it adds', 'Runbooks'], blanks)}\n\n` +
    `## Run conditions\n\n${conditionLines(composed.conditions, verified).map(line => `- ${html(line)}\n`).join('')}\n` +
    `## Remaining work\n\n${table(['Problem', 'Reason', 'Needed input / authority', 'Next action', 'Reobserve when'], tables.remaining_work)}\n\n` +
    `## Actual outcomes\n\n${table(['Engine / property', 'Metric', 'Window / sample', 'Before raw', 'After raw', 'Difference', 'Completion', 'Limitations'], tables.actual_outcomes)}\n\n` +
    (tables.model_judgments.length ? `## Model judgments\n\n${table(['Phase', 'Check / unit', 'State', 'Evidence span (UTF-8 bytes, end excluded)', 'Basis'], tables.model_judgments)}\n\n` : '') +
    `Evidence root: ${html(verified.evidence_root)}; run ID: ${html(context.run_id)}. Read report.json to replay raw score inputs.\n`;
  return { markdown, tables };
}
