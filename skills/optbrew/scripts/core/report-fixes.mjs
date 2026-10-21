import { SECTION_TITLES, SYNTHETIC_BANNER, UNKNOWN, fixMethod, markdownText, pageAddresses, resolved } from './report-compose.mjs';

/** The file name of the list, beside `report.md`; the audit prints it in `reports.fixes`. */
export const FIXES_FILE = 'fixes.md';

/**
 * One open fix as a section of the list: the finding, its pages (all of them, one per line when there are several), the problem,
 * the method, how to check it and where to look. Every word comes from the composed fix; nothing is looked up again, so a replay
 * of an old packet reads as the run did.
 */
function fixSection(fix) {
  const addresses = pageAddresses(fix);
  const pages = addresses.length === 1 ? ` ${markdownText(addresses[0])}` : `\n${addresses.map(address => `  - ${markdownText(address)}`).join('\n')}`;
  const problem = [fix.text_ko.message, fix.text_ko.cited].filter(Boolean).join(' ');
  return [`## ${markdownText(fix.finding_id)}`, '',
    `- 문제: ${markdownText(problem)}`,
    `- 페이지:${pages}`,
    `- 고치는 방법: ${markdownText(fixMethod(fix))}`,
    `- 확인하는 방법: ${markdownText(fix.text_ko.remediation?.validation ?? UNKNOWN)}`,
    `- 고칠 위치: ${markdownText(fix.where)}`].join('\n');
}

/**
 * `fixes.md`: the fixes that are still open, in the order of the report, so the agent that fixes the site and the owner who reads it
 * work from one list. A fix whose resolution was confirmed in production is left out and counted. The score and the coverage stay
 * in `report.md`; with no open fix the file says where an unchecked part would show.
 */
export function fixesMarkdown(composed, { synthetic = false } = {}) {
  const open = composed.fixes.filter(fix => !resolved(fix));
  const done = composed.fixes.length - open.length;
  const intro = open.length
    ? `열려 있는 고칠 것은 ${open.length}건입니다. 점수와 확인 범위는 report.md에서 봅니다.`
    : `지금 열려 있는 고칠 것이 없습니다. 확인하지 못한 곳이 남았는지는 report.md의 「${SECTION_TITLES.completeness}」와 「${SECTION_TITLES.blank}」에서 봅니다.`;
  return ['# 고칠 것 목록', '', ...(synthetic ? [`**${SYNTHETIC_BANNER}**`, ''] : []), intro,
    ...(done ? ['', `해결이 확인된 ${done}건은 이 목록에 넣지 않았습니다.`] : []),
    ...open.flatMap(fix => ['', fixSection(fix)])].join('\n') + '\n';
}
