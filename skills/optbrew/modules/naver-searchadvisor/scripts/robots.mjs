/** Parse a robots.txt file without fetching it. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let hasRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (field === 'user-agent') {
      if (!value) continue;
      if (!current || hasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      hasRule = true;
      // RFC 9309: an empty rule does not restrict access.
      if (value) current.rules.push({ type: field, path: value });
    }
  }
  return { groups, sitemaps };
}

const unreserved = /^[A-Za-z0-9._~-]$/;
const hex = n => `%${n.toString(16).padStart(2, '0').toUpperCase()}`;

// Compare normalized octets. Keep encoded reserved octets distinct from raw delimiters.
function normalize(value) {
  let result = '';
  for (let i = 0; i < value.length;) {
    if (value[i] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      const byte = parseInt(value.slice(i + 1, i + 3), 16);
      const character = String.fromCharCode(byte);
      result += unreserved.test(character) ? character : hex(byte);
      i += 3;
    } else {
      const point = value.codePointAt(i);
      const character = String.fromCodePoint(point);
      result += point > 127 ? [...Buffer.from(character)].map(hex).join('') : character;
      i += character.length;
    }
  }
  return result;
}

function matchRule(rule, path) {
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const pattern = '^' + body.split('*').map(part => normalize(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '');
  return new RegExp(pattern).test(path);
}

/** RFC 9309: merge all groups matching the crawler product token. */
export function robotsVerdict(parsed, agent, path) {
  if (normalize(path).split('?', 1)[0] === '/robots.txt') return { allowed: true, reason: 'robots.txt는 암묵적으로 허용', matched_rules: [] };
  const userAgent = agent.toLowerCase();
  let groups = parsed.groups.filter(group => group.agents.some(name => name !== '*' && userAgent.includes(name)));
  if (!groups.length) groups = parsed.groups.filter(group => group.agents.includes('*'));
  if (!groups.length) return { allowed: true, reason: '해당 로봇에 적용되는 그룹 없음', matched_rules: [] };

  const normalizedPath = normalize(path);
  const matches = groups.flatMap(group => group.rules).filter(rule => matchRule(rule.path, normalizedPath));
  if (!matches.length) return { allowed: true, reason: '일치하는 규칙 없음', matched_rules: [] };
  const octets = rule => normalize(rule.path.replace(/\$$/, '').replaceAll('*', '')).replace(/%[0-9A-F]{2}/g, '_').length;
  const max = Math.max(...matches.map(octets));
  const matched_rules = matches.filter(rule => octets(rule) === max);
  const winner = matched_rules.find(rule => rule.type === 'allow') ?? matched_rules[0];
  return { allowed: winner.type === 'allow', reason: `${winner.type === 'allow' ? 'Allow' : 'Disallow'}: ${winner.path}`, matched_rules };
}
