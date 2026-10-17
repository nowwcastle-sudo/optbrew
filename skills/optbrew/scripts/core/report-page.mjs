import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtmlReport } from './report-html.mjs';
import { loadRunbook } from './runbooks.mjs';

/** The skill folder; the runbooks name it where they run a script of the skill. */
const SKILL_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * The page writer a report run hands to `writeReport`: the composed report in, the HTML out, with each runbook the blank items point to
 * loaded once at the guidance `level`. A run (`run.mjs`) and a report replay (`cli.mjs report`) both write `report.html` through it.
 */
export const htmlReportWriter = ({ level, target, synthetic = false }) => composed =>
  renderHtmlReport(composed, { runbooks: [...new Set(composed.remaining.flatMap(row => row.runbook_ids))].map(id => loadRunbook(id, level, { skillRoot: SKILL_ROOT })), level, target, synthetic });
