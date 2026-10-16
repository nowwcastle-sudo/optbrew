import { messageOf } from './messages.mjs';

/** Match actual evidence surfaces to requested checks without inventing missing capability. */
export function selectCapabilities(available, requirements) {
  const selected = []; const missing = []; const limitations = []; const limitation_messages = [];
  // Each limitation keeps its English text and, at the same position, the catalog key and values of its Korean sentence.
  const limit = (text, message) => { limitations.push(text); limitation_messages.push(message); };
  for (const requirement of requirements) {
    const names = requirement === 'structured_data' ? ['raw_html'] : [requirement];
    const candidate = available.find(item => names.includes(item.capability) && item.bounded === true &&
      ['code', 'host_policy', 'none'].includes(item.cost_enforcement));
    if (!candidate || (requirement === 'bulk_crawl' && candidate.cost_enforcement !== 'code')) {
      missing.push(requirement);
      if (requirement === 'bulk_crawl' && available.some(item => item.capability === 'bulk_crawl'))
        limit('bulk_crawl: boundary or cost enforcement is host_policy/unverified', messageOf('cost.bulk-crawl-unverified'));
      continue;
    }
    selected.push({ capability: candidate.capability, provider: candidate.provider, tool_ref: candidate.tool_ref,
      cost_enforcement: candidate.cost_enforcement });
    if (candidate.cost_enforcement === 'host_policy') limit(`${candidate.provider}: host_policy cannot enforce paid cost in code`, messageOf('cost.host-policy', { provider: candidate.provider }));
  }
  return { selected, missing, limitations, limitation_messages };
}
