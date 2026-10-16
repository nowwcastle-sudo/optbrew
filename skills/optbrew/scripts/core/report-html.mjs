import { SECTION_TITLES, SYNTHETIC_BANNER, UNKNOWN, coverageOf, headlineLine, pagesLabel, percent, resolved } from './report-compose.mjs';
import { runbookEntry } from './runbooks.mjs';

/** Fixes shown open in the "fix first" section; the rest wait inside one fold so the top stays short. */
const FIXES_SHOWN = 10;
const LEVEL_NAMES = { beginner: '자세한 단계', brief: '요약' };
const VERDICTS = { sufficient: '충분', insufficient_coverage: '확인 부족', insufficient_core: '핵심 검사 빠짐', unaudited: '감사 안 됨' };

/** Every value that came from the audited site or from the user passes through here: the site is untrusted input. */
const esc = value => String(value ?? UNKNOWN).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Runbook inline marks, applied after escaping: `code` spans first, then **bold** outside them, so the tags never cross. */
const inline = text => esc(text).split(/(`[^`]+`)/).map(part => part.startsWith('`') && part.endsWith('`') && part.length > 1 ?
  `<code>${part.slice(1, -1)}</code>` : part.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')).join('');

// A runbook step shows a drawing only when its author names the screen zone with a trailing tag, `{화면: 주소창}`.
// A zone is never guessed from the words of a step: a wrong mark sends a beginner to the wrong place.
const ZONES = { '주소창': 'address', '화면 위쪽': 'top', '왼쪽 메뉴': 'side', '화면 가운데': 'main', '새 창': 'dialog', '터미널': 'terminal' };
const ZONE_TAG = /\s*\{화면:\s*([^}]+?)\s*\}\s*$/;
// The highlighted box of each zone in the 160 x 100 drawing: x, y, width, height.
const AREAS = { address: [34, 3, 100, 10], top: [1, 1, 158, 14], side: [1, 16, 36, 83], main: [44, 24, 108, 68], dialog: [38, 28, 84, 46], terminal: [8, 52, 144, 16] };
const BROWSER_FRAME = '<rect class="win" x=".5" y=".5" width="159" height="99" rx="6"/><rect class="bar" x="1" y="1" width="158" height="14" rx="5"/>' +
  '<circle class="dot" cx="8" cy="8" r="2"/><circle class="dot" cx="15" cy="8" r="2"/><circle class="dot" cx="22" cy="8" r="2"/><rect class="pill" x="34" y="3" width="100" height="10" rx="5"/>' +
  '<rect class="pane" x="1" y="16" width="36" height="83"/><rect class="ln" x="48" y="30" width="96" height="5" rx="2"/><rect class="ln" x="48" y="44" width="80" height="5" rx="2"/><rect class="ln" x="48" y="58" width="88" height="5" rx="2"/>';
const TERMINAL_FRAME = '<rect class="term" x=".5" y=".5" width="159" height="99" rx="6"/><rect class="tl" x="8" y="12" width="60" height="4" rx="2"/><rect class="tl" x="8" y="26" width="90" height="4" rx="2"/>' +
  '<rect class="tl" x="8" y="40" width="40" height="4" rx="2"/><rect class="tl" x="8" y="58" width="70" height="4" rx="2"/>';

/** One small drawing: a schematic window with the named zone marked and the step number on it. */
function diagram(name, number) {
  const zone = ZONES[name];
  const [x, y, width, height] = AREAS[zone];
  const [cx, cy] = [x + width / 2, y + height / 2];
  const label = `${number}단계 대략의 화면 위치: ${name}`;
  return `<svg class="shot" viewBox="0 0 160 100" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${zone === 'terminal' ? TERMINAL_FRAME : BROWSER_FRAME}` +
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

/** A numbered list keeps the author's numbers; a step carries a drawing only where it names a zone. Returns the markup and the drawings made. */
function listHtml({ kind, start, items }) {
  let drawings = 0;
  const rows = items.map((item, index) => {
    const tag = kind === 'ol' ? ZONE_TAG.exec(item) : null;
    const text = item.replace(ZONE_TAG, '');
    const picture = tag && Object.hasOwn(ZONES, tag[1]) ? (drawings += 1, diagram(tag[1], start + index)) : '';
    return picture ? `<li><div class="step"><span class="say">${inline(text)}</span>${picture}</div></li>` : `<li>${inline(text)}</li>`;
  });
  return { html: `<${kind}${kind === 'ol' ? ` start="${start}"` : ''}>${rows.join('')}</${kind}>`, drawings };
}

const runbookHtml = (runbook, level) => {
  const name = runbookEntry(runbook.id).item.split(' — ')[0];
  let drawings = 0;
  const body = blocksOf(runbook.text).map(block => {
    if (block.kind === 'pre') return `<pre><code>${esc(block.items.join('\n'))}</code></pre>`;
    if (block.kind === 'p') return `<p>${inline(block.items[0])}</p>`;
    const list = listHtml(block);
    drawings += list.drawings;
    return list.html;
  }).join('');
  const note = drawings ? ' 그림은 화면 위치를 보여 주는 도식입니다. 실제 화면과 모양이 다를 수 있습니다.' : '';
  return `<details class="runbook" data-runbook="${esc(runbook.id)}" data-level="${esc(level)}"><summary>${esc(name)} · ${esc(LEVEL_NAMES[level])}</summary>` +
    `<p class="note">확인일 ${esc(runbook.checked)}.${note}</p>${body}</details>`;
};

const fixHtml = fix => {
  const chip = resolved(fix) ? '<span class="chip ok">이미 고침</span>' : fix.blocker ? '<span class="chip hot">가장 급함</span>' : `<span class="chip">${esc(fix.priority_label)}</span>`;
  const rows = [['근거', fix.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; ') || UNKNOWN],
    ['해결 방법', fix.remediation ? `${fix.text_ko.remediation.mechanism} (${fix.remediation.source_url}, 확인일 ${fix.remediation.checked_date})` : UNKNOWN],
    ['비용 / 노력', fix.remediation ? `${fix.text_ko.remediation.cost}; ${fix.text_ko.remediation.effort}` : UNKNOWN],
    ['확인 방법', fix.text_ko.remediation?.validation ?? UNKNOWN], ['상태', fix.status_label]];
  return `<li class="fix"><div class="head">${chip}<span class="msg">${esc(fix.text_ko.message)}</span></div><p class="pages">${esc(pagesLabel(fix))}</p>` +
    `<p class="where"><strong>고칠 곳</strong> ${esc(fix.where)}</p><details><summary>자세히 보기</summary><dl>${rows.map(([term, value]) => `<dt>${term}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details></li>`;
};

const fixesSection = ({ fixes }) => {
  const shown = fixes.slice(0, FIXES_SHOWN), rest = fixes.slice(FIXES_SHOWN);
  const list = items => `<ol class="fixes">${items.map(fixHtml).join('')}</ol>`;
  return `<section id="fixes"><h2>${SECTION_TITLES.fixes}</h2>${fixes.length ? list(shown) : '<p>고칠 것이 없습니다. 확인한 범위에서는 실패한 검사가 없었습니다.</p>'}` +
    `${rest.length ? `<details><summary>나머지 ${rest.length}건 보기</summary>${list(rest)}</details>` : ''}</section>`;
};

/** One short plain sentence for the verdict of a phase; the full line waits in the fold. */
const sentenceOf = h => h.status === 'sufficient' ? `확인한 범위의 통과율은 ${h.headline_score}점입니다.` :
  h.status === 'insufficient_coverage' ? `${h.coverage_threshold}% 이상 확인해야 점수를 냅니다. 지금 ${percent(coverageOf(h))}입니다.` :
  h.status === 'insufficient_core' ? `접근·색인 검사 ${esc(h.unresolved_core)}건에 결과가 없어 점수를 내지 않습니다.` : '감사 기록이 없어 점수를 내지 않습니다.';

const profileHtml = row => {
  const phase = row.after ?? row.before, h = phase.headline, shown = coverageOf(h);
  const difference = row.after ? `<p>확인 범위 이전 ${percent(coverageOf(row.before.headline))} → 이후 ${percent(coverageOf(row.after.headline))}; ${typeof row.difference === 'number' ? `이전 → 이후 차이 ${row.difference}점${row.between_measured_subsets ? ' (확인한 범위끼리의 비교)' : ''}` : '두 단계를 비교할 수 없어 차이는 알 수 없습니다'}</p>` : '';
  return `<li class="profile"><div class="head"><strong>${esc(row.profile)}</strong><span class="chip">${esc(VERDICTS[h.status])}</span></div>` +
    `${typeof shown === 'number' ? `<meter min="0" max="100" value="${shown}" aria-label="확인 범위 ${shown}%">${shown}%</meter>` : ''}` +
    `<p class="big">확인 범위 ${percent(shown)}</p><p>${sentenceOf(h)}</p>` +
    `<details><summary>자세히</summary><p>${esc(headlineLine(h))}</p>${difference}<p class="note">방문자 실측(CWV)을 뺀 확인 범위 ${percent(row.coverage_without_cwv)}</p></details></li>`;
};

const completenessSection = ({ completeness }) =>
  `<section id="completeness"><h2>${SECTION_TITLES.completeness}</h2><p class="note">점수는 확인한 범위 안의 통과율입니다. 실제 검색 성과가 아닙니다.</p>` +
  `${completeness.length ? `<ul class="profiles">${completeness.map(profileHtml).join('')}</ul>` : '<p>점수를 낼 영역이 없어 확인 범위를 알 수 없습니다.</p>'}</section>`;

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

const followUpsSection = ({ follow_ups: followUps }) => {
  const rows = followUps.map(({ text_ko: item }) => `<li class="blank"><p class="msg">${esc(item.problem)}</p><dl><dt>필요한 입력 / 권한</dt><dd>${esc(item.required_input_or_authority)}</dd><dt>다음 행동</dt><dd>${esc(item.next_action)}</dd><dt>다시 볼 때</dt><dd>${esc(item.reobserve_when)}</dd></dl></li>`);
  return `<section id="remaining"><h2>${SECTION_TITLES.remaining}</h2><details><summary>${followUps.length}건 보기</summary>` +
    `${rows.length ? `<ul class="blanks">${rows.join('')}</ul>` : '<p>남은 일이 없습니다.</p>'}</details></section>`;
};

const conditionsSection = ({ conditions }) =>
  `<section id="conditions"><details><summary>${SECTION_TITLES.conditions}</summary><dl>${conditions.lines.map(({ label, value }) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` +
  `${conditions.notes.map(note => `<p class="note">${esc(note)}</p>`).join('')}</details></section>`;

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2430;--mut:#4d5868;--card:#f4f6f9;--line:#cfd6e0;--acc:#0b57d0;--on-acc:#fff;--hot:#a8201a;--ok:#146c2e;--chip:#e3ebfb;--hit:rgba(11,87,208,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#10151c;--fg:#e8ecf2;--mut:#a9b4c4;--card:#1a212b;--line:#35414f;--acc:#8ab4f8;--on-acc:#10151c;--hot:#f2b8b5;--ok:#8ddba3;--chip:#243452;--hit:rgba(138,180,248,.22)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.25rem;margin:2.25rem 0 .75rem}
section{margin-top:1rem}p{margin:.4rem 0}ol,ul{padding-left:1.25rem;margin:.5rem 0}
.target{color:var(--mut);margin:0 0 1rem}
.banner{border:2px solid var(--hot);border-radius:10px;padding:.5rem .8rem;font-weight:700;margin:0 0 1rem}
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
.runbook li{margin:.5rem 0}
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
 * `runbooks` are the loaded runbooks the "still blank" items point to, at the guidance `level`; `target` is the audited address;
 * `synthetic` marks an example report. No script, no external file: the page opens offline, and a policy line refuses any
 * outside request even if site text slipped in.
 */
export function renderHtmlReport(composed, { runbooks, level, target, synthetic = false }) {
  const { headline } = composed;
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="color-scheme" content="light dark">` +
    `<title>optbrew 보고서</title><style>${STYLE}</style></head><body><main><h1>사이트 점검 결과</h1><p class="target">${esc(target)}</p>` +
    `${synthetic ? `<p class="banner">${SYNTHETIC_BANNER}</p>` : ''}` +
    `<section class="hero"><p class="lead">${esc(headline.text)}</p><ul class="tiles"><li><b>${esc(headline.open)}건</b>먼저 고칠 것</li>` +
    `<li><b>${esc(headline.blocking)}건</b>가장 급한 것</li><li><b>${esc(headline.already_fixed)}건</b>이미 고친 것</li></ul></section>` +
    `${fixesSection(composed)}${completenessSection(composed)}${blankSection(composed, runbooks, level)}${followUpsSection(composed)}${conditionsSection(composed)}` +
    `<footer>실제 결과와 모델 판단의 표는 report.md와 report.json에 있습니다. 점수 계산에 쓴 원본 값은 report.json에 있습니다.</footer></main></body></html>\n`;
}
