// ─── Stella Protocol — Anchor Indexer (Main Orchestrator) ─────
// The core crawl pipeline. For a given domain, this module:
//   1. Fetches stellar.toml
//   2. Parses it
//   3. Validates issuers + assets on Horizon
//   4. Computes health & completeness scores
//   5. Persists everything to the Anchor Capability Index
//   6. Logs the crawl result
//
// This is the single entry point called by the crawl scheduler.

import { fetchStellarToml } from './tomlFetcher.js';
import { parseStellarToml } from './tomlParser.js';
import { validateAnchorOnChain } from './horizonValidator.js';
import {
  upsertAnchor,
  upsertAnchorAsset,
  incrementCrawlCount,
  markAnchorError,
  deactivateRemovedAssets,
  logCrawl,
  getCrawlHistory,
  getAnchorByDomain,
} from './anchorRepository.js';
import {
  computeCompletenessScore,
  computeHealthScore,
  deriveHealthStatus,
} from './anchorHealth.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('anchor-indexer');

/**
 * Crawl a single anchor domain end-to-end.
 * This is idempotent — safe to call repeatedly.
 *
 * @param {string} domain - Anchor domain to crawl
 * @param {object} options
 * @param {string} options.trustLevel - 'seeded' | 'discovered'
 * @param {boolean} options.skipValidation - Skip Horizon validation (for speed)
 * @returns {Promise<CrawlResult>}
 */
export async function crawlAnchor(domain, { trustLevel = 'discovered', skipValidation = false } = {}) {
  const startTime = Date.now();

  log.info({ domain, trustLevel }, '──── Crawl start ────');

  try {
    // ═══════════════════════════════════════════════════
    // STEP 1: Fetch stellar.toml
    // ═══════════════════════════════════════════════════
    const fetchResult = await fetchStellarToml(domain);

    if (!fetchResult.ok) {
      const durationMs = Date.now() - startTime;

      // Ensure anchor record exists in DB even on failure (critical for seeded anchors)
      upsertAnchor({
        domain,
        name: domain,
        status: 'error',
        trustLevel,
        healthStatus: 'offline',
        healthScore: 0,
        completenessScore: 0,
        lastError: fetchResult.error,
      });

      incrementCrawlCount(domain, false);
      logCrawl(domain, 'error', 0, durationMs, fetchResult.error);

      log.warn({ domain, error: fetchResult.error, ms: durationMs }, '──── Crawl failed (fetch) ────');
      return {
        ok: false,
        domain,
        phase: 'fetch',
        error: fetchResult.error,
        durationMs,
      };
    }

    // ═══════════════════════════════════════════════════
    // STEP 2: Parse TOML
    // ═══════════════════════════════════════════════════
    const parseResult = parseStellarToml(domain, fetchResult.toml);

    if (!parseResult.ok) {
      const durationMs = Date.now() - startTime;

      // Ensure anchor record exists in DB even on parse failure
      upsertAnchor({
        domain,
        name: domain,
        tomlRaw: fetchResult.toml,
        status: 'error',
        trustLevel,
        healthStatus: 'degraded',
        healthScore: 0.1,
        completenessScore: 0,
        lastError: parseResult.error,
      });

      incrementCrawlCount(domain, false);
      logCrawl(domain, 'error', 0, durationMs, parseResult.error);

      log.warn({ domain, error: parseResult.error, ms: durationMs }, '──── Crawl failed (parse) ────');
      return {
        ok: false,
        domain,
        phase: 'parse',
        error: parseResult.error,
        durationMs,
      };
    }

    const tomlData = parseResult.data;

    // ═══════════════════════════════════════════════════
    // STEP 3: Validate on Horizon (unless skipped)
    // ═══════════════════════════════════════════════════
    let validationResult = null;
    if (!skipValidation && (tomlData.accounts.length > 0 || tomlData.currencies.length > 0)) {
      try {
        validationResult = await validateAnchorOnChain(tomlData);
      } catch (err) {
        log.warn({ domain, err: err.message }, 'Horizon validation failed — continuing with partial data');
      }
    }

    // ═══════════════════════════════════════════════════
    // STEP 4: Compute scores
    // ═══════════════════════════════════════════════════
    const completenessScore = computeCompletenessScore(tomlData);

    const crawlHistory = getCrawlHistory(domain, 10);
    const healthScore = computeHealthScore({
      crawlResult: fetchResult,
      validationStats: validationResult?.stats,
      crawlHistory,
    });

    const healthStatus = deriveHealthStatus(healthScore);

    // ═══════════════════════════════════════════════════
    // STEP 5: Persist anchor record
    // ═══════════════════════════════════════════════════
    const anchorId = upsertAnchor({
      domain,
      name: tomlData.orgName || domain,
      transferServer: tomlData.transferServer,
      transferServerSep24: tomlData.transferServerSep24,
      quoteServer: tomlData.quoteServer,
      webAuthEndpoint: tomlData.webAuthEndpoint,
      signingKey: tomlData.signingKey,
      tomlRaw: fetchResult.toml,
      tomlVersion: tomlData.version,
      status: 'active',
      trustLevel,
      healthStatus,
      healthScore,
      completenessScore,
      lastError: null,
      horizonValidatedAt: validationResult ? new Date().toISOString() : null,
    });

    // ═══════════════════════════════════════════════════
    // STEP 6: Persist anchor assets (currencies)
    // ═══════════════════════════════════════════════════
    const persistedAssets = [];
    const currentAssetKeys = [];

    for (const currency of tomlData.currencies) {
      const assetKey = `${currency.code}:${currency.issuer}`;
      currentAssetKeys.push(assetKey);

      // Check on-chain status
      let isOnChain = false;
      let numAccounts = null;
      let amountCirculating = null;

      if (validationResult?.assetResults) {
        const validation = validationResult.assetResults.get(assetKey);
        if (validation) {
          isOnChain = validation.exists;
          numAccounts = validation.numAccounts;
          amountCirculating = validation.amount;
        }
      }

      const assetId = upsertAnchorAsset(anchorId, {
        code: currency.code,
        issuer: currency.issuer,
        assetType: currency.assetType,
        status: isOnChain ? 'active' : 'unverified',
        isDepositEnabled: currency.isDepositEnabled,
        isWithdrawEnabled: currency.isWithdrawEnabled,
        feeFixed: currency.feeFixed,
        feePercent: currency.feePercent,
        minAmount: currency.minAmount,
        maxAmount: currency.maxAmount,
        sep38Supported: currency.sep38Supported,
        description: currency.description,
        isOnChain,
        horizonValidatedAt: validationResult ? new Date().toISOString() : null,
        numAccounts,
        amountCirculating,
        anchorName: tomlData.orgName,
        displayDecimals: currency.displayDecimals,
        conditions: currency.conditions,
        isAssetAnchored: currency.isAssetAnchored,
        anchorAssetType: currency.anchorAssetType,
        redemptionInstructions: currency.redemptionInstructions,
      });

      persistedAssets.push({ id: assetId, code: currency.code, issuer: currency.issuer, isOnChain });
    }

    // ── Deactivate removed assets ─────────────────────
    const deactivated = deactivateRemovedAssets(anchorId, currentAssetKeys);

    // ═══════════════════════════════════════════════════
    // STEP 7: Log & finalize
    // ═══════════════════════════════════════════════════
    const durationMs = Date.now() - startTime;
    incrementCrawlCount(domain, true);
    logCrawl(domain, 'success', persistedAssets.length, durationMs, null);

    log.info(
      {
        domain,
        anchorId,
        assets: persistedAssets.length,
        onChain: persistedAssets.filter((a) => a.isOnChain).length,
        deactivated,
        completeness: completenessScore,
        health: healthScore,
        status: healthStatus,
        ms: durationMs,
      },
      '──── Crawl complete ✓ ────'
    );

    return {
      ok: true,
      domain,
      anchorId,
      assets: persistedAssets,
      scores: { completenessScore, healthScore, healthStatus },
      durationMs,
    };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    markAnchorError(domain, err.message);
    incrementCrawlCount(domain, false);
    logCrawl(domain, 'error', 0, durationMs, err.message);

    log.error({ domain, err: err.message, ms: durationMs }, '──── Crawl failed (unexpected) ────');
    return {
      ok: false,
      domain,
      phase: 'unknown',
      error: err.message,
      durationMs,
    };
  }
}

/**
 * Bootstrap: crawl all seed domains.
 */
export async function crawlSeeds(seeds) {
  log.info({ count: seeds.length }, 'Starting seed anchor crawl');

  const results = [];
  for (const seed of seeds) {
    const result = await crawlAnchor(seed.domain, { trustLevel: 'seeded' });
    results.push(result);

    // Small delay between crawls to be respectful
    await sleep(500);
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  log.info({ succeeded, failed, total: seeds.length }, 'Seed crawl complete');
  return results;
}

/**
 * Refresh: recrawl all anchors with expired TTL.
 */
export async function refreshStaleAnchors(staleAnchors) {
  log.info({ count: staleAnchors.length }, 'Starting stale anchor refresh');

  const results = [];
  for (const anchor of staleAnchors) {
    const result = await crawlAnchor(anchor.domain, {
      trustLevel: anchor.trust_level,
    });
    results.push(result);
    await sleep(300);
  }

  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { crawlAnchor, crawlSeeds, refreshStaleAnchors };
