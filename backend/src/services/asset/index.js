// ─── Stella Protocol — Asset Service Barrel Export ─────────────

export { discoverAssetsFromHorizon, discoverAssetByCode, getNativeXlm } from './assetDiscovery.js';
export {
  upsertAsset, batchUpsertAssets,
  getAssets, countAssets, getAssetByIdentifier,
  getAssetCodes, getAssetStats, getRoutableAssets,
} from './assetRepository.js';
export { syncAssetRegistry } from './assetSync.js';
