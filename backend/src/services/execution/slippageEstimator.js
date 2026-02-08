// ─── Stella Protocol — Slippage Estimator ─────────────────────
// Estimates price impact (slippage) for a given trade amount
// by walking the orderbook depth at each DEX leg.
//
// Slippage is the difference between the top-of-book price and
// the effective average price after consuming liquidity.
//
// For anchor bridge legs, slippage is assumed to be zero
// (anchor sets the rate).

import { getOrderbook, StellarSdk } from '../../lib/horizon.js';
import { EdgeType, parseAssetKey } from '../graph/routeGraph.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('slippage-estimator');

const ORDERBOOK_FETCH_TIMEOUT = 8000;  // ms
const ORDERBOOK_DEPTH = 50;            // asks/bids to fetch

/**
 * @typedef {object} SlippageEstimate
 * @property {number} totalSlippagePercent - Total slippage across all legs (%)
 * @property {object[]} legs               - Per-leg slippage details
 * @property {string} severity             - "low" | "medium" | "high" | "extreme"
 * @property {boolean} reliable            - Whether estimate is based on live data
 */

// ═══════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate slippage for a route.
 *
 * @param {object} route   - RouteManifest
 * @param {object} [opts]  - Options
 * @param {boolean} [opts.live=false] - Fetch live orderbook (slower but accurate)
 * @returns {Promise<SlippageEstimate>}
 */
export async function estimateSlippage(route, opts = {}) {
  const { live = false } = opts;
  const amount = parseFloat(route.sendAmount) || 0;

  if (!route.legs || route.legs.length === 0 || amount <= 0) {
    return { totalSlippagePercent: 0, legs: [], severity: 'low', reliable: false };
  }

  const legEstimates = [];
  let cumulativeSlippage = 0;
  let runningAmount = amount;
  let allReliable = true;

  for (const leg of route.legs) {
    const est = await estimateLegSlippage(leg, runningAmount, live);
    legEstimates.push(est);
    cumulativeSlippage += est.slippagePercent;

    if (!est.reliable) allReliable = false;

    // Adjust running amount for next leg
    if (est.effectivePrice > 0 && leg.type === EdgeType.DEX) {
      runningAmount = runningAmount * est.effectivePrice * (1 - est.slippagePercent / 100);
    }
  }

  const totalSlippage = +cumulativeSlippage.toFixed(4);
  const severity = classifySlippage(totalSlippage);

  log.debug({
    legs: route.legs.length,
    totalSlippage: `${totalSlippage}%`,
    severity,
    live,
  }, 'Slippage estimation complete');

  return {
    totalSlippagePercent: totalSlippage,
    legs: legEstimates,
    severity,
    reliable: allReliable,
  };
}

// ═══════════════════════════════════════════════════════════════
// PER-LEG SLIPPAGE
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate slippage for a single leg.
 */
async function estimateLegSlippage(leg, amount, live) {
  const base = {
    step: leg.step,
    from: leg.from,
    to: leg.to,
    type: leg.type,
    slippagePercent: 0,
    effectivePrice: 0,
    topOfBookPrice: 0,
    depthConsumed: 0,
    reliable: false,
  };

  // Bridge legs: zero slippage (anchor-set rate)
  if (leg.type === EdgeType.ANCHOR_BRIDGE || leg.type === 'anchor_bridge') {
    base.slippagePercent = 0;
    base.reliable = true;
    base.effectivePrice = 1; // 1:1 minus fees (handled by fee calculator)
    return base;
  }

  // Horizon-validated: already includes slippage in dest amount
  if (leg.type === 'horizon_path') {
    base.slippagePercent = 0;
    base.reliable = true;
    return base;
  }

  // DEX legs: walk the orderbook
  if (leg.type === EdgeType.DEX || leg.type === 'dex') {
    return await estimateDexSlippage(base, leg, amount, live);
  }

  return base;
}

/**
 * Walk a DEX orderbook to estimate average fill price and slippage.
 */
async function estimateDexSlippage(base, leg, amount, live) {
  try {
    // If live, fetch fresh orderbook; otherwise use cached edge data
    let asks;
    if (live) {
      asks = await fetchAsks(leg.from, leg.to);
    }

    if (asks && asks.length > 0) {
      // Walk asks to fill the amount
      const walkResult = walkOrderbook(asks, amount);
      base.topOfBookPrice = walkResult.topPrice;
      base.effectivePrice = walkResult.avgPrice;
      base.depthConsumed = walkResult.filled;
      base.reliable = true;

      if (walkResult.topPrice > 0) {
        // Slippage = (avgPrice - topPrice) / topPrice * 100
        base.slippagePercent = +(
          Math.abs(walkResult.avgPrice - walkResult.topPrice) /
          walkResult.topPrice * 100
        ).toFixed(4);
      }
    } else {
      // Fall back to edge data for a rough estimate
      const details = leg.details || {};
      const askDepth = details.askDepth || 0;
      const spread = details.spread || 0;

      base.topOfBookPrice = details.topAsk || 0;
      base.effectivePrice = details.topAsk || 0;
      base.reliable = false;

      // Heuristic: slippage grows linearly when amount > 10% of depth
      if (askDepth > 0 && amount > 0) {
        const fillRatio = amount / askDepth;
        if (fillRatio > 0.1) {
          // ~1% slippage per 10% of orderbook consumed
          base.slippagePercent = +(Math.min(fillRatio * 10, 50)).toFixed(4);
        }
      }
    }
  } catch (err) {
    log.debug({ err: err.message, leg: leg.step }, 'Slippage estimation failed for leg');
    base.reliable = false;
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════
// ORDERBOOK WALKING
// ═══════════════════════════════════════════════════════════════

/**
 * Walk orderbook asks to determine average fill price.
 *
 * @param {Array} asks  - Sorted ask levels [{price, amount}]
 * @param {number} targetAmount - Amount of base asset to sell
 * @returns {{topPrice, avgPrice, filled, levels}}
 */
function walkOrderbook(asks, targetAmount) {
  if (asks.length === 0) {
    return { topPrice: 0, avgPrice: 0, filled: 0, levels: 0 };
  }

  const topPrice = parseFloat(asks[0].price);
  let remaining = targetAmount;
  let totalCost = 0;
  let totalFilled = 0;
  let levels = 0;

  for (const ask of asks) {
    if (remaining <= 0) break;

    const price = parseFloat(ask.price);
    const available = parseFloat(ask.amount);
    const fill = Math.min(remaining, available);

    totalCost += fill * price;
    totalFilled += fill;
    remaining -= fill;
    levels++;
  }

  const avgPrice = totalFilled > 0 ? totalCost / totalFilled : topPrice;

  return {
    topPrice,
    avgPrice: +avgPrice.toFixed(7),
    filled: +totalFilled.toFixed(7),
    levels,
  };
}

/**
 * Fetch live asks from Horizon orderbook.
 */
async function fetchAsks(fromKey, toKey) {
  try {
    const fromParsed = parseAssetKey(fromKey);
    const toParsed = parseAssetKey(toKey);

    const selling = fromParsed.issuer
      ? new StellarSdk.Asset(fromParsed.code, fromParsed.issuer)
      : StellarSdk.Asset.native();
    const buying = toParsed.issuer
      ? new StellarSdk.Asset(toParsed.code, toParsed.issuer)
      : StellarSdk.Asset.native();

    const result = await withTimeout(
      getOrderbook(selling, buying, ORDERBOOK_DEPTH),
      ORDERBOOK_FETCH_TIMEOUT
    );

    return (result.asks || []).map((a) => ({
      price: a.price,
      amount: a.amount,
    }));
  } catch (err) {
    log.debug({ err: err.message }, 'Failed to fetch orderbook for slippage');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SLIPPAGE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Classify total slippage into severity buckets.
 */
function classifySlippage(slippagePercent) {
  if (slippagePercent < 0.5) return 'low';
  if (slippagePercent < 2.0) return 'medium';
  if (slippagePercent < 5.0) return 'high';
  return 'extreme';
}

// ─── Utility ──────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

export { walkOrderbook, classifySlippage };
