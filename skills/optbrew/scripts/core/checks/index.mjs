import { fetchResponse } from './fetch-response.mjs';
import { searchCrawlPolicy } from './search-crawl-policy.mjs';
import { indexPolicy } from './index-policy.mjs';
import { renderContent } from './render-content.mjs';
import { discovery } from './discovery.mjs';
import { documentTitle } from './document-title.mjs';
import { canonicalConsistency } from './canonical-consistency.mjs';
import { internalNavigation } from './internal-navigation.mjs';
import { structuredDataTruth } from './structured-data-truth.mjs';
import { localeLinks } from './locale-links.mjs';
import { naverMarkup } from './naver-markup.mjs';
import { entityIdentity } from './entity-identity.mjs';
import { factConsistency } from './fact-consistency.mjs';

/** The one registration list: every check block, in the order of check-registry.json. A block is `{ family_id, derive(prepared) }`. */
export const blocks = [fetchResponse, searchCrawlPolicy, indexPolicy, renderContent, discovery, documentTitle, canonicalConsistency,
  internalNavigation, structuredDataTruth, localeLinks, naverMarkup, entityIdentity, factConsistency];
