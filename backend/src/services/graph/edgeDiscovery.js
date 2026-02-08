// ─── Stella Protocol — Edge Discovery Service ─────────────────
// Discovers tradable relationships between assets and produces
// weighted edges for the Route Graph.
//
// Two discovery strategies:
//   1. DEX Edges     — fetch Horizon orderbooks for asset pairs
//   2. Anchor Bridge — connect deposit/withdraw assets via anchors
//
// Hub-and-spoke optimization: every non-native asset is checked
// against XLM first (the universal liquidity hub), then cross-pairs
// within the same anchor domain.

import { getOrderbook, StellarSdk } from '../../lib/horizon.js';
import { getAnchors, getAnchorAssets } from '../anchor/anchorRepository.js';
import config from '../../config/index.js';
import { createLogger } from '../../lib/logger.js';
import { EdgeType, assetKey } from './routeGraph.js';

const log = createLogger('edge-discovery');

// ─── Constants ────────────────────────────────────────────────
const MAX_CONCURRENCY = 3;          // Concurrent Horizon requests
const ORDERBOOK_LIMIT = 20;         // Depth per side
const MIN_DEPTH_THRESHOLD = 0;      // Minimum depth to create edge (0 = any)
const ORDERBOOK_TIMEOUT_MS = 8000;  // Per-request timeout

// ─── Weight Tuning ────────────────────────────────────────────
const WEIGHT = Object.freeze({
  DEX_BASE:            0.1,    // Base cost per DEX hop
  SPREAD_MULTIPLIER:   2.0,    // How much spread increases weight
  LIQUIDITY_BONUS:     0.5,    // Max weight reduction for deep liquidity
  BRIDGE_BASE:         0.3,    // Base cost per anchor bridge hop (higher = less preferred)
  HEALTH_PENALTY:      0.5,    // Weight added for unhealthy anchors
  FEE_MULTIPLIER:      1.0,    // Weight added per % fee
  XLM_HUB_BASE:        0.4,   // Base cost for fallback XLM hub edge (higher than DEX/bridge = less preferred)
  XLM_HUB_UNVERIFIED:  0.2,   // Extra penalty for unverified assets
});

// ═══════════════════════════════════════════════════════════════
// 1. DEX EDGE DISCOVERY
// ═══════════════════════════════════════════════════════════════

/**
 * Discover DEX edges for a set of routable assets.
 * Strategy: Hub-and-spoke via XLM + intra-anchor cross-pairs.
 *
 * @param {Array} routableAssets — from assetRepository.getRoutableAssets()
 * @returns {Promise<Array<DexEdgeResult>>}
 */
export async function discoverDexEdges(routableAssets) {
  const startTime = Date.now();
  const edges = [];
  const pairs = buildPairList(routableAssets);

  log.info({ pairCount: pairs.length }, 'Querying orderbooks for DEX edges...');

  // Process pairs with concurrency control
  const results = await processWithConcurrency(pairs, MAX_CONCURRENCY, async (pair) => {
    try {
      return await fetchOrderbookEdge(pair);
    } catch (err) {
      log.debug({ pair: `${pair.sellingKey}/${pair.buyingKey}`, err: err.message }, 'Orderbook query failed');
      return null;
    }
  });

  for (const result of results) {
    if (result) {
      edges.push(result);
    }
  }

  const durationMs = Date.now() - startTime;
  log.info({
    pairs: pairs.length,
    edgesFound: edges.length,
    durationMs,
  }, 'DEX edge discovery complete');

  return edges;
}

/**
 * Build the list of asset pairs to query.
 * Hub-and-spoke: every non-XLM asset vs XLM, plus intra-anchor pairs.
 */
function buildPairList(assets) {
  const pairs = [];
  const seen = new Set();
  const XLM_KEY = 'XLM:native';

  const nonNativeAssets = assets.filter((a) => a.asset_type !== 'native' && a.issuer);

  // ── Strategy 1: Every asset vs XLM (hub-and-spoke) ────
  for (const asset of nonNativeAssets) {
    const key = assetKey(asset.code, asset.issuer);
    const pairId = [key, XLM_KEY].sort().join('|');
    if (!seen.has(pairId)) {
      seen.add(pairId);
      pairs.push({
        selling: toSdkAsset(asset),
        buying: new StellarSdk.Asset.native(),
        sellingKey: key,
        buyingKey: XLM_KEY,
      });
    }
  }

  // ── Strategy 2: Intra-anchor cross-pairs ──────────────
  // Assets from same anchor may have direct liquidity
  const byDomain = groupByDomain(nonNativeAssets);
  for (const [domain, domainAssets] of Object.entries(byDomain)) {
    if (domainAssets.length < 2) continue;

    for (let i = 0; i < domainAssets.length; i++) {
      for (let j = i + 1; j < domainAssets.length; j++) {
        const a = domainAssets[i];
        const b = domainAssets[j];
        const keyA = assetKey(a.code, a.issuer);
        const keyB = assetKey(b.code, b.issuer);
        const pairId = [keyA, keyB].sort().join('|');

        if (!seen.has(pairId)) {
          seen.add(pairId);
          pairs.push({
            selling: toSdkAsset(a),
            buying: toSdkAsset(b),
            sellingKey: keyA,
            buyingKey: keyB,
          });
        }
      }
    }
    log.debug({ domain, crossPairs: domainAssets.length * (domainAssets.length - 1) / 2 },
      'Intra-anchor cross-pairs queued');
  }

  return pairs;
}

/**
 * Fetch a single orderbook and produce edge data.
 */
async function fetchOrderbookEdge(pair) {
  const orderbook = await withTimeout(
    getOrderbook(pair.selling, pair.buying, ORDERBOOK_LIMIT),
    ORDERBOOK_TIMEOUT_MS
  );

  const bids = orderbook.bids || [];
  const asks = orderbook.asks || [];

  // Skip empty orderbooks
  if (bids.length === 0 && asks.length === 0) {
    return null;
  }

  const topBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
  const topAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
  const bidDepth = bids.reduce((sum, o) => sum + parseFloat(o.amount), 0);
  const askDepth = asks.reduce((sum, o) => sum + parseFloat(o.amount), 0);

  // Skip if depth is below threshold
  if (bidDepth < config.orderbookMinDepth && askDepth < config.orderbookMinDepth) {
    return null;
  }

  // Compute spread
  const spread = (topBid > 0 && topAsk > 0)
    ? Math.abs(topAsk - topBid) / topAsk
    : 1; // Max spread if one side is empty

  // Compute forward weight (selling → buying)
  const forwardWeight = computeDexWeight({ spread, depth: askDepth });
  // Compute reverse weight (buying → selling)
  const reverseWeight = computeDexWeight({ spread, depth: bidDepth });

  return {
    sourceKey: pair.sellingKey,
    targetKey: pair.buyingKey,
    type: EdgeType.DEX,
    forward: {
      topBid, topAsk, spread,
      bidDepth, askDepth,
      bidCount: bids.length,
      askCount: asks.length,
      weight: forwardWeight,
    },
    reverse: {
      topBid: topAsk > 0 ? 1 / topAsk : 0,
      topAsk: topBid > 0 ? 1 / topBid : 0,
      spread,
      bidDepth: askDepth,
      askDepth: bidDepth,
      bidCount: asks.length,
      askCount: bids.length,
      weight: reverseWeight,
    },
  };
}

/**
 * Compute weight for a DEX edge.
 * Lower weight = better route.
 */
function computeDexWeight({ spread, depth }) {
  const spreadPenalty = spread * WEIGHT.SPREAD_MULTIPLIER;
  const liquidityBonus = depth > 0
    ? WEIGHT.LIQUIDITY_BONUS * (1 - 1 / Math.log2(depth + 2))
    : 0;

  return Math.max(0.01, WEIGHT.DEX_BASE + spreadPenalty - liquidityBonus);
}

// ═══════════════════════════════════════════════════════════════
// 2. ANCHOR BRIDGE EDGE DISCOVERY
// ═══════════════════════════════════════════════════════════════

/**
 * Discover anchor bridge edges.
 * For each anchor with 2+ active assets that support deposit AND withdraw,
 * create bridge edges connecting those assets.
 *
 * @returns {Array<BridgeEdgeResult>}
 */
export function discoverAnchorBridgeEdges() {
  const startTime = Date.now();
  const edges = [];

  // Get all active anchors
  const anchors = getAnchors({ status: 'active', limit: 500 });

  for (const anchor of anchors) {
    const assets = getAnchorAssets(anchor.id);
    const bridgeableAssets = assets.filter(
      (a) => a.status !== 'inactive' && (a.is_deposit_enabled || a.is_withdraw_enabled) && a.issuer
    );

    if (bridgeableAssets.length < 2) continue;

    // Create edges between every pair of bridgeable assets
    for (let i = 0; i < bridgeableAssets.length; i++) {
      for (let j = i + 1; j < bridgeableAssets.length; j++) {
        const a = bridgeableAssets[i];
        const b = bridgeableAssets[j];

        const keyA = assetKey(a.code, a.issuer);
        const keyB = assetKey(b.code, b.issuer);

        const weight = computeBridgeWeight(anchor, a, b);

        // Check if this anchor actually supports SEP-24 interactive flows
        const sep24Supported = !!anchor.transfer_server_sep24;
        const sep10Supported = !!anchor.web_auth_endpoint;

        edges.push({
          sourceKey: keyA,
          targetKey: keyB,
          type: EdgeType.ANCHOR_BRIDGE,
          forward: {
            anchorDomain: anchor.domain,
            anchorHealth: anchor.health_score || 0,
            depositEnabled: !!a.is_deposit_enabled && !!b.is_withdraw_enabled,
            withdrawEnabled: !!a.is_withdraw_enabled && !!b.is_deposit_enabled,
            feeFixed: (a.fee_fixed || 0) + (b.fee_fixed || 0),
            feePercent: (a.fee_percent || 0) + (b.fee_percent || 0),
            sep24Supported,
            sep10Supported,
            weight,
          },
          reverse: {
            anchorDomain: anchor.domain,
            anchorHealth: anchor.health_score || 0,
            depositEnabled: !!b.is_deposit_enabled && !!a.is_withdraw_enabled,
            withdrawEnabled: !!b.is_withdraw_enabled && !!a.is_deposit_enabled,
            feeFixed: (a.fee_fixed || 0) + (b.fee_fixed || 0),
            feePercent: (a.fee_percent || 0) + (b.fee_percent || 0),
            sep24Supported,
            sep10Supported,
            weight,
          },
        });
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log.info({
    anchors: anchors.length,
    bridgeEdges: edges.length,
    durationMs,
  }, 'Anchor bridge edge discovery complete');

  return edges;
}

/**
 * Compute weight for an anchor bridge edge.
 */
function computeBridgeWeight(anchor, assetA, assetB) {
  const healthPenalty = (1 - (anchor.health_score || 0)) * WEIGHT.HEALTH_PENALTY;
  const feePenalty = ((assetA.fee_percent || 0) + (assetB.fee_percent || 0)) * WEIGHT.FEE_MULTIPLIER;

  return Math.max(0.01, WEIGHT.BRIDGE_BASE + healthPenalty + feePenalty);
}

// ═══════════════════════════════════════════════════════════════
// 3. XLM HUB EDGE DISCOVERY (Fallback)
// ═══════════════════════════════════════════════════════════════

/**
 * Create fallback XLM hub edges for every non-native routable asset.
 * On Stellar, XLM is the universal bridge currency — any asset can
 * theoretically be traded for XLM through the SDEX (path payments
 * route through XLM automatically).
 *
 * These edges have higher weight than real DEX/bridge edges, so they
 * are only used when no better direct path exists. They ensure the
 * graph is well-connected and enable multi-hop route discovery.
 *
 * IMPORTANT: Only creates edges where no DEX edge already exists
 * for the same pair (avoids duplicating real market data).
 *
 * @param {Array} routableAssets — from assetRepository.getRoutableAssets()
 * @param {Set<string>} existingDexPairs — Set of "keyA|keyB" strings for existing DEX edges
 * @returns {Array<XlmHubEdgeResult>}
 */
export function discoverXlmHubEdges(routableAssets, existingDexPairs = new Set()) {
  const startTime = Date.now();
  const edges = [];
  const XLM_KEY = 'XLM:native';

  const nonNativeAssets = routableAssets.filter(
    (a) => a.asset_type !== 'native' && a.issuer
  );

  for (const asset of nonNativeAssets) {
    const key = assetKey(asset.code, asset.issuer);
    const pairId = [key, XLM_KEY].sort().join('|');

    // Skip if a real DEX edge already exists for this pair
    if (existingDexPairs.has(pairId)) continue;

    const weight = computeXlmHubWeight(asset);

    edges.push({
      sourceKey: key,
      targetKey: XLM_KEY,
      type: EdgeType.XLM_HUB,
      forward: {
        mechanism: 'xlm_hub',
        assetCode: asset.code,
        assetDomain: asset.anchor_domain || asset.domain || 'unknown',
        estimated: true,
        weight,
      },
      reverse: {
        mechanism: 'xlm_hub',
        assetCode: asset.code,
        assetDomain: asset.anchor_domain || asset.domain || 'unknown',
        estimated: true,
        weight,
      },
    });
  }

  const durationMs = Date.now() - startTime;
  log.info({
    xlmHubEdges: edges.length,
    durationMs,
  }, 'XLM hub edge discovery complete');

  return edges;
}

/**
 * Compute weight for an XLM hub fallback edge.
 * Higher weight than real DEX edges so real data is always preferred.
 */
function computeXlmHubWeight(asset) {
  let weight = WEIGHT.XLM_HUB_BASE;

  // Unverified assets get extra penalty
  if (!asset.is_verified) {
    weight += WEIGHT.XLM_HUB_UNVERIFIED;
  }

  return weight;
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a DB asset record to a Stellar SDK Asset object.
 */
function toSdkAsset(asset) {
  if (asset.asset_type === 'native' || !asset.issuer) {
    return StellarSdk.Asset.native();
  }
  return new StellarSdk.Asset(asset.code, asset.issuer);
}

/**
 * Group assets by anchor domain.
 */
function groupByDomain(assets) {
  const groups = {};
  for (const a of assets) {
    const domain = a.anchor_domain || a.domain;
    if (!domain) continue;
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(a);
  }
  return groups;
}

/**
 * Concurrency-limited async processor.
 */
async function processWithConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const currentIdx = idx++;
      results[currentIdx] = await fn(items[currentIdx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Wrap a promise with a timeout.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

export { computeDexWeight, computeBridgeWeight, toSdkAsset, WEIGHT };
