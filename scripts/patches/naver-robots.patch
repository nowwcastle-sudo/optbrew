#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRobots, robotsVerdict } from './robots.mjs';

/**
 * naver-searchadvisor-expert / audit.mjs
 *
 * URL 하나를 네이버 서치어드바이저 웹마스터 가이드 기준으로 점검한다.
 * 의존성 없음. Node 18+ (전역 fetch).
 *
 *   node audit.mjs https://example.com
 *   node audit.mjs https://example.com --json
 *
 * 판정 근거는 references/INDEX.md (official URLs) 의 원문이며, 각 항목에 guid를 붙인다.
 * 기계적으로 확인 가능한 것만 본다. 콘텐츠 품질·스팸 소지는 사람이 판단해야 한다.
 */

const YETI_UA =
  'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

// ── 결과 수집 ────────────────────────────────────────────────────────────
// BLOCK: 수집/색인 자체를 막음  INDEX: 색인 품질 저해
// SERP : 검색결과 표현 저하     INFO : 참고 / 정상
const findings = [];
const add = (level, code, message, guid, fix) =>
  findings.push({ level, code, message, guid, fix });

const LEVEL_ORDER = { BLOCK: 0, INDEX: 1, SERP: 2, INFO: 3 };

// ── 유틸 ─────────────────────────────────────────────────────────────────
async function get(url, { ua = YETI_UA, method = 'GET', redirect = 'manual' } = {}) {
  throw new Error('direct remote fetch disabled; use optbrew audit with a RunContext');
}

/** 리다이렉트 체인을 직접 따라가며 기록한다 (최대 10회). */
async function follow(url, ua) {
  const chain = [];
  let current = url;
  for (let i = 0; i < 10; i++) {
    let res;
    try {
      res = await get(current, { ua });
    } catch (e) {
      chain.push({ url: current, error: String(e.message || e) });
      return { chain, final: null };
    }
    const loc = res.headers.get('location');
    chain.push({ url: current, status: res.status, location: loc });
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return { chain, final: res, finalUrl: current };
  }
  return { chain, final: null, tooMany: true };
}

/** <head> 안의 태그를 속성 맵으로 뽑는다. 의존성 없이 쓸 만한 수준. */
function tags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = are.exec(m[1]))) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    }
    out.push(attrs);
  }
  return out;
}

function textOf(html, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

const metaBy = (metas, key, val) =>
  metas.filter((t) => (t[key] || '').toLowerCase() === val).map((t) => t.content ?? '');

/**
 * 이미지 앞부분만 Range로 받는다. 전체 바이트 수는 Content-Range/Content-Length에서 얻는다.
 * Range를 무시하는 서버면 전체 응답을 그대로 쓴다.
 */
async function fetchRange(url, first = 65536) {
  throw new Error('direct remote fetch disabled; use collected evidence');
}

// ── 이미지 크기 (og:image 검증용) ────────────────────────────────────────
function imageSize(buf) {
  const b = Buffer.from(buf);
  if (b.length < 24) return null;
  // PNG
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  // GIF
  if (b.toString('ascii', 0, 3) === 'GIF')
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' };
  // WebP
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = b.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1, type: 'webp' };
    if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (fmt === 'VP8L') {
      const n = b.readUInt32LE(21);
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    return null;
  }
  // JPEG — SOFn 마커 탐색
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), type: 'jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// ── 본 점검 ──────────────────────────────────────────────────────────────
async function audit(target) {
  const url = new URL(target);
  const origin = url.origin;

  // 1) 리다이렉트 체인 + 최종 응답 (Yeti UA)
  const { chain, final, finalUrl, tooMany } = await follow(url.href, YETI_UA);

  if (tooMany) {
    add('BLOCK', 'redirect-loop', '리다이렉트가 10회를 넘습니다. 루프일 가능성이 높습니다.', 'seo-basic-redirect',
      '리다이렉트 체인을 1회로 줄이세요.');
    return { url: url.href, chain, findings };
  }
  if (!final) {
    add('BLOCK', 'unreachable',
      `Yeti User-Agent로 접속하지 못했습니다: ${chain.at(-1)?.error ?? '알 수 없는 오류'}`,
      'seo-basic-firewall',
      '방화벽/WAF가 Yeti UA 또는 네이버 IP 대역을 차단하는지 확인하세요.');
    return { url: url.href, chain, findings };
  }

  const hops = chain.filter((c) => c.status >= 300 && c.status < 400).length;
  if (hops === 0) {
    add('INFO', 'redirect-none', '리다이렉트 없이 바로 응답합니다.', 'seo-basic-redirect');
  } else if (hops === 1) {
    add('INFO', 'redirect-1', `리다이렉트 1회: ${chain[0].status} → ${finalUrl}`, 'seo-basic-redirect');
  } else {
    add('INDEX', 'redirect-chain',
      `리다이렉트가 ${hops}회 연결되어 있습니다: ${chain.map((c) => c.status ?? 'END').join(' → ')}`,
      'seo-basic-redirect',
      '체인을 최종 목적지로 직접 연결해 1회로 줄이세요.');
  }

  if (final.status >= 400) {
    add('BLOCK', 'http-error',
      `최종 응답이 ${final.status} 입니다. 색인 대상이 되지 않습니다.`, 'seo-basic-http',
      '2xx를 반환하도록 수정하세요.');
  }

  // 2) 로봇 수집 차단 HTTP 헤더
  const xr = final.headers.get('x-robots-tag');
  if (xr) {
    const bad = /noindex|none/i.test(xr);
    add(bad ? 'BLOCK' : 'INFO', 'x-robots-tag',
      `X-Robots-Tag 헤더: "${xr}"${bad ? ' — 색인이 차단됩니다.' : ''}`, 'faq-serpmissing',
      bad ? '색인이 필요한 페이지라면 헤더를 제거하세요. HTML만 봐서는 놓치기 쉬운 원인입니다.' : undefined);
  }

  // 3) robots.txt
  const robotsUrl = origin + '/robots.txt';
  let robots = null;
  let robotsRaw = '';
  try {
    const r = await get(robotsUrl, { redirect: 'follow' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const body = await r.text();

    if (r.status >= 500) {
      add('BLOCK', 'robots-5xx',
        `robots.txt가 ${r.status}를 반환합니다. 네이버는 5xx를 "모두 허용하지 않음"으로 해석합니다.`,
        'seo-basic-robots', '서버 오류를 해결하세요. 이 상태로는 사이트 전체가 수집 차단됩니다.');
    } else if (r.status >= 400) {
      add('INFO', 'robots-4xx',
        `robots.txt가 ${r.status} 입니다. 4xx는 "모두 허용"으로 해석되므로 수집 자체는 막히지 않습니다.`,
        'seo-basic-robots', 'sitemap 지정 등을 위해 robots.txt를 두는 편이 좋습니다.');
    } else {
      if (!ct.includes('text/plain')) {
        add('INDEX', 'robots-content-type',
          `robots.txt의 Content-Type이 "${ct || '없음'}" 입니다. text/plain이 아니면 규칙이 있어도 "없음(모두 허용)"으로 해석될 수 있습니다.`,
          'seo-basic-robots', 'text/plain으로 서빙하세요.');
      }
      if (/^\s*</.test(body)) {
        add('INDEX', 'robots-html',
          'robots.txt 응답이 HTML로 보입니다. 규칙이 무시될 수 있습니다.',
          'seo-basic-robots', '일반 텍스트 파일로 교체하세요.');
      }

      robots = parseRobots(body);
      robotsRaw = body;

      // 지시자 이름과 콜론 사이의 공백은 RFC 9309 문법상 허용되지만,
      // 엄격한 파서는 그 줄을 통째로 버린다. Yeti 전용 그룹이 이런 형태면
      // 사이트 전체 수집 정책이 파서 관용도에 걸린 셈이라 반드시 알려야 한다.
      const loose = body.split(/\r?\n/).filter((l) => /^\s*user-agent\s+:/i.test(l));
      if (loose.length)
        add('INDEX', 'robots-loose-syntax',
          `robots.txt에 지시자와 콜론 사이가 벌어진 줄이 ${loose.length}개 있습니다: ${loose.map((l) => `"${l.trim()}"`).join(', ')}`,
          'seo-basic-robots',
          '표준 문법상 허용되지만 엄격한 파서는 이 줄을 무시합니다. 공백을 제거해 "User-agent: Yeti" 형태로 맞추세요.');

      const yeti = robotsVerdict(robots, 'yeti', url.pathname + url.search);
      if (!yeti.allowed) {
        add('BLOCK', 'robots-disallow',
          `robots.txt가 Yeti의 이 경로 수집을 차단합니다 (${yeti.reason}).`,
          'seo-basic-robots', '색인이 필요한 경로라면 Allow로 바꾸세요.');
      } else {
        add('INFO', 'robots-allow', `robots.txt 기준 Yeti 수집 허용 (${yeti.reason}).`, 'seo-basic-robots');
      }

      const hasYetiGroup = robots.groups.some((g) => g.agents.includes('yeti'));
      const starBlocked = robotsVerdict(robots, 'some-other-bot', url.pathname + url.search);
      if (!starBlocked.allowed && !hasYetiGroup) {
        add('BLOCK', 'robots-star-block',
          '와일드카드(*) 그룹이 수집을 차단하는데 Yeti 전용 그룹이 없습니다. 네이버도 함께 차단됩니다.',
          'seo-basic-robots', 'User-agent: Yeti / Allow: / 그룹을 추가하세요.');
      }

      if (!robots.sitemaps.length) {
        add('SERP', 'robots-no-sitemap',
          'robots.txt에 Sitemap 지정이 없습니다.', 'seo-basic-robots',
          'Sitemap: https://example.com/sitemap.xml 한 줄을 추가하세요.');
      } else {
        add('INFO', 'robots-sitemap', `Sitemap 지정됨: ${robots.sitemaps.join(', ')}`, 'request-feed');
      }
    }
  } catch (e) {
    add('INFO', 'robots-fetch-fail', `robots.txt를 가져오지 못했습니다: ${e.message}`, 'seo-basic-robots');
  }

  // 4) HTML 분석
  const ctype = (final.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('html')) {
    add('INFO', 'not-html', `Content-Type이 "${ctype}" 이라 HTML 점검을 건너뜁니다.`, 'seo-basic-http');
    return { url: finalUrl, chain, findings };
  }
  const html = await final.text();
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const metas = tags(head, 'meta');
  const links = tags(head, 'link');

  // title
  const title = textOf(head, 'title');
  if (!title) {
    add('SERP', 'no-title', '<title> 태그가 없습니다.', 'markup-content', '페이지 주제를 설명하는 고유한 제목을 넣으세요.');
  } else {
    add('INFO', 'title', `제목: "${title}" (${title.length}자)`, 'markup-content');
    const words = title.toLowerCase().match(/[가-힣a-z0-9]+/g) || [];
    const dup = [...new Set(words.filter((w) => w.length > 1 && words.filter((x) => x === w).length >= 2))];
    if (dup.length)
      add('INDEX', 'title-keyword-repeat',
        `제목에 반복되는 키워드가 있습니다: ${dup.join(', ')}. 2회 이상 반복은 어뷰징 의심 대상입니다.`,
        'markup-content', '자연스러운 한 문장으로 다듬으세요.');
  }

  // description
  const desc = metaBy(metas, 'name', 'description')[0];
  if (!desc) {
    add('SERP', 'no-description', '<meta name="description">이 없습니다.', 'markup-content',
      '1~2문장으로 페이지 내용을 요약하세요.');
  } else {
    if (desc.trim() === (title || '').trim())
      add('INDEX', 'description-eq-title', 'description이 title과 동일합니다.', 'markup-content',
        '제목과 다른, 내용을 요약하는 문장을 쓰세요.');
    else add('INFO', 'description', `설명문: ${desc.length}자`, 'markup-content');
  }

  // canonical
  const canonical = links.find((l) => (l.rel || '').toLowerCase() === 'canonical')?.href;
  if (!canonical) {
    add('INDEX', 'no-canonical', 'canonical(선호 URL)이 지정되지 않았습니다.', 'markup-structure',
      '동일 콘텐츠가 여러 URL로 접근 가능하면 중복으로 처리될 수 있습니다. 절대 경로로 지정하세요.');
  } else if (!/^https?:\/\//i.test(canonical)) {
    add('INDEX', 'canonical-relative',
      `canonical이 상대 경로입니다: "${canonical}". 가이드는 절대 경로를 요구합니다.`,
      'markup-structure', `<link rel="canonical" href="${new URL(canonical, finalUrl).href}">`);
  } else {
    add('INFO', 'canonical', `canonical: ${canonical}`, 'markup-structure');
    if (new URL(canonical).href !== new URL(finalUrl).href)
      add('INFO', 'canonical-differs',
        `canonical이 현재 URL과 다릅니다. 이 페이지는 ${canonical} 의 사본으로 처리됩니다.`, 'markup-structure');
  }

  // robots meta
  const robotsMeta = metaBy(metas, 'name', 'robots').join(', ');
  if (robotsMeta) {
    if (/noindex/i.test(robotsMeta))
      add('BLOCK', 'meta-noindex', `로봇 메타 태그에 noindex가 있습니다: "${robotsMeta}"`, 'markup-structure',
        '검색 노출이 필요한 페이지라면 index,follow로 바꾸세요.');
    else add('INFO', 'meta-robots', `로봇 메타 태그: "${robotsMeta}"`, 'markup-structure');
    if (/nosourceinfo/i.test(robotsMeta))
      add('INFO', 'nosourceinfo', 'nosourceinfo 설정됨 — AI 자동생성 출처설명이 제공되지 않습니다.', 'markup-structure');
  }

  // 오픈그래프
  const og = {};
  for (const t of metas)
    if ((t.property || '').startsWith('og:')) og[t.property.slice(3)] = t.content ?? '';

  for (const k of ['title', 'description', 'image', 'url', 'type']) {
    if (!og[k])
      add('SERP', `no-og-${k}`, `og:${k} 가 없습니다.`, 'markup-content',
        '네이버 검색로봇도 오픈그래프를 페이지 분석·노출에 활용합니다.');
  }

  if (og.image) {
    try {
      const imgUrl = new URL(og.image, finalUrl).href;
      // 헤더 판독에는 앞부분이면 충분하다. Range로 받아 대역폭을 아낀다.
      const ir = await fetchRange(imgUrl);
      if (!ir.ok) {
        add('SERP', 'og-image-unreachable', `og:image를 가져올 수 없습니다 (${ir.status}): ${imgUrl}`,
          'markup-content', '접근 가능한 절대 URL로 지정하세요.');
      } else {
        const { buf, bytes } = ir;
        const size = imageSize(buf);
        if (bytes < 5000)
          add('SERP', 'og-image-small-bytes',
            `og:image 파일 크기가 ${bytes} byte 입니다. 가이드 기준은 5,000 byte 이상입니다.`,
            'markup-content', '더 큰 대표 이미지를 사용하세요.');
        if (size) {
          const { w, h } = size;
          const ratio = Math.max(w, h) / Math.min(w, h);
          const parts = [`${w}×${h}`, `${bytes.toLocaleString()} byte`, `비율 ${ratio.toFixed(2)}:1`];
          if (w <= 150 || h <= 150)
            add('SERP', 'og-image-small-dim',
              `og:image가 ${w}×${h} 입니다. 가이드 기준은 150×150 초과입니다.`, 'markup-content',
              '더 큰 이미지를 사용하세요.');
          if (ratio > 3)
            add('SERP', 'og-image-ratio',
              `og:image 비율이 ${ratio.toFixed(2)}:1 입니다. 가이드 기준은 3:1 이내입니다.`, 'markup-content',
              '가로세로 비율을 3:1 안으로 맞추세요.');
          if (w > 150 && h > 150 && ratio <= 3 && bytes >= 5000)
            add('INFO', 'og-image-ok', `og:image 규격 통과 — ${parts.join(', ')}`, 'markup-content');
        } else {
          add('INFO', 'og-image-unknown-format',
            `og:image 크기를 판독하지 못했습니다 (${bytes.toLocaleString()} byte). 150×150 초과·3:1 이내인지 직접 확인하세요.`,
            'markup-content');
        }
      }
    } catch (e) {
      add('SERP', 'og-image-error', `og:image 확인 실패: ${e.message}`, 'markup-content');
    }
  }

  // viewport
  const viewport = metaBy(metas, 'name', 'viewport')[0];
  if (!viewport)
    add('SERP', 'no-viewport', '<meta name="viewport">가 없습니다. 모바일 사용성에 불리합니다.', 'markup-mobile',
      '<meta name="viewport" content="width=device-width, initial-scale=1">');
  else add('INFO', 'viewport', `viewport: ${viewport}`, 'markup-mobile');

  // 파비콘
  const favicon = links.find((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.rel || ''));
  if (!favicon)
    add('SERP', 'no-favicon', 'HTML에 파비콘 link 태그가 없습니다.', 'markup-favicon',
      '/favicon.ico 가 있으면 인식될 수 있지만, link 태그로 명시하는 편이 확실합니다. 파비콘 경로가 robots.txt로 차단되지 않았는지도 확인하세요.');
  else add('INFO', 'favicon', `파비콘: ${favicon.href}`, 'markup-favicon');

  // lang
  const lang = /<html[^>]*\blang\s*=\s*["']?([\w-]+)/i.exec(html)?.[1];
  if (!lang) add('SERP', 'no-lang', '<html> 태그에 lang 속성이 없습니다.', 'markup-structure');

  // 구조화된 데이터
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const micro = /itemscope/i.test(html);
  if (!ld.length && !micro) {
    add('INFO', 'no-structured-data',
      '구조화된 데이터(JSON-LD / Microdata)가 없습니다.', 'structured-data-intro',
      '콘텐츠 성격에 맞는 타입이 있다면 추가를 검토하세요. 단, 마크업해도 노출이 보장되지는 않습니다.');
  } else {
    const types = [];
    for (const [, body] of ld) {
      try {
        const j = JSON.parse(body.trim());
        for (const n of Array.isArray(j) ? j : [j]) {
          const t = n['@type'];
          if (t) types.push(...(Array.isArray(t) ? t : [t]));
        }
      } catch {
        add('INDEX', 'ld-json-invalid', 'JSON-LD 블록의 JSON 파싱에 실패했습니다.', 'structured-data-intro',
          'https://validator.schema.org/ 로 검증하세요.');
      }
    }
    add('INFO', 'structured-data',
      `구조화된 데이터 발견 — ${ld.length}개 JSON-LD 블록${micro ? ' + Microdata' : ''}${types.length ? `, 타입: ${[...new Set(types)].join(', ')}` : ''}`,
      'structured-data-intro');
  }

  // JS 렌더링 의존 여부
  const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? '';
  const visible = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (visible.length < 200) {
    add('INDEX', 'js-rendered',
      `HTML 원문의 본문 텍스트가 ${visible.length}자뿐입니다. 클라이언트 렌더링(SPA)일 가능성이 높습니다.`,
      'seo-advanced-javascript',
      'SSR/프리렌더링을 검토하세요. 서치어드바이저 [URL 검사]로 로봇이 실제 수집하는 HTML을 확인할 수 있습니다.');
  }

  // 이미지 alt — 속성 누락과 alt="" 는 다른 이야기다.
  // alt="" 는 장식용 이미지를 표시하는 올바른 방법이므로 결함으로 세지 않는다.
  const imgs = tags(html, 'img');
  const missingAlt = imgs.filter((i) => i.alt === undefined).length;
  const emptyAlt = imgs.filter((i) => i.alt !== undefined && i.alt.trim() === '').length;
  if (missingAlt)
    add('SERP', 'img-no-alt',
      `이미지 ${imgs.length}개 중 ${missingAlt}개에 alt 속성이 아예 없습니다.`, 'content-basic',
      '검색로봇은 이미지 속 텍스트를 인식하기 어렵습니다. 내용이 있는 이미지에는 alt를 넣고, 장식용이면 alt=""로 명시하세요.');
  if (emptyAlt)
    add('INFO', 'img-empty-alt',
      `이미지 ${imgs.length}개 중 ${emptyAlt}개가 alt=""(장식용 표시)입니다. 이 중 실제로 정보를 담은 이미지가 있는지 확인하세요.`,
      'content-basic');

  // ── 페이지 구성 리소스가 robots.txt로 차단되는지 ────────────────────
  // 페이지 자체는 허용인데 CSS/JS가 막히면 로봇이 문서를 제대로 해석하지 못한다.
  // 가이드가 명시적으로 경고하는 항목이고, 페이지 경로만 봐서는 절대 안 잡힌다.
  const resources = { CSS: [], JS: [], 이미지: [], 기타: [] };
  for (const l of links)
    if (/(^|\s)stylesheet(\s|$)/i.test(l.rel || '') && l.href) resources.CSS.push(l.href);
  for (const s of tags(html, 'script')) if (s.src) resources.JS.push(s.src);
  for (const i of imgs) if (i.src) resources['이미지'].push(i.src);
  if (og.image) resources['기타'].push(og.image);
  if (favicon?.href) resources['기타'].push(favicon.href);

  const resolve = (r) => { try { return new URL(r, finalUrl); } catch { return null; } };

  if (robots) {
    /** agent 기준으로 리소스 차단 현황을 센다. */
    const scan = (agent) => {
      const out = {};
      let same = 0, blocked = 0;
      for (const [kind, list] of Object.entries(resources)) {
        const urls = [...new Set(list)].map(resolve).filter((u) => u && u.origin === origin);
        const bad = urls.filter((u) => !robotsVerdict(robots, agent, u.pathname + u.search).allowed);
        same += urls.length;
        blocked += bad.length;
        if (bad.length)
          out[kind] = { n: bad.length, of: urls.length,
            rules: [...new Set(bad.map((u) => robotsVerdict(robots, agent, u.pathname + u.search).reason))] };
      }
      return { out, same, blocked };
    };

    const describe = (r) =>
      Object.entries(r.out).map(([k, v]) => `${k} ${v.n}/${v.of}`).join(', ');
    const rulesOf = (r) => [...new Set(Object.values(r.out).flatMap((v) => v.rules))].join(' / ');

    const asYeti = scan('yeti');
    const asStar = scan('*');
    const hasYetiGroupNow = robots.groups.some((g) => g.agents.includes('yeti'));

    if (asYeti.blocked) {
      const breaks = asYeti.out.CSS || asYeti.out.JS;
      add(breaks ? 'BLOCK' : 'INDEX', 'resource-blocked',
        `페이지는 수집 허용이지만 구성 리소스가 robots.txt로 차단됩니다 — ${describe(asYeti)}. 적용된 규칙: ${rulesOf(asYeti)}`,
        'resource-and-link',
        breaks
          ? 'CSS/JS가 막히면 로봇이 문서를 온전히 해석하지 못해 미노출·오노출로 이어질 수 있습니다. 해당 경로를 Allow로 바꾸거나 Yeti 전용 예외를 추가하세요.'
          : '문서와 동일한 규칙을 적용하거나 기본 허용으로 바꾸세요.');
    } else if (hasYetiGroupNow && asStar.blocked) {
      // Yeti 전용 그룹 덕분에만 리소스가 열려 있는 상태.
      // 그 그룹이 한 줄이라도 어긋나면 곧바로 아래 수치만큼 막힌다.
      add('INDEX', 'resource-depends-on-yeti-group',
        `리소스 수집이 Yeti 전용 그룹 하나에만 의존합니다. 그 그룹이 무시되면 와일드카드(*) 규칙이 적용되어 ${describe(asStar)}가 차단됩니다 (${rulesOf(asStar)}).`,
        'resource-and-link',
        'Yeti 그룹 문법을 정확히 유지하거나, 애초에 * 그룹에서 리소스 경로를 Disallow하지 않는 편이 안전합니다.');
    } else if (asYeti.same) {
      add('INFO', 'resource-ok', `동일 호스트 리소스 ${asYeti.same}개 모두 수집 허용.`, 'resource-and-link');
    }
  }

  // ── apex ↔ www 반대편 호스트의 robots.txt ───────────────────────────
  // robots 규칙은 호스트별로만 유효하다. 한쪽이 전면 차단이면 그쪽 URL은 통째로 죽는다.
  const otherHost = url.hostname.startsWith('www.')
    ? url.hostname.slice(4)
    : 'www.' + url.hostname;
  try {
    const or = await get(`${url.protocol}//${otherHost}/robots.txt`, { redirect: 'follow' });
    if (or.ok) {
      const op = parseRobots(await or.text());
      const ov = robotsVerdict(op, 'yeti', '/');
      if (!ov.allowed)
        add('INDEX', 'other-host-blocked',
          `반대편 호스트 ${otherHost} 의 robots.txt가 Yeti를 전면 차단합니다 (${ov.reason}).`,
          'seo-basic-robots',
          `robots.txt 규칙은 호스트별로만 유효하므로 ${url.hostname} 의 설정이 이쪽을 구제하지 못합니다. ${otherHost} 를 ${url.hostname} 로 301 리다이렉트하거나 robots.txt를 맞추세요.`);
    }
  } catch { /* 반대편 호스트가 없을 수 있다 — 정상 */ }

  // ── 크롤 불가능한 링크 / 프로토콜 혼용 ──────────────────────────────
  const anchors = tags(html, 'a');
  const badHref = anchors.filter((a) => {
    const h = (a.href || '').trim();
    if (!h) return false;
    return /^javascript:/i.test(h) || /^[a-zA-Z_$][\w$]*\s*\(/.test(h);
  });
  if (badHref.length)
    add('INDEX', 'uncrawlable-links',
      `<a href>가 URL이 아닌 자바스크립트 호출인 링크가 ${badHref.length}개 있습니다 (예: ${badHref[0].href.slice(0, 50)}).`,
      'resource-and-link',
      '로봇은 href의 URL로 다른 페이지를 발견합니다. 실제 URL을 넣으면 사이트 수집량이 늘어납니다.');

  if (url.protocol === 'https:') {
    const mixed = Object.values(resources).flat()
      .map(resolve)
      .filter((u) => u && u.protocol === 'http:' && u.hostname === url.hostname);
    if (mixed.length)
      add('INDEX', 'mixed-protocol',
        `HTTPS 페이지인데 동일 호스트를 http:// 로 참조하는 리소스가 ${mixed.length}개 있습니다.`,
        'resource-and-link', '리소스 URL을 페이지와 동일한 https:// 로 맞추세요.');
  }

  // 5) 클로킹 점검 — 브라우저 UA와 응답 비교
  try {
    const b = await follow(url.href, BROWSER_UA);
    if (b.final) {
      if (b.final.status !== final.status) {
        add('BLOCK', 'ua-status-differs',
          `Yeti UA는 ${final.status}, 일반 브라우저 UA는 ${b.final.status}를 받습니다. 방화벽이 검색로봇을 차단하고 있을 수 있습니다.`,
          'seo-basic-firewall', '방화벽/WAF에서 Yeti UA와 네이버 IP 대역을 허용하세요.');
      } else if (ctype.includes('html')) {
        const bt = (await b.final.text()).length;
        const diff = Math.abs(bt - html.length) / Math.max(bt, html.length, 1);
        if (diff > 0.3)
          add('INDEX', 'ua-content-differs',
            `Yeti UA와 브라우저 UA의 응답 크기가 ${(diff * 100).toFixed(0)}% 다릅니다 (${html.length} vs ${bt} byte).`,
            'content-abusing',
            '의도한 것이 아니라면 확인하세요. 검색엔진과 사용자에게 다른 내용을 주는 것은 클로킹으로 분류될 수 있습니다.');
      }
    } else {
      add('INFO', 'ua-browser-fail', '브라우저 UA 비교 요청이 실패해 클로킹 점검을 건너뜁니다.', 'seo-basic-firewall');
    }
  } catch {
    /* 비교 실패는 치명적이지 않다 */
  }

  return { url: finalUrl, chain, findings };
}

// ── 출력 ─────────────────────────────────────────────────────────────────
const ICON = { BLOCK: '🔴', INDEX: '🟠', SERP: '🟡', INFO: '🔵' };
const LABEL = {
  BLOCK: '수집·색인 차단',
  INDEX: '색인 품질',
  SERP: '검색결과 표현',
  INFO: '참고',
};

function report(result) {
  const { url, chain, findings } = result;
  const out = [];
  out.push(`\n네이버 SEO 점검 — ${url}`);
  out.push('근거: 네이버 서치어드바이저 웹마스터 가이드 (references/INDEX.md (official URLs))');

  if (chain.length > 1)
    out.push(`\n리다이렉트 체인: ${chain.map((c) => `${c.status ?? 'ERR'}`).join(' → ')}`);

  const sorted = [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  let last = null;
  for (const f of sorted) {
    if (f.level !== last) {
      out.push(`\n${ICON[f.level]} ${LABEL[f.level]}`);
      last = f.level;
    }
    out.push(`  · ${f.message}  [${f.guid}]`);
    if (f.fix) out.push(`    → ${f.fix}`);
  }

  const n = (lv) => findings.filter((f) => f.level === lv).length;
  out.push(
    `\n요약: 차단 ${n('BLOCK')} / 색인 ${n('INDEX')} / 표현 ${n('SERP')} / 참고 ${n('INFO')}`
  );
  out.push(
    '\n이 스크립트로 판정할 수 없는 것: 콘텐츠 품질, 주제 일관성, 스팸 소지, 실제 순위.'
  );
  out.push('   → official Naver guide URLs (see references/INDEX.md) 기준으로 검토하세요.');
  out.push('   → 서치어드바이저 [사이트 간단 체크]·[URL 검사]로 교차검증하세요.\n');
  return out.join('\n');
}

/** Optbrew path: inspect only responses already collected and preserved by the bounded collector. */
export function auditCollected({ artifact, html, robotsArtifact = null }) {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const title = textOf(head, 'title');
  const metas = tags(head, 'meta');
  const robotsMeta = metaBy(metas, 'name', 'robots').join(', ');
  const jsonld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  let parsedRobots = null;
  let yetiVerdict = null;
  const findings = [];
  if (robotsArtifact?.status === 200 && typeof robotsArtifact.body === 'string') {
    parsedRobots = parseRobots(robotsArtifact.body);
    const url = new URL(artifact.final_url);
    yetiVerdict = robotsVerdict(parsedRobots, 'yeti', url.pathname + url.search);
    if (!yetiVerdict.allowed) findings.push({ code: 'robots-disallow', message: `Yeti path blocked: ${url.pathname}${url.search}` });
    const resources = [...tags(html, 'link').filter(x => /stylesheet/i.test(x.rel ?? '')).map(x => x.href),
      ...tags(html, 'script').map(x => x.src), ...tags(html, 'img').map(x => x.src)].filter(Boolean);
    for (const resource of resources) {
      const target = new URL(resource, artifact.final_url);
      if (target.origin !== url.origin) continue;
      if (!robotsVerdict(parsedRobots, 'yeti', target.pathname + target.search).allowed)
        findings.push({ code: 'resource-blocked', message: `Yeti resource blocked: ${target.pathname}${target.search}` });
    }
  }
  return {
    url: artifact.final_url, status: artifact.status, title,
    x_robots_tag: artifact.headers['x-robots-tag'] ?? null, robots_meta: robotsMeta || null,
    jsonld_blocks: jsonld.length, jsonld_parse_errors: jsonld.filter(([, body]) => { try { JSON.parse(body); return false; } catch { return true; } }).length,
    robots: parsedRobots ? { yeti_allowed: yetiVerdict.allowed, reason: yetiVerdict.reason, sitemaps: parsedRobots.sitemaps } : null,
    findings,
    limitations: ['Yeti User-Agent supplied to this collector is not proof of a Naver bot visit.',
      'Metadata observations do not prove indexing, ranking, or structured-data truth.'],
  };
}

// ── 엔트리 ───────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!target) {
  console.error('사용법: node skills/optbrew/scripts/audit.mjs --context <run-context.json> --modules naver-searchadvisor --output-dir <run-dir>');
  process.exit(2);
}

console.error('직접 원격 감사가 비활성화되었습니다. optbrew audit의 scope context와 수집 증거를 사용하세요.');
process.exit(2);

try {
  const result = await audit(target.includes('://') ? target : `https://${target}`);
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(report(result));
  process.exit(result.findings.some((f) => f.level === 'BLOCK') ? 1 : 0);
} catch (e) {
  console.error(`점검 실패: ${e.message}`);
  process.exit(2);
}
}
