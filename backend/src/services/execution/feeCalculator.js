// ─── Stella Protocol — Fee Calculator ─────────────────────────
// Computes total cost and fee breakdown for every leg of a route.
//
// Fee sources:
//   1. Network base fee   — Stellar tx cost per operation (100 stroops default)
//   2. DEX spread cost    — implicit fee from bid-ask spread
//   3. Anchor fees        — fixed + percentage fees on bridge legs
//
// All amounts are expressed as strings (7 decimal places) to avoid
// floating point drift.

import { createLogger } from '../../lib/logger.js';
import { EdgeType } from '../graph/routeGraph.js';

const log = createLogger('fee-calculator');

// ─── Constants ────────────────────────────────────────────────
const STELLAR_BASE_FEE_STROOPS = 100;       // 100 stroops = 0.00001 XLM
const STROOPS_PER_XLM = 10_000_000;
const BASE_FEE_XLM = STELLAR_BASE_FEE_STROOPS / STROOPS_PER_XLM;

/**
 * @typedef {object} LegFee
 * @property {number}  step          - Leg index (1-based)
 * @property {string}  from          - Source asset key
 * @property {string}  to            - Target asset key
 * @property {string}  type          - Edge type
 * @property {number}  networkFeeXlm - Stellar base fee in XLM for this leg
 * @property {number}  spreadCost    - Implicit cost from DEX spread (in source units)
 * @property {number}  anchorFeeFixed    - Fixed anchor fee (in asset units)
 * @property {number}  anchorFeePercent  - Percentage anchor fee (as decimal)
 * @property {number}  anchorFeeTotal    - Total anchor fee for amount
 * @property {number}  totalLegFee   - Combined effective fee for this leg
 */

/**
 * @typedef {object} FeeBreakdown
 * @property {object[]} legs           - Per-leg fee details
 * @property {number}   networkFeeXlm  - Total network fees in XLM
 * @property {number}   totalSpreadCost - Cumulative DEX spread cost
 * @property {number}   totalAnchorFees - Cumulative anchor fees
 * @property {number}   operationCount  - Number of Stellar operations needed
 * @property {string}   effectiveFeeRate - Total fee as % of send amount
 */

// ═══════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate fee breakdown for a route.
 *
 * @param {object} route - A RouteManifest from the route resolver
 * @returns {FeeBreakdown}
 */
export function calculateFees(route) {
  const { legs, sendAmount } = route;
  const amount = parseFloat(sendAmount) || 0;

  if (!legs || legs.length === 0) {
    return emptyBreakdown();
  }

  const legFees = [];
  let runningAmount = amount;
  let totalNetworkFee = 0;
  let totalSpreadCost = 0;
  let totalAnchorFees = 0;
  let operationCount = 0;

  for (const leg of legs) {
    const legFee = computeLegFee(leg, runningAmount);
    legFees.push(legFee);

    totalNetworkFee += legFee.networkFeeXlm;
    totalSpreadCost += legFee.spreadCost;
    totalAnchorFees += legFee.anchorFeeTotal;
    operationCount += legFee.operations;

    // Deduct fees to get running amount for next leg
    runningAmount = Math.max(0, runningAmount - legFee.spreadCost - legFee.anchorFeeTotal);
  }

  // Effective fee rate as percentage of send amount
  const totalFees = totalSpreadCost + totalAnchorFees;
  const effectiveFeeRate = amount > 0
    ? +((totalFees / amount) * 100).toFixed(4)
    : 0;

  const breakdown = {
    legs: legFees,
    networkFeeXlm: +totalNetworkFee.toFixed(7),
    totalSpreadCost: +totalSpreadCost.toFixed(7),
    totalAnchorFees: +totalAnchorFees.toFixed(7),
    operationCount,
    effectiveFeeRate: `${effectiveFeeRate}%`,
    estimatedTotalCostXlm: +(totalNetworkFee).toFixed(7),
  };

  log.debug({
    legs: legs.length,
    effectiveFeeRate: breakdown.effectiveFeeRate,
    networkFee: breakdown.networkFeeXlm,
  }, 'Fee calculation complete');

  return breakdown;
}

// ═══════════════════════════════════════════════════════════════
// PER-LEG FEE COMPUTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the fee for a single leg.
 */
function computeLegFee(leg, amount) {
  const base = {
    step: leg.step,
    from: leg.from,
    to: leg.to,
    type: leg.type,
    networkFeeXlm: 0,
    spreadCost: 0,
    anchorFeeFixed: 0,
    anchorFeePercent: 0,
    anchorFeeTotal: 0,
    operations: 0,
  };

  if (leg.type === EdgeType.DEX || leg.type === 'dex') {
    return computeDexLegFee(base, leg, amount);
  }

  if (leg.type === EdgeType.ANCHOR_BRIDGE || leg.type === 'anchor_bridge') {
    return computeBridgeLegFee(base, leg, amount);
  }

  if (leg.type === 'horizon_path') {
    return computeHorizonLegFee(base, leg, amount);
  }

  // Unknown leg type — just network fee
  base.networkFeeXlm = BASE_FEE_XLM;
  base.operations = 1;
  return base;
}

/**
 * DEX leg: path_payment operation + spread cost.
 */
function computeDexLegFee(base, leg, amount) {
  // One path_payment_strict_send operation per DEX hop
  base.operations = 1;
  base.networkFeeXlm = BASE_FEE_XLM;

  // Spread cost: the implicit fee from crossing the bid-ask spread
  const details = leg.details || {};
  const spread = details.spread || leg.weight * 0.1 || 0;
  base.spreadCost = +(amount * spread).toFixed(7);

  return base;
}

/**
 * Anchor bridge leg: may have fixed + percentage fees.
 */
function computeBridgeLegFee(base, leg, amount) {
  // Bridge legs don't require an on-chain operation directly
  // (the anchor handles deposit/withdraw), but wrapping in
  // a managed payment may cost one operation.
  base.operations = 1;
  base.networkFeeXlm = BASE_FEE_XLM;

  const details = leg.details || {};
  base.anchorFeeFixed = details.feeFixed || 0;
  base.anchorFeePercent = details.feePercent || 0;
  base.anchorFeeTotal = +(base.anchorFeeFixed + (amount * base.anchorFeePercent / 100)).toFixed(7);

  return base;
}

/**
 * Horizon-validated path: network fee only (no visible spread).
 */
function computeHorizonLegFee(base, leg, amount) {
  base.operations = 1;
  base.networkFeeXlm = BASE_FEE_XLM;
  // Horizon strict-send already accounts for spread in the destination amount
  return base;
}

/**
 * Empty fee breakdown for routes with no legs.
 */
function emptyBreakdown() {
  return {
    legs: [],
    networkFeeXlm: 0,
    totalSpreadCost: 0,
    totalAnchorFees: 0,
    operationCount: 0,
    effectiveFeeRate: '0%',
    estimatedTotalCostXlm: 0,
  };
}

// ─── Exports for testing ──────────────────────────────────────
export { BASE_FEE_XLM, STELLAR_BASE_FEE_STROOPS };
