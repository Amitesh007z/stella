// ─── Stella Protocol — Asset Sync Service ─────────────────────
// Orchestrates the merge of two asset sources into the global registry:
//   1. Horizon-discovered assets (network-native)
//   2. Anchor-crawled assets (Phase 2 Capability Index)
//
// The result is a unified, deduplicated, enriched Asset Registry
// that serves as the single source of truth for Phase 4 (Route Graph).

import { discoverAssetsFromHorizon, getNativeXlm } from './assetDiscovery.js';
import { batchUpsertAssets, getAssetStats } from './assetRepository.js';
import { getAllVerifiedAssets } from '../anchor/anchorRepository.js';
import { getAnchors } from '../anchor/anchorRepository.js';
import { getDb } from '../../db/index.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('asset-sync');

/**
 * Run a full asset sync: discover from Horizon + merge anchor assets.
 * This is the main entry point called by the boot sequence and refresh loop.
 *
 * @param {object} options
 * @param {number} options.minAccounts - Min trustlines for Horizon discovery
 * @param {number} options.maxPages - Max Horizon pages to scan
 * @returns {Promise<SyncResult>}
 */
export async function syncAssetRegistry({ minAccounts = 1, maxPages = 10 } = {}) {
  const startTime = Date.now();

  log.info('═══ Starting Asset Registry Sync ═══');

  // ─────────────────────────────────────────────────────
  // STEP 1: Always include native XLM
  // ─────────────────────────────────────────────────────
  const nativeXlm = {
    ...getNativeXlm(),
    source: 'horizon',
    isVerified: true,
    name: 'Stellar Lumens',
    description: 'Native Stellar network token',
    domain: 'stellar.org',
    displayDecimals: 7,
  };

  // ─────────────────────────────────────────────────────
  // STEP 2: Discover assets from Horizon
  // ─────────────────────────────────────────────────────
  log.info('Step 1/3: Discovering assets from Horizon...');
  const horizonResult = await discoverAssetsFromHorizon({ minAccounts, maxPages });

  const horizonAssets = horizonResult.assets.map((a) => ({
    code: a.code,
    issuer: a.issuer,
    assetType: a.assetType,
    numAccounts: a.numAccounts,
    amount: a.amount,
    source: 'horizon',
    isVerified: true,  // On-chain existence is proof
    // Extract domain from toml link if available
    domain: a.tomlUrl ? extractDomainFromToml(a.tomlUrl) : null,
  }));

  log.info({ count: horizonAssets.length }, 'Horizon assets discovered');

  // ─────────────────────────────────────────────────────
  // STEP 3: Merge anchor-sourced assets
  // ─────────────────────────────────────────────────────
  log.info('Step 2/3: Merging anchor-crawled assets...');
  const anchorAssets = getAllVerifiedAssets();
  const anchorMapped = anchorAssets.map((a) => ({
    code: a.code,
    issuer: a.issuer,
    assetType: a.asset_type,
    numAccounts: a.num_accounts,
    amount: a.amount_circulating,
    source: 'anchor',
    isVerified: !!a.is_on_chain,
    domain: a.anchor_domain,
    anchorDomain: a.anchor_domain,
    name: a.anchor_display_name,
    description: a.description,
    isDepositEnabled: !!a.is_deposit_enabled,
    isWithdrawEnabled: !!a.is_withdraw_enabled,
    sep38Supported: !!a.sep38_supported,
    isAnchorAsset: !!a.is_asset_anchored,
    anchorAssetType: a.anchor_asset_type,
    displayDecimals: a.display_decimals,
  }));

  // Also import ALL anchor_assets (even unverified on-chain)
  // so the registry has complete anchor coverage
  const allAnchorAssets = getAllAnchorAssetsForRegistry();
  const allAnchorMapped = allAnchorAssets.map((a) => ({
    code: a.code,
    issuer: a.issuer,
    assetType: a.asset_type,
    numAccounts: a.num_accounts,
    amount: a.amount_circulating,
    source: 'anchor',
    isVerified: !!a.is_on_chain,
    domain: a.anchor_domain,
    anchorDomain: a.anchor_domain,
    name: a.anchor_display_name || a.anchor_name,
    description: a.description,
    isDepositEnabled: !!a.is_deposit_enabled,
    isWithdrawEnabled: !!a.is_withdraw_enabled,
    sep38Supported: !!a.sep38_supported,
    isAnchorAsset: !!a.is_asset_anchored,
    anchorAssetType: a.anchor_asset_type,
    displayDecimals: a.display_decimals,
  }));

  log.info(
    { verified: anchorMapped.length, total: allAnchorMapped.length },
    'Anchor assets prepared'
  );

  // ─────────────────────────────────────────────────────
  // STEP 4: Batch upsert all into the global registry
  //   Order: XLM first, then anchor (higher priority), then Horizon
  //   The upsert logic handles deduplication by code+issuer
  // ─────────────────────────────────────────────────────
  log.info('Step 3/3: Persisting to Asset Registry...');

  const allAssets = [nativeXlm, ...allAnchorMapped, ...horizonAssets];

  // Deduplicate by code:issuer before batch upsert
  const seen = new Set();
  const deduped = [];
  for (const asset of allAssets) {
    const key = `${asset.code}:${asset.issuer || 'native'}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(asset);
    }
  }

  const upserted = batchUpsertAssets(deduped);

  const durationMs = Date.now() - startTime;
  const stats = getAssetStats();

  log.info(
    {
      upserted: upserted.length,
      ...stats,
      ms: durationMs,
    },
    '═══ Asset Registry Sync Complete ✓ ═══'
  );

  return {
    ok: true,
    upserted: upserted.length,
    stats,
    durationMs,
    sources: {
      horizon: horizonAssets.length,
      anchor: allAnchorMapped.length,
    },
  };
}

/**
 * Get ALL anchor assets (including unverified) with anchor metadata joined.
 * This gives the registry full coverage of what anchors claim to support.
 */
function getAllAnchorAssetsForRegistry() {
  try {
    return getDb().prepare(`
      SELECT aa.*, a.domain as anchor_domain, a.name as anchor_display_name,
             a.health_status as anchor_health, a.trust_level as anchor_trust
      FROM anchor_assets aa
      JOIN anchors a ON aa.anchor_id = a.id
      WHERE a.status = 'active'
        AND aa.status != 'inactive'
      ORDER BY aa.code
    `).all();
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to fetch anchor assets for registry');
    return [];
  }
}

/**
 * Extract domain from a stellar.toml URL.
 */
function extractDomainFromToml(tomlUrl) {
  try {
    const url = new URL(tomlUrl);
    return url.hostname;
  } catch {
    return null;
  }
}

export default { syncAssetRegistry };
