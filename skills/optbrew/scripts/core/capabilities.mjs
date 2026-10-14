/** Match actual evidence surfaces to requested checks without inventing missing capability. */
export function selectCapabilities(available, requirements) {
  const selected = []; const missing = []; const limitations = [];
  for (const requirement of requirements) {
    const names = requirement === 'structured_data' ? ['raw_html'] : [requirement];
    const candidate = available.find(item => names.includes(item.capability) && item.bounded === true &&
      ['code', 'host_policy', 'none'].includes(item.cost_enforcement));
    if (!candidate || (requirement === 'bulk_crawl' && candidate.cost_enforcement !== 'code')) {
      missing.push(requirement);
      if (requirement === 'bulk_crawl' && available.some(item => item.capability === 'bulk_crawl'))
        limitations.push('bulk_crawl: boundary or cost enforcement is host_policy/unverified');
      continue;
    }
    selected.push({ capability: candidate.capability, provider: candidate.provider, tool_ref: candidate.tool_ref,
      cost_enforcement: candidate.cost_enforcement });
    if (candidate.cost_enforcement === 'host_policy') limitations.push(`${candidate.provider}: host_policy cannot enforce paid cost in code`);
  }
  return { selected, missing, limitations };
}
