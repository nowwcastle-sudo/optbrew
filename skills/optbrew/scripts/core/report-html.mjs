import { SECTION_TITLES, SYNTHETIC_BANNER, UNKNOWN, coverageOf, fixEffort, fixMethod, headlineLine, pagesLabel, percent, resolved } from './report-compose.mjs';
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

/** Fixes the top of the section shows large; the rest are compact rows. */
const FIXES_FEATURED = 3;
const LEVEL_OF = fix => resolved(fix) ? 'ok' : fix.blocker ? 'hot' : fix.priority === 'P1' ? 'warm' : 'calm';
const chipOf = fix => resolved(fix) ? '<span class="chip ok">이미 고침</span>' : fix.blocker ? '<span class="chip hot">가장 급함</span>' : `<span class="chip">${esc(fix.priority_label)}</span>`;

/** One page a fix applies to: where, the quoted text, and the details fold. */
const pageHtml = fix => {
  const rows = [['근거', fix.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; ') || UNKNOWN],
    ['비용 / 노력', fixEffort(fix)], ['확인 방법', fix.text_ko.remediation?.validation ?? UNKNOWN], ['상태', fix.status_label]];
  return `<div class="spot"><p class="pages">${esc(pagesLabel(fix))}${fix.text_ko.cited ? ` ${esc(fix.text_ko.cited)}` : ''}</p>` +
    `<p class="where"><strong>고칠 곳</strong> ${esc(fix.where)}</p><details><summary>자세히 보기</summary><dl>${rows.map(([term, value]) => `<dt>${term}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details></div>`;
};

/**
 * One card per problem sentence: the same message on several pages is one thing to fix, so it is said once with each page under it.
 * The fix method shows on the card itself (it is the same for every page of the group).
 */
const groupHtml = (group, rank, featured) => {
  const [first] = group;
  const count = group.length > 1 ? `<span class="count">${group.length}개 페이지</span>` : '';
  return `<li class="fix ${featured ? 'top' : 'row'} ${LEVEL_OF(first)}"><div class="head"><span class="rank">${rank}</span>${chipOf(first)}${count}</div>` +
    `<p class="msg">${esc(first.text_ko.message)}</p><p class="how"><strong>이렇게 고치세요</strong> ${esc(fixMethod(first))}</p>${group.map(pageHtml).join('')}</li>`;
};

/** Fixes in the composed order, grouped by their sentence and priority; a group stands where its first fix stood. */
const groupsOf = fixes => {
  const groups = new Map();
  for (const fix of fixes) {
    const key = `${resolved(fix)}|${fix.blocker}|${fix.priority}|${fix.text_ko.message}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fix);
  }
  return [...groups.values()];
};

const fixesSection = ({ fixes }) => {
  const groups = groupsOf(fixes);
  const shown = groups.slice(0, FIXES_SHOWN), rest = groups.slice(FIXES_SHOWN);
  const list = (items, offset) => `<ol class="fixes">${items.map((group, index) => groupHtml(group, offset + index + 1, offset + index < FIXES_FEATURED)).join('')}</ol>`;
  const lead = groups.length < fixes.length ? `<p class="note">고칠 것 ${fixes.length}건을 같은 문제끼리 묶어 ${groups.length}가지로 보여 줍니다.</p>` : '';
  return `<section id="fixes"><h2>${SECTION_TITLES.fixes}</h2>${fixes.length ? `${lead}${list(shown, 0)}` : '<p>고칠 것이 없습니다. 확인한 범위에서는 실패한 검사가 없었습니다.</p>'}` +
    `${rest.length ? `<details><summary>나머지 ${rest.length}가지 보기</summary>${list(rest, FIXES_SHOWN)}</details>` : ''}</section>`;
};

/** One short plain sentence for the verdict of a phase; the full line waits in the fold. */
const sentenceOf = h => h.status === 'sufficient' ? `확인한 범위의 통과율은 ${h.headline_score}점입니다.` :
  h.status === 'insufficient_coverage' ? `${h.coverage_threshold}% 이상 확인해야 점수를 냅니다. 지금 ${percent(coverageOf(h))}입니다.` :
  h.status === 'insufficient_core' ? `접근·색인 검사 ${esc(h.unresolved_core)}건에 결과가 없어 점수를 내지 않습니다.` : '감사 기록이 없어 점수를 내지 않습니다.';

const profileHtml = row => {
  const phase = row.after ?? row.before, h = phase.headline, shown = coverageOf(h);
  const difference = row.after ? `<p>확인 범위 이전 ${percent(coverageOf(row.before.headline))} → 이후 ${percent(coverageOf(row.after.headline))}; ${typeof row.difference === 'number' ? `이전 → 이후 차이 ${row.difference}점${row.between_measured_subsets ? ' (확인한 범위끼리의 비교)' : ''}` : '두 단계를 비교할 수 없어 차이는 알 수 없습니다'}</p>` : '';
  return `<li class="profile" data-state="${h.status === 'sufficient' ? 'good' : 'short'}"><div class="head"><strong>${esc(row.profile)}</strong><span class="chip">${esc(VERDICTS[h.status])}</span></div>` +
    `<p class="big">${h.status === 'sufficient' ? `${esc(h.headline_score)}<small>점</small>` : '—'}</p>` +
    `${typeof shown === 'number' ? `<meter min="0" max="100" value="${shown}" aria-label="확인 범위 ${shown}%">${shown}%</meter>` : ''}` +
    `<p class="range">확인 범위 ${percent(shown)}</p><p class="say">${sentenceOf(h)}</p>` +
    `<details><summary>자세히</summary><p>${esc(headlineLine(h))}</p>${difference}<p class="note">방문자 실측(CWV)을 뺀 확인 범위 ${percent(row.coverage_without_cwv)}</p></details></li>`;
};

/** Said once under the profiles: the count is the run's, not any one profile's. */
const excludedNote = ({ model_not_applicable: byFamily }) => {
  const excluded = Object.values(byFamily).reduce((sum, n) => sum + n, 0);
  return excluded ? `<p class="note">이번 실행에서 모델이 해당 없음으로 뺀 단위는 모두 ${excluded}건이고, 점수를 내는 영역에 따라 일부만 이 확인 범위에서 빠집니다.</p>` : '';
};

const completenessSection = ({ completeness, conditions }) =>
  `<section id="completeness"><h2>${SECTION_TITLES.completeness}</h2><p class="note">점수는 확인한 범위 안의 통과율입니다. 실제 검색 성과가 아닙니다.</p>` +
  `${completeness.length ? `<ul class="profiles">${completeness.map(profileHtml).join('')}</ul>${excludedNote(conditions)}` : '<p>점수를 낼 영역이 없어 확인 범위를 알 수 없습니다.</p>'}</section>`;

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
:root{color-scheme:light dark;--paper:#f7f4ee;--ink:#17162b;--mut:#57566b;--card:#fff;--line:#e2ddd2;--brand:#23205a;--on-brand:#fff;--brand-mut:#cfcbf2;
--acc:#4b3fd1;--on-acc:#fff;--hot:#c2361f;--warm:#a85700;--ok:#0f7a62;--calm:#4b3fd1;--chip:#efeaf9;--hit:rgba(75,63,209,.18)}
@media (prefers-color-scheme:dark){:root{--paper:#121120;--ink:#f1eff8;--mut:#b4b1c8;--card:#1c1b30;--line:#34324e;--brand:#2b2770;--on-brand:#fff;--brand-mut:#c9c5f0;
--acc:#a99ff7;--on-acc:#121120;--hot:#ff8a73;--warm:#ffb057;--ok:#4fd1b0;--calm:#a99ff7;--chip:#2c2a48;--hit:rgba(169,159,247,.24)}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:500 16px/1.7 Pretendard,"Pretendard Variable","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:52rem;margin:0 auto;padding:0 1rem 4rem}
h1{font-size:.95rem;font-weight:800;letter-spacing:.04em;margin:0;color:var(--brand-mut)}
h2{font-size:1.6rem;font-weight:900;letter-spacing:-.01em;margin:3rem 0 1rem;padding-bottom:.4rem;border-bottom:3px solid var(--ink)}
section{margin-top:1rem}p{margin:.4rem 0}ol,ul{padding-left:1.25rem;margin:.5rem 0}
strong,b{font-weight:800}
.hero{background:var(--brand);color:var(--on-brand);margin:0 -1rem;padding:2rem 1.5rem 1.6rem;border-radius:0 0 20px 20px}
.target{color:var(--brand-mut);font-weight:700;margin:.2rem 0 1rem;font-size:1.05rem}
.hero .lead{font-size:clamp(1.7rem,5vw,2.4rem);line-height:1.25;font-weight:900;letter-spacing:-.02em;margin:0 0 1.4rem}
.banner{border:2px solid var(--hot);background:var(--card);color:var(--ink);border-radius:12px;padding:.5rem .8rem;font-weight:800;margin:1rem 0 0}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;margin:0;padding:0;list-style:none}
.tiles li{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);border-radius:14px;padding:.7rem .9rem;font-weight:700;color:var(--brand-mut)}
.tiles li:first-child{background:var(--on-brand);color:var(--brand)}
.tiles b{display:block;font-size:2.2rem;line-height:1.1;font-weight:900;color:inherit}
.tiles li:not(:first-child) b{color:var(--on-brand)}
.skipped{margin:1.1rem 0 0;border-top:1px solid rgba(255,255,255,.25);padding-top:.8rem;color:var(--brand-mut);font-size:.95rem}
.fixes,.blanks,.profiles{list-style:none;padding:0}
.fix,.blank{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;margin:.7rem 0;border-left:6px solid var(--calm)}
.fix.hot{border-left-color:var(--hot)}.fix.warm{border-left-color:var(--warm)}.fix.ok{border-left-color:var(--ok)}
.fix.top{padding:1.3rem 1.3rem 1.1rem;box-shadow:0 2px 0 var(--line)}
.fix.top .msg{font-size:1.35rem;line-height:1.4;font-weight:900;letter-spacing:-.01em;margin:.5rem 0}
.fix.row .msg{font-size:1.05rem;font-weight:800;margin:.35rem 0}
.head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.rank{display:inline-grid;place-items:center;min-width:1.9rem;height:1.9rem;border-radius:999px;background:var(--ink);color:var(--paper);font-weight:900}
.fix.row .rank{min-width:1.5rem;height:1.5rem;font-size:.85rem}
.msg{font-weight:800}
.count{font-weight:800;color:var(--mut);font-size:.9rem}
.how{background:var(--chip);border-radius:10px;padding:.55rem .75rem;margin:.6rem 0}
.how strong{color:var(--acc);margin-right:.3rem}
.spot{border-top:1px dashed var(--line);margin-top:.6rem;padding-top:.5rem}
.where strong{margin-right:.3rem}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:.05rem .65rem;font-size:.85rem;font-weight:800}
.chip.hot{background:var(--hot);color:var(--card)}.chip.ok{color:var(--ok)}
.pages,.note{color:var(--mut);font-size:.92rem}
.profiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.7rem}
.profile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.9rem;margin:0;border-top:5px solid var(--ok)}
.profile[data-state=short]{border-top-color:var(--warm)}
.profile .head{justify-content:space-between}.profile .head strong{font-size:1.15rem;font-weight:900}
.big{font-size:2.4rem;line-height:1.1;font-weight:900;margin:.5rem 0 .3rem;letter-spacing:-.02em}.big small{font-size:1rem;font-weight:800;margin-left:.15rem}
.range{font-weight:800;font-size:.95rem}.profile .say{font-size:.9rem;color:var(--mut)}
meter{width:100%;height:.7rem}
summary{cursor:pointer;font-weight:800;padding:.35rem 0}
details details{margin-left:.25rem}
dl{display:grid;grid-template-columns:minmax(6rem,max-content) 1fr;gap:.25rem .9rem;margin:.5rem 0}dt{color:var(--mut);font-weight:700}dd{margin:0}
.runbook{border-top:1px solid var(--line);margin-top:.5rem}
.runbook li{margin:.5rem 0}
.step{display:flex;gap:.8rem;align-items:flex-start;flex-wrap:wrap}.say{flex:1 1 14rem}
.shot{flex:0 0 9rem;width:9rem;max-width:100%;height:auto}
.win{fill:var(--card);stroke:var(--line)}.bar{fill:var(--paper)}.dot{fill:var(--line)}.pill{fill:var(--line)}.pane{fill:var(--chip)}.ln{fill:var(--line)}
.term{fill:#1b1f27;stroke:var(--line)}.tl{fill:#8f9bb0}
.hit{fill:var(--hit);stroke:var(--acc);stroke-width:2}.badge{fill:var(--acc)}.num{fill:var(--on-acc);font:700 10px system-ui,sans-serif}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;overflow-x:auto}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
h2,section{scroll-margin-top:1rem}
h2,.hero .lead,.fix .msg{text-wrap:balance}
.big,.tiles b,.rank,.range{font-variant-numeric:tabular-nums}
summary:hover{color:var(--acc)}
summary:focus-visible{outline:3px solid var(--acc);outline-offset:3px;border-radius:6px}
footer{margin-top:3rem;color:var(--mut);font-size:.9rem}
@media (max-width:30rem){.tiles b{font-size:1.7rem}.fix.top .msg{font-size:1.2rem}h2{font-size:1.35rem}}
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
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#23205a"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#2b2770">` +
    `<title>optbrew 보고서</title><style>${STYLE}</style></head><body><main>` +
    `<section class="hero"><h1>사이트 점검 결과</h1><p class="target" translate="no">${esc(target)}</p>${synthetic ? `<p class="banner">${SYNTHETIC_BANNER}</p>` : ''}` +
    `<p class="lead">${esc(headline.text)}</p><ul class="tiles"><li><b>${esc(headline.open)}건</b>먼저 고칠 것</li>` +
    `<li><b>${esc(headline.blocking)}건</b>가장 급한 것</li><li><b>${esc(headline.already_fixed)}건</b>이미 고친 것</li></ul>` +
    `${headline.not_indexed ? `<p class="skipped">${esc(headline.not_indexed.text)}</p>` : ''}</section>` +
    `${fixesSection(composed)}${completenessSection(composed)}${blankSection(composed, runbooks, level)}${followUpsSection(composed)}${conditionsSection(composed)}` +
    `<footer>실제 결과와 모델 판단의 표는 report.md와 report.json에 있습니다. 점수 계산에 쓴 원본 값은 report.json에 있습니다.</footer></main></body></html>\n`;
}
