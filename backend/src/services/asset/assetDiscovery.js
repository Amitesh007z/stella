// ─── Stella Protocol — Horizon Asset Discovery ────────────────
// Discovers assets from the Stellar Horizon asset endpoint.
// Paginated fetch of all assets with meaningful trustline activity.
// This is the network-native asset discovery source.

import { queryAssets, horizon } from '../../lib/horizon.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('asset-discovery');

// ── Config ────────────────────────────────────────────────────
const MIN_ACCOUNTS_THRESHOLD = 1;     // Minimum trustlines for inclusion
const PAGE_LIMIT = 200;               // Max per Horizon page
const MAX_PAGES = 25;                 // Cap to avoid infinite crawl (200*25 = 5000 assets max)

/**
 * Discover assets from the Horizon asset endpoint.
 * Paginates through all assets that meet minimum thresholds.
 * 
 * @param {object} options
 * @param {number} options.minAccounts - Minimum num_accounts for inclusion
 * @param {number} options.maxPages - Maximum number of pages to fetch
 * @returns {Promise<{assets: HorizonAsset[], pages: number, totalRaw: number}>}
 */
export async function discoverAssetsFromHorizon({
  minAccounts = MIN_ACCOUNTS_THRESHOLD,
  maxPages = MAX_PAGES,
} = {}) {
  log.info({ minAccounts, maxPages }, 'Starting Horizon asset discovery');

  const startTime = Date.now();
  const assets = [];
  let page = 0;
  let totalRaw = 0;

  try {
    let response = await horizon.assets().limit(PAGE_LIMIT).order('desc').call();

    while (response && response.records && page < maxPages) {
      page++;
      totalRaw += response.records.length;

      for (const record of response.records) {
        // ── Filter by minimum activity ────────────────
        if (record.num_accounts >= minAccounts) {
          assets.push(normalizeHorizonAsset(record));
        }
      }

      log.debug({ page, records: response.records.length, accepted: assets.length }, 'Asset page processed');

      // ── Check if more pages exist ───────────────────
      if (response.records.length < PAGE_LIMIT) {
        break; // Last page
      }

      // ── Fetch next page ─────────────────────────────
      try {
        response = await response.next();
      } catch (err) {
        log.warn({ page, err: err.message }, 'Pagination error — stopping');
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    log.info(
      { totalDiscovered: assets.length, totalRaw, pages: page, ms: durationMs },
      'Horizon asset discovery complete'
    );

    return { assets, pages: page, totalRaw, durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    log.error({ err: err.message, ms: durationMs }, 'Horizon asset discovery failed');
    return { assets: [], pages: 0, totalRaw: 0, durationMs, error: err.message };
  }
}

/**
 * Discover a specific set of well-known assets on the network.
 * Used for targeted validation/enrichment, not bulk discovery.
 */
export async function discoverAssetByCode(code, issuer) {
  try {
    const response = await queryAssets({ code, issuer, limit: 1 });
    if (response.records && response.records.length > 0) {
      return { ok: true, asset: normalizeHorizonAsset(response.records[0]) };
    }
    return { ok: false, error: 'Asset not found on network' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Normalize a raw Horizon asset record into our canonical form.
 */
function normalizeHorizonAsset(record) {
  return {
    code: record.asset_code || 'XLM',
    issuer: record.asset_issuer || null,
    assetType: record.asset_type,
    // On-chain stats
    numAccounts: record.num_accounts || 0,
    amount: record.amount || '0',
    // Flags
    authRequired: record.flags?.auth_required || false,
    authRevocable: record.flags?.auth_revocable || false,
    authImmutable: record.flags?.auth_immutable || false,
    authClawbackEnabled: record.flags?.auth_clawback_enabled || false,
    // Paging
    pagingToken: record.paging_token,
    // Links
    tomlUrl: record._links?.toml?.href || null,
  };
}

/**
 * Add native XLM to an asset list (it doesn't appear in Horizon assets endpoint).
 */
export function getNativeXlm() {
  return {
    code: 'XLM',
    issuer: null,
    assetType: 'native',
    numAccounts: -1,
    amount: 'native',
    authRequired: false,
    authRevocable: false,
    authImmutable: false,
    authClawbackEnabled: false,
    pagingToken: null,
    tomlUrl: null,
  };
}

export default { discoverAssetsFromHorizon, discoverAssetByCode, getNativeXlm };
