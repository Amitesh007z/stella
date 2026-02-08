// ─── Stella Protocol — Quote Manager ──────────────────────────
// Manages route quotes with TTL, refresh, and validation.
//
// A "quote" is a route manifest enhanced with execution-grade data:
//   - Fee breakdown
//   - Slippage estimate
//   - Execution plan
//   - Expiry management
//
// Quotes are stored in-memory with short TTLs and can be
// refreshed via Horizon re-validation.

import { findRoutes } from '../route/routeResolver.js';
import { buildExecutionPlan } from './executionPlanner.js';
import { calculateFees } from './feeCalculator.js';
import { estimateSlippage } from './slippageEstimator.js';
import { findStrictSendPaths, StellarSdk } from '../../lib/horizon.js';
import { parseAssetKey } from '../graph/routeGraph.js';
import { Errors } from '../../plugins/errorHandler.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('quote-manager');

// ─── Configuration ────────────────────────────────────────────
const QUOTE_TTL_MS = 30_000;        // 30 seconds
const MAX_STORED_QUOTES = 1000;     // In-memory limit
const CLEANUP_INTERVAL_MS = 15_000; // Purge expired quotes

// ─── In-Memory Quote Store ────────────────────────────────────
const quoteStore = new Map();  // quoteId → quote

// ─── Counters ─────────────────────────────────────────────────
let totalQuotesCreated = 0;
let totalQuotesRefreshed = 0;
let totalQuotesExpired = 0;

/**
 * @typedef {object} Quote
 * @property {string}  quoteId         - Unique quote identifier
 * @property {object}  route           - Route manifest
 * @property {object}  executionPlan   - Step-by-step execution plan
 * @property {object}  fees            - Fee breakdown
 * @property {object}  slippage        - Slippage estimate
 * @property {string}  status          - "live" | "expired" | "refreshing"
 * @property {string}  createdAt       - ISO timestamp
 * @property {string}  expiresAt       - ISO timestamp
 * @property {number}  refreshCount    - How many times refreshed
 * @property {string}  [horizonVerified] - Last Horizon verification timestamp
 */

// ═══════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new quote from a route query.
 * Finds best routes, enriches best one with execution plan.
 *
 * @param {object} query - Route query (sourceCode, destCode, amount, etc.)
 * @param {object} [opts] - Options
 * @param {number} [opts.slippageTolerance] - Slippage tolerance %
 * @param {boolean} [opts.liveSlippage] - Fetch live orderbook
 * @returns {Promise<Quote>}
 */
export async function createQuote(query, opts = {}) {
  const {
    slippageTolerance = 1.0,
    liveSlippage = false,
  } = opts;

  // ── Find routes ─────────────────────────────────────
  const { routes, meta } = await findRoutes(query);

  if (!routes || routes.length === 0) {
    throw Errors.noRoute('No viable route found for quote');
  }

  // Take the best-scoring route
  const bestRoute = routes[0];

  // ── Build execution plan ────────────────────────────
  const executionPlan = await buildExecutionPlan(bestRoute, {
    slippageTolerance,
    liveSlippage,
  });

  // ── Assemble quote ──────────────────────────────────
  const quoteId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);

  const quote = {
    quoteId,
    route: bestRoute,
    alternativeRoutes: routes.slice(1).map(minimalRoute),
    executionPlan,
    status: 'live',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlMs: QUOTE_TTL_MS,
    refreshCount: 0,
    horizonVerified: null,
    queryMeta: meta,
  };

  // Store the quote
  storeQuote(quoteId, quote);
  totalQuotesCreated++;

  log.info({
    quoteId,
    routeId: bestRoute.id,
    score: bestRoute.score,
    alternatives: routes.length - 1,
    expiresAt: expiresAt.toISOString(),
  }, 'Quote created');

  return quote;
}

/**
 * Get a quote by ID.
 *
 * @param {string} quoteId
 * @returns {Quote | null}
 */
export function getQuote(quoteId) {
  const quote = quoteStore.get(quoteId);
  if (!quote) return null;

  // Check expiry
  if (new Date() > new Date(quote.expiresAt)) {
    quote.status = 'expired';
  }

  return quote;
}

/**
 * Refresh a quote — re-validate with live Horizon data.
 * Updates amounts, slippage, and extends TTL.
 *
 * @param {string} quoteId
 * @returns {Promise<Quote>}
 */
export async function refreshQuote(quoteId) {
  const existing = quoteStore.get(quoteId);
  if (!existing) {
    throw Errors.notFound(`Quote not found: ${quoteId}`);
  }

  // Even if expired, allow refresh (creates updated quote)
  existing.status = 'refreshing';

  try {
    // Re-run the same query to get fresh data
    const route = existing.route;
    const srcParsed = parseAssetKey(route.sourceAsset);
    const dstParsed = parseAssetKey(route.destAsset);

    // Try Horizon strict-send to validate the path is still viable
    let horizonVerified = null;
    try {
      const sourceAsset = srcParsed.issuer
        ? new StellarSdk.Asset(srcParsed.code, srcParsed.issuer)
        : StellarSdk.Asset.native();
      const destAsset = dstParsed.issuer
        ? new StellarSdk.Asset(dstParsed.code, dstParsed.issuer)
        : StellarSdk.Asset.native();

      const result = await findStrictSendPaths({
        sourceAsset,
        sourceAmount: route.sendAmount,
        destinationAssets: [destAsset],
      });

      if (result.records && result.records.length > 0) {
        // Update receive amount with Horizon-verified value
        route.receiveAmount = result.records[0].destination_amount;
        horizonVerified = new Date().toISOString();
      }
    } catch (err) {
      log.debug({ err: err.message }, 'Horizon validation failed during refresh');
    }

    // Rebuild execution plan with potentially new amounts
    const executionPlan = await buildExecutionPlan(route, {
      slippageTolerance: 1.0,
      liveSlippage: true,
    });

    // Extend TTL
    const now = new Date();
    const newExpiry = new Date(now.getTime() + QUOTE_TTL_MS);

    const refreshed = {
      ...existing,
      route,
      executionPlan,
      status: 'live',
      expiresAt: newExpiry.toISOString(),
      refreshCount: existing.refreshCount + 1,
      horizonVerified: horizonVerified || existing.horizonVerified,
      lastRefreshedAt: now.toISOString(),
    };

    quoteStore.set(quoteId, refreshed);
    totalQuotesRefreshed++;

    log.info({
      quoteId,
      refreshCount: refreshed.refreshCount,
      newExpiry: newExpiry.toISOString(),
      horizonVerified: !!horizonVerified,
    }, 'Quote refreshed');

    return refreshed;
  } catch (err) {
    existing.status = 'expired';
    throw err;
  }
}

/**
 * Get quote manager statistics.
 */
export function getQuoteStats() {
  let liveCount = 0;
  let expiredCount = 0;

  for (const quote of quoteStore.values()) {
    if (new Date() > new Date(quote.expiresAt)) {
      expiredCount++;
    } else {
      liveCount++;
    }
  }

  return {
    stored: quoteStore.size,
    live: liveCount,
    expired: expiredCount,
    totalCreated: totalQuotesCreated,
    totalRefreshed: totalQuotesRefreshed,
    totalExpired: totalQuotesExpired,
    maxCapacity: MAX_STORED_QUOTES,
    ttlMs: QUOTE_TTL_MS,
  };
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════

/**
 * Store a quote with LRU eviction.
 */
function storeQuote(quoteId, quote) {
  // Evict if at capacity
  if (quoteStore.size >= MAX_STORED_QUOTES) {
    const oldestKey = quoteStore.keys().next().value;
    quoteStore.delete(oldestKey);
    totalQuotesExpired++;
  }
  quoteStore.set(quoteId, quote);
}

/**
 * Minimal route representation for alternatives list.
 */
function minimalRoute(route) {
  return {
    id: route.id,
    score: route.score,
    hops: route.hops,
    receiveAmount: route.receiveAmount,
    edgeTypes: route.edgeTypes,
    totalWeight: route.totalWeight,
  };
}

/**
 * Clean up expired quotes from memory.
 */
function cleanupExpiredQuotes() {
  const now = new Date();
  let removed = 0;

  for (const [id, quote] of quoteStore.entries()) {
    // Remove quotes that expired more than 2x TTL ago
    const expiry = new Date(quote.expiresAt);
    if (now - expiry > QUOTE_TTL_MS * 2) {
      quoteStore.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    totalQuotesExpired += removed;
    log.debug({ removed, remaining: quoteStore.size }, 'Expired quotes cleaned up');
  }
}

// ─── Background Cleanup ──────────────────────────────────────
let cleanupTimer = null;

export function startQuoteCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupExpiredQuotes, CLEANUP_INTERVAL_MS);
  log.debug('Quote cleanup timer started');
}

export function stopQuoteCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
