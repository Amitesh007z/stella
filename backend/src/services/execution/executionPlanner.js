// ─── Stella Protocol — Execution Planner ──────────────────────
// Converts a RouteManifest into a step-by-step Execution Plan
// that can be submitted to the Stellar network.
//
// Each step specifies:
//   - Stellar operation type (path_payment_strict_send, etc.)
//   - Source/destination assets in Stellar SDK format
//   - Minimum receive amounts with slippage tolerance
//   - Memo and anchor instructions for bridge legs
//
// The execution plan is protocol-neutral: it describes WHAT to execute,
// not HOW (that's the wallet/client's job).

import { calculateFees } from './feeCalculator.js';
import { estimateSlippage } from './slippageEstimator.js';
import { EdgeType, parseAssetKey } from '../graph/routeGraph.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('execution-planner');

// ─── Default Slippage Tolerance ───────────────────────────────
const DEFAULT_SLIPPAGE_TOLERANCE_PERCENT = 1.0;  // 1%

/**
 * @typedef {object} ExecutionStep
 * @property {number}  step              - Step number (1-based)
 * @property {string}  operation         - Stellar operation type
 * @property {object}  sourceAsset       - {code, issuer, type}
 * @property {object}  destAsset         - {code, issuer, type}
 * @property {string}  sendAmount        - Amount to send at this step
 * @property {string}  minReceiveAmount  - Minimum acceptable receive
 * @property {string}  expectedReceive   - Expected receive without slippage
 * @property {string}  slippageTolerance - Applied slippage tolerance %
 * @property {object}  [anchorInfo]      - Anchor deposit/withdraw details (bridge legs)
 * @property {string}  description       - Human-readable step description
 */

/**
 * @typedef {object} ExecutionPlan
 * @property {string}         routeId           - Source route manifest ID
 * @property {ExecutionStep[]} steps            - Ordered execution steps
 * @property {object}         fees              - Fee breakdown
 * @property {object}         slippage          - Slippage estimate
 * @property {object}         summary           - High-level summary
 * @property {string}         createdAt         - ISO timestamp
 * @property {number}         ttlSeconds        - Plan validity window
 * @property {string}         status            - "ready" | "expired"
 */

// ═══════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════

/**
 * Build an execution plan from a route manifest.
 *
 * @param {object} route    - RouteManifest from routeResolver
 * @param {object} [opts]   - Options
 * @param {number} [opts.slippageTolerance] - Slippage tolerance %
 * @param {boolean} [opts.liveSlippage]     - Fetch live orderbook for slippage
 * @returns {Promise<ExecutionPlan>}
 */
export async function buildExecutionPlan(route, opts = {}) {
  const {
    slippageTolerance = DEFAULT_SLIPPAGE_TOLERANCE_PERCENT,
    liveSlippage = false,
  } = opts;

  log.info({ routeId: route.id, legs: route.legs?.length, slippageTolerance }, 'Building execution plan');

  // ── Compute fees + slippage in parallel ─────────────
  const [fees, slippage] = await Promise.all([
    Promise.resolve(calculateFees(route)),
    estimateSlippage(route, { live: liveSlippage }),
  ]);

  // ── Build execution steps ───────────────────────────
  const steps = buildSteps(route, fees, slippage, slippageTolerance);

  // ── Assemble plan ───────────────────────────────────
  const plan = {
    routeId: route.id,
    sourceAsset: route.sourceAsset,
    destAsset: route.destAsset,
    sendAmount: route.sendAmount,
    expectedReceiveAmount: route.receiveAmount,
    steps,
    fees,
    slippage,
    summary: buildSummary(route, steps, fees, slippage, slippageTolerance),
    createdAt: new Date().toISOString(),
    ttlSeconds: route.ttlSeconds || 30,
    status: 'ready',
  };

  log.info({
    routeId: route.id,
    steps: steps.length,
    totalFeeRate: fees.effectiveFeeRate,
    slippageSeverity: slippage.severity,
  }, 'Execution plan ready');

  return plan;
}

// ═══════════════════════════════════════════════════════════════
// STEP BUILDER
// ═══════════════════════════════════════════════════════════════

/**
 * Convert legs into executable steps.
 */
function buildSteps(route, fees, slippage, tolerancePercent) {
  const steps = [];
  let runningAmount = parseFloat(route.sendAmount) || 0;

  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const legFee = fees.legs[i] || {};
    const legSlippage = slippage.legs?.[i] || {};

    const step = buildSingleStep(leg, i, runningAmount, legFee, legSlippage, tolerancePercent);
    steps.push(step);

    // Update running amount for next step
    runningAmount = parseFloat(step.expectedReceive) || runningAmount;
  }

  return steps;
}

/**
 * Build one execution step from a route leg.
 */
function buildSingleStep(leg, idx, inputAmount, legFee, legSlippage, tolerancePercent) {
  const fromParsed = parseAssetKey(leg.from);
  const toParsed = parseAssetKey(leg.to);

  const sourceAsset = formatAssetForExecution(fromParsed);
  const destAsset = formatAssetForExecution(toParsed);

  // Determine operation type
  const operation = resolveOperationType(leg);

  // Calculate expected receive based on edge data
  const expectedReceive = estimateStepReceive(leg, inputAmount);

  // Apply slippage tolerance to get minimum receive
  const effectiveTolerance = Math.max(
    tolerancePercent,
    legSlippage.slippagePercent || 0
  );
  const minReceive = applySlippageTolerance(expectedReceive, effectiveTolerance);

  const step = {
    step: idx + 1,
    operation,
    sourceAsset,
    destAsset,
    sendAmount: inputAmount.toFixed(7),
    expectedReceive: expectedReceive.toFixed(7),
    minReceiveAmount: minReceive.toFixed(7),
    slippageTolerance: `${effectiveTolerance}%`,
    networkFeeXlm: legFee.networkFeeXlm || 0,
    description: buildStepDescription(leg, operation, fromParsed, toParsed),
  };

  // Add anchor info for bridge legs
  if (leg.type === EdgeType.ANCHOR_BRIDGE || leg.type === 'anchor_bridge') {
    step.anchorInfo = {
      domain: leg.details?.anchor || leg.details?.anchorDomain || null,
      depositEnabled: leg.details?.depositEnabled ?? true,
      withdrawEnabled: leg.details?.withdrawEnabled ?? true,
      feeFixed: leg.details?.feeFixed || 0,
      feePercent: leg.details?.feePercent || 0,
      instructions: `Deposit ${fromParsed.code} → Withdraw ${toParsed.code} via anchor ${leg.details?.anchor || 'unknown'}`,
    };
  }

  return step;
}

// ═══════════════════════════════════════════════════════════════
// OPERATION TYPE RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Map leg type to Stellar operation type.
 */
function resolveOperationType(leg) {
  switch (leg.type) {
    case EdgeType.DEX:
    case 'dex':
      // DEX legs use path_payment_strict_send
      return 'path_payment_strict_send';

    case EdgeType.ANCHOR_BRIDGE:
    case 'anchor_bridge':
      // Anchor bridges are off-chain deposit/withdraw operations
      return 'anchor_deposit_withdraw';

    case 'horizon_path':
      // Horizon-validated multi-hop path
      return 'path_payment_strict_send';

    default:
      return 'path_payment_strict_send';
  }
}

// ═══════════════════════════════════════════════════════════════
// AMOUNT ESTIMATION
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate receive amount for a single step based on edge data.
 */
function estimateStepReceive(leg, inputAmount) {
  const details = leg.details || {};

  if (leg.type === EdgeType.DEX || leg.type === 'dex') {
    const topAsk = details.topAsk || 0;
    if (topAsk > 0) {
      return inputAmount * topAsk * (1 - (details.spread || 0));
    }
    return inputAmount; // No price data, assume 1:1
  }

  if (leg.type === EdgeType.ANCHOR_BRIDGE || leg.type === 'anchor_bridge') {
    const feeFixed = details.feeFixed || 0;
    const feePercent = details.feePercent || 0;
    return Math.max(0, (inputAmount - feeFixed) * (1 - feePercent / 100));
  }

  // Default: 1:1
  return inputAmount;
}

/**
 * Apply slippage tolerance to get minimum acceptable receive amount.
 */
function applySlippageTolerance(amount, tolerancePercent) {
  return amount * (1 - tolerancePercent / 100);
}

// ═══════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════

/**
 * Format a parsed asset key for execution context.
 */
function formatAssetForExecution(parsed) {
  if (!parsed.issuer) {
    return { code: parsed.code, issuer: null, type: 'native' };
  }
  return { code: parsed.code, issuer: parsed.issuer, type: 'credit_alphanum4' };
}

/**
 * Human-readable step description.
 */
function buildStepDescription(leg, operation, fromParsed, toParsed) {
  if (operation === 'path_payment_strict_send') {
    return `Swap ${fromParsed.code} → ${toParsed.code} via SDEX (strict send)`;
  }
  if (operation === 'anchor_deposit_withdraw') {
    const anchor = leg.details?.anchor || 'anchor';
    return `Deposit ${fromParsed.code} → Withdraw ${toParsed.code} via ${anchor}`;
  }
  return `Transfer ${fromParsed.code} → ${toParsed.code}`;
}

/**
 * Build high-level plan summary.
 */
function buildSummary(route, steps, fees, slippage, tolerancePercent) {
  const totalMinReceive = steps.length > 0
    ? steps[steps.length - 1].minReceiveAmount
    : '0';

  return {
    routeScore: route.score,
    totalSteps: steps.length,
    operationTypes: [...new Set(steps.map((s) => s.operation))],
    totalNetworkFeeXlm: fees.networkFeeXlm,
    effectiveFeeRate: fees.effectiveFeeRate,
    estimatedSlippage: `${slippage.totalSlippagePercent}%`,
    slippageSeverity: slippage.severity,
    slippageTolerance: `${tolerancePercent}%`,
    minFinalReceive: totalMinReceive,
    recommendation: buildRecommendation(route, slippage, fees),
  };
}

/**
 * Generate a recommendation for the user.
 */
function buildRecommendation(route, slippage, fees) {
  if (slippage.severity === 'extreme') {
    return 'WARNING: Extreme slippage expected. Consider reducing trade size or waiting for better liquidity.';
  }
  if (slippage.severity === 'high') {
    return 'CAUTION: High slippage expected. You may receive significantly less than quoted.';
  }
  if (route.score >= 0.8) {
    return 'This route has excellent quality. Proceed with confidence.';
  }
  if (route.score >= 0.5) {
    return 'Acceptable route quality. Review fees and slippage before proceeding.';
  }
  return 'This route has marginal quality. Check whether better alternatives exist.';
}
