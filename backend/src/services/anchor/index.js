// ─── Stella Protocol — Barrel Export for Anchor Service ───────

export { getSeeds, getSeedDomainSet } from './seeds.js';
export { fetchStellarToml } from './tomlFetcher.js';
export { parseStellarToml } from './tomlParser.js';
export { validateAnchorOnChain, validateIssuers, validateAssets } from './horizonValidator.js';
export {
  upsertAnchor, getAnchorByDomain, getAnchorById, getAnchors,
  getAnchorStats, getAnchorAssets, getAllVerifiedAssets,
  logCrawl, getCrawlHistory,
} from './anchorRepository.js';
export {
  computeCompletenessScore, computeHealthScore,
  deriveHealthStatus, isRoutingVisible, THRESHOLDS,
} from './anchorHealth.js';
export { crawlAnchor, crawlSeeds, refreshStaleAnchors } from './anchorIndexer.js';
export { startCrawlScheduler, stopCrawlScheduler, triggerManualRefresh } from './crawlScheduler.js';
