/** A valid EnvironmentProbe for test RunContexts; `over` replaces top-level fields. */
export const environmentProbe = over => ({ harness: 'other', transport: 'direct', address_vetting: 'direct', proxy: null, block_reason: null,
  chrome: { found: true, kind: 'chrome', reason: null }, google_key: false, source_tools: [], sitemap_pages: null, ...over });
