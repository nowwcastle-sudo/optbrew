import { LOCATION_NEEDED, SECTION_TITLES, UNKNOWN, headlineLine, pagesLabel, resolved } from './report-compose.mjs';
import { runbookEntry } from './runbooks.mjs';

/** Fixes shown open in the "fix first" section; the rest wait inside one fold so the top stays short. */
const FIXES_SHOWN = 10;
const LEVEL_NAMES = { beginner: '자세한 단계', brief: '요약' };

/** Every value that came from the audited site or from the user passes through here: the site is untrusted input. */
const esc = value => String(value ?? UNKNOWN).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Runbook inline marks, applied after escaping: `code` and **bold**. */
const inline = text => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// Where on the screen a runbook step points, read from the words of the step: the zone name and the pattern that picks it.
const ZONES = [
  ['address', '주소창', /주소창|주소 칸/],
  ['terminal', '터미널 창', /터미널|PowerShell|명령 프롬프트|셸/],
  ['side', '왼쪽 메뉴', /왼쪽|메뉴 아이콘|☰/],
  ['top', '화면 위쪽', /위쪽|맨 위|상단|검색 상자|검색창/],
  ['dialog', '새로 열린 창', /창(이|에서|을|이 뜨|이 열)|팝업|대화 상자|물으면/],
];
const MAIN_ZONE = ['main', '화면 가운데'];
// The highlighted box of each zone in the 160 x 100 drawing: x, y, width, height.
const AREAS = { address: [34, 3, 100, 10], top: [1, 1, 158, 14], side: [1, 16, 36, 83], main: [44, 24, 108, 68], dialog: [38, 28, 84, 46], terminal: [8, 52, 144, 16] };
const BROWSER_FRAME = '<rect class="win" x=".5" y=".5" width="159" height="99" rx="6"/><rect class="bar" x="1" y="1" width="158" height="14" rx="5"/>' +
  '<circle class="dot" cx="8" cy="8" r="2"/><circle class="dot" cx="15" cy="8" r="2"/><circle class="dot" cx="22" cy="8" r="2"/><rect class="pill" x="34" y="3" width="100" height="10" rx="5"/>' +
  '<rect class="pane" x="1" y="16" width="36" height="83"/><rect class="ln" x="48" y="30" width="96" height="5" rx="2"/><rect class="ln" x="48" y="44" width="80" height="5" rx="2"/><rect class="ln" x="48" y="58" width="88" height="5" rx="2"/>';
const TERMINAL_FRAME = '<rect class="term" x=".5" y=".5" width="159" height="99" rx="6"/><rect class="tl" x="8" y="12" width="60" height="4" rx="2"/><rect class="tl" x="8" y="26" width="90" height="4" rx="2"/>' +
  '<rect class="tl" x="8" y="40" width="40" height="4" rx="2"/><rect class="tl" x="8" y="58" width="70" height="4" rx="2"/>';

/** One small drawing per step: a schematic window with the step's zone marked and the step number on it. */
function diagram(text, number) {
  const [zone, label] = ZONES.find(([, , pattern]) => pattern.test(text)) ?? MAIN_ZONE;
  const [x, y, width, height] = AREAS[zone];
  const [cx, cy] = [x + width / 2, y + height / 2];
  const name = `${number}단계 대략의 화면 위치: ${label}`;
  return `<svg class="shot" viewBox="0 0 160 100" role="img" aria-label="${esc(name)}"><title>${esc(name)}</title>${zone === 'terminal' ? TERMINAL_FRAME : BROWSER_FRAME}` +
    `<rect class="hit" x="${x}" y="${y}" width="${width}" height="${height}" rx="4"/><circle class="badge" cx="${cx}" cy="${cy}" r="8"/>` +
    `<text class="num" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${number}</text></svg>`;
}

/** A runbook body as blocks: numbered steps, bullets, code fences and paragraphs. */
function blocksOf(text) {
  const blocks = [];
  let fence = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      if (raw.startsWith('```')) { blocks.push({ kind: 'pre', items: fence }); fence = null; } else fence.push(raw);
      continue;
    }
    if (raw.startsWith('```')) { fence = []; continue; }
    const step = /^(\d+)\.\s+(.*)$/.exec(raw), bullet = /^[-*]\s+(.*)$/.exec(raw);
    const kind = step ? 'ol' : bullet ? 'ul' : raw.trim() ? 'p' : null;
    if (!kind) continue;
    const item = step ? step[2] : bullet ? bullet[1] : raw.trim();
    const last = blocks.at(-1);
    if (kind !== 'p' && last?.kind === kind) last.items.push(item);
    else blocks.push({ kind, start: step ? Number(step[1]) : 1, items: [item] });
  }
  if (fence) blocks.push({ kind: 'pre', items: fence });
  return blocks;
}

const stepList = ({ kind, start, items }) => `<${kind}${kind === 'ol' ? ` start="${start}"` : ''}>${items.map((item, index) =>
  `<li><div class="step"><span class="say">${inline(item)}</span>${diagram(item, start + index)}</div></li>`).join('')}</${kind}>`;

const runbookHtml = (runbook, level) => {
  const name = runbookEntry(runbook.id).item.split(' — ')[0];
  const body = blocksOf(runbook.text).map(block => block.kind === 'pre' ? `<pre><code>${esc(block.items.join('\n'))}</code></pre>` :
    block.kind === 'p' ? `<p>${inline(block.items[0])}</p>` : stepList(block)).join('');
  return `<details class="runbook" data-runbook="${esc(runbook.id)}" data-level="${esc(level)}"><summary>${esc(name)} · ${esc(LEVEL_NAMES[level])}</summary>` +
    `<p class="note">그림은 화면 위치를 보여 주는 도식입니다. 실제 화면과 모양이 다를 수 있습니다. 확인일 ${esc(runbook.checked)}.</p>${body}</details>`;
};

const fixHtml = fix => {
  const where = fix.change_paths.join('; ') || fix.remediation?.location_hint || LOCATION_NEEDED;
  const chip = resolved(fix) ? '<span class="chip ok">이미 고침</span>' : fix.blocker ? '<span class="chip hot">가장 급함</span>' : `<span class="chip">${esc(fix.priority)}</span>`;
  const rows = [['근거', fix.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; ') || UNKNOWN],
    ['해결 방법', fix.remediation ? `${fix.remediation.mechanism} (${fix.remediation.source_url}, 확인일 ${fix.remediation.checked_date})` : UNKNOWN],
    ['비용 / 노력', fix.remediation ? `${fix.remediation.cost}; ${fix.remediation.effort}` : UNKNOWN],
    ['확인 방법', fix.remediation?.validation ?? UNKNOWN], ['상태', fix.status]];
  return `<li class="fix"><div class="head">${chip}<span class="msg">${esc(fix.message)}</span></div><p class="pages">${esc(pagesLabel(fix))}</p>` +
    `<p class="where"><strong>고칠 곳</strong> ${esc(where)}</p><details><summary>자세히 보기</summary><dl>${rows.map(([term, value]) => `<dt>${term}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details></li>`;
};

const fixesSection = composed => {
  const { fixes } = composed;
  const shown = fixes.slice(0, FIXES_SHOWN), rest = fixes.slice(FIXES_SHOWN);
  const list = items => `<ol class="fixes">${items.map(fixHtml).join('')}</ol>`;
  return `<section id="fixes"><h2>${SECTION_TITLES.fixes}</h2>${fixes.length ? list(shown) : '<p>고칠 것이 없습니다. 확인한 범위에서는 실패한 검사가 없었습니다.</p>'}` +
    `${rest.length ? `<details><summary>나머지 ${rest.length}건 보기</summary>${list(rest)}</details>` : ''}</section>`;
};

const completenessSection = composed => {
  const rows = composed.completeness.map(row => {
    const phase = row.after ?? row.before;
    const coverage = Number.isFinite(phase.coverage) ? phase.coverage : null;
    return `<li class="profile">${coverage === null ? '' : `<meter min="0" max="100" value="${coverage}" aria-label="확인 범위 ${coverage}%">${coverage}%</meter>`}` +
      `<p class="big">확인 범위 ${esc(coverage)}%</p><p>${esc(headlineLine(phase.headline))}</p>` +
      `${row.after ? `<p>확인 범위 이전 ${esc(row.before.coverage)}% → 이후 ${esc(row.after.coverage)}%; 이전 → 이후 차이 ${esc(row.difference)}점${row.between_measured_subsets ? ' (확인한 범위끼리의 비교)' : ''}</p>` : ''}` +
      `<p class="note">방문자 실측(CWV)을 뺀 확인 범위 ${esc(row.coverage_without_cwv)}%</p></li>`;
  });
  return `<section id="completeness"><h2>${SECTION_TITLES.completeness}</h2><p class="note">점수는 확인한 범위 안의 통과율입니다. 실제 검색 성과가 아닙니다.</p>` +
    `${rows.length ? `<ul class="profiles">${rows.join('')}</ul>` : '<p>점수를 낼 영역이 없어 확인 범위를 알 수 없습니다.</p>'}</section>`;
};

const blankSection = (composed, runbooks, level) => {
  const byId = new Map(runbooks.map(runbook => [runbook.id, runbook]));
  const items = composed.remaining.map(row => `<li class="blank"><p class="msg">${esc(row.item)}</p>` +
    `${row.fills.length ? `<p class="note">채워지는 검사: ${esc(row.fills.join(', '))}</p>` : ''}` +
    `${row.runbook_ids.map(id => {
      if (!byId.has(id)) throw new Error(`runbook missing for the report: ${id}`);
      return runbookHtml(byId.get(id), level);
    }).join('')}</li>`);
  return `<section id="blank"><h2>${SECTION_TITLES.blank}</h2>${items.length ? `<ul class="blanks">${items.join('')}</ul>` : '<p>비어 있는 곳이 없습니다.</p>'}</section>`;
};

const conditionsSection = ({ conditions }) => {
  const { probe, lab_cwv: lab, blockers } = conditions;
  const listed = summary => `${summary.count}건 (${summary.items.join('; ') || '없음'})`;
  const rows = [
    ['실행 환경', `${probe.harness}; 전송 방식 ${probe.transport ?? UNKNOWN}`],
    ['크롬', probe.chrome.found ? probe.chrome.kind : `찾지 못함 (${probe.chrome.reason ?? UNKNOWN})`],
    ['Google 키', probe.google_key ? '있음' : '없음'],
    ['분석 도구', probe.source_tools.join(', ') || '지정 없음'],
    ['확인한 모델 판단', `${conditions.model_judgments.length}건`],
    ['이전 막는 문제', listed(blockers.before)],
    ['이후 막는 문제', blockers.after ? listed(blockers.after) : `${UNKNOWN} (이후 단계를 보지 않음)`],
    ['실험실 Core Web Vitals (참고용, 점수에 넣지 않음)', lab ? `LCP ${lab.lcp ?? UNKNOWN} ms; CLS ${lab.cls ?? UNKNOWN}` : '측정하지 않음'],
    ...(conditions.start_redirect ? [['시작 주소', `${conditions.start_redirect.from} → ${conditions.start_redirect.to}`]] : []),
  ];
  return `<section id="conditions"><details><summary>${SECTION_TITLES.conditions}</summary><dl>${rows.map(([term, value]) => `<dt>${esc(term)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` +
    `${conditions.notes.map(note => `<p class="note">${esc(note)}</p>`).join('')}</details></section>`;
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2430;--mut:#4d5868;--card:#f4f6f9;--line:#cfd6e0;--acc:#0b57d0;--on-acc:#fff;--hot:#a8201a;--ok:#146c2e;--chip:#e3ebfb;--hit:rgba(11,87,208,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#10151c;--fg:#e8ecf2;--mut:#a9b4c4;--card:#1a212b;--line:#35414f;--acc:#8ab4f8;--on-acc:#10151c;--hot:#f2b8b5;--ok:#8ddba3;--chip:#243452;--hit:rgba(138,180,248,.22)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.25rem;margin:2.25rem 0 .75rem}
section{margin-top:1rem}p{margin:.4rem 0}ol,ul{padding-left:1.25rem;margin:.5rem 0}
.target{color:var(--mut);margin:0 0 1rem}
.hero{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.1rem 1.25rem}
.hero .lead{font-size:1.25rem;font-weight:700;margin:0 0 .9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.6rem;margin:0;padding:0;list-style:none}
.tiles li{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem}
.tiles b{display:block;font-size:1.6rem;line-height:1.2}
.fixes,.blanks,.profiles{list-style:none;padding:0}
.fix,.blank,.profile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;margin:.6rem 0}
.head{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}.msg{font-weight:700}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:0 .6rem;font-size:.85rem;font-weight:700}
.chip.hot{color:var(--hot)}.chip.ok{color:var(--ok)}
.pages,.note{color:var(--mut);font-size:.9rem}
.big{font-size:1.35rem;font-weight:700}
meter{width:100%;height:1rem}
summary{cursor:pointer;font-weight:700;padding:.35rem 0}
details details{margin-left:.25rem}
dl{display:grid;grid-template-columns:minmax(6rem,max-content) 1fr;gap:.25rem .9rem;margin:.5rem 0}dt{color:var(--mut)}dd{margin:0}
.runbook{border-top:1px solid var(--line);margin-top:.5rem}
.runbook li{margin:.7rem 0}
.step{display:flex;gap:.8rem;align-items:flex-start;flex-wrap:wrap}.say{flex:1 1 14rem}
.shot{flex:0 0 9rem;width:9rem;max-width:100%;height:auto}
.win{fill:var(--bg);stroke:var(--line)}.bar{fill:var(--card)}.dot{fill:var(--line)}.pill{fill:var(--line)}.pane{fill:var(--chip)}.ln{fill:var(--line)}
.term{fill:#1b1f27;stroke:var(--line)}.tl{fill:#8f9bb0}
.hit{fill:var(--hit);stroke:var(--acc);stroke-width:2}.badge{fill:var(--acc)}.num{fill:var(--on-acc);font:700 10px system-ui,sans-serif}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;overflow-x:auto}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
footer{margin-top:3rem;color:var(--mut);font-size:.9rem}
`;

/**
 * The picture report: one self-contained page from the composed report. Nothing here composes or decides; it only formats.
 * `runbooks` are the loaded runbooks the "still blank" items point to, at the guidance `level`; `target` is the audited address.
 * No script, no external file: the page opens offline, and a policy line refuses any outside request even if site text slipped in.
 */
export function renderHtmlReport(composed, { runbooks, level, target }) {
  const { headline } = composed;
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="color-scheme" content="light dark">` +
    `<title>optbrew 보고서</title><style>${STYLE}</style></head><body><main><h1>사이트 점검 결과</h1><p class="target">${esc(target)}</p>` +
    `<section class="hero"><p class="lead">${esc(headline.text)}</p><ul class="tiles"><li><b>${esc(headline.open)}건</b>먼저 고칠 것</li>` +
    `<li><b>${esc(headline.blocking)}건</b>가장 급한 것</li><li><b>${esc(headline.already_fixed)}건</b>이미 고친 것</li></ul></section>` +
    `${fixesSection(composed)}${completenessSection(composed)}${blankSection(composed, runbooks, level)}${conditionsSection(composed)}` +
    `<footer>이 쪽은 report.md, report.json과 같은 내용을 그림으로 보여 줍니다. 점수 계산에 쓴 원본 값은 report.json에 있습니다.</footer></main></body></html>\n`;
}
