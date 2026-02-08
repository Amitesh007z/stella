// ─── Stella Protocol — Route Resolver ─────────────────────────
// Takes a user query (source asset, destination asset, amount)
// and produces scored, ranked Route Manifests.
//
// Pipeline:
//   1. Validate inputs — check assets exist in graph
//   2. Run k-shortest pathfinder on the Route Graph
//   3. Enrich each path with estimated amounts via Horizon
//   4. Score and rank — assemble final Route Manifest
//
// The output is a deterministic, protocol-neutral route manifest
// that can drive any execution strategy.

import { findKShortestPaths } from './pathfinder.js';
import { findStrictSendPaths, StellarSdk } from '../../lib/horizon.js';
import graph, { assetKey, parseAssetKey, EdgeType, formatEdge } from '../graph/routeGraph.js';
import { getAssetByIdentifier } from '../asset/assetRepository.js';
import config from '../../config/index.js';
import { Errors } from '../../plugins/errorHandler.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('route-resolver');

// ─── Horizon Enrichment Timeout ───────────────────────────────
const HORIZON_ENRICH_TIMEOUT_MS = 10000;

/**
 * @typedef {object} RouteQuery
 * @property {string} sourceCode   - Source asset code (e.g. "USDC")
 * @property {string} sourceIssuer - Source asset issuer (null for XLM)
 * @property {string} destCode     - Destination asset code
 * @property {string} destIssuer   - Destination asset issuer (null for XLM)
 * @property {string} amount       - Amount to send (string, not float)
 * @property {string} [mode]       - "send" (fixed source amount) or "receive" (fixed dest amount)
 * @property {number} [maxHops]    - Override max hops
 * @property {number} [maxRoutes]  - Override max results
 */

/**
 * @typedef {object} RouteManifest
 * @property {string}   id          - Unique route ID
 * @property {string}   sourceAsset - Source asset key
 * @property {string}   destAsset   - Destination asset key
 * @property {string}   sendAmount  - Amount being sent
 * @property {string}   receiveAmount - Estimated receive amount
 * @property {number}   hops        - Number of intermediate steps
 * @property {object[]} path        - Ordered asset stops
 * @property {object[]} legs        - Detailed leg data (edges)
 * @property {number}   score       - Composite quality score (0-1)
 * @property {object}   scoring     - Score breakdown
 * @property {string}   computedAt  - ISO timestamp
 * @property {number}   ttlSeconds  - How long this quote is valid
 */

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════

/**
 * Find routes between two assets.
 *
 * @param {RouteQuery} query
 * @returns {Promise<{routes: RouteManifest[], meta: object}>}
 */
export async function findRoutes(query) {
  const startTime = Date.now();

  const {
    sourceCode, sourceIssuer,
    destCode, destIssuer,
    amount,
    mode = 'send',
    maxHops = config.maxHops,
    maxRoutes = config.maxRoutesPerDest,
  } = query;

  // ── 1. Validate inputs ──────────────────────────────
  const srcKey = assetKey(sourceCode, sourceIssuer);
  const dstKey = assetKey(destCode, destIssuer);

  log.info({
    source: srcKey,
    dest: dstKey,
    amount,
    mode,
  }, 'Route query received');

  // Check graph is built
  if (graph.buildVersion === 0) {
    throw Errors.noRoute('Route graph not yet built — please wait and retry');
  }

  // Validate source and dest exist in graph (or at least in asset registry)
  if (!graph.hasNode(srcKey)) {
    // Try to see if it exists in the asset DB even if not in graph
    const assetRecord = getAssetByIdentifier(sourceCode, sourceIssuer);
    if (!assetRecord) {
      throw Errors.badRequest(`Source asset not found: ${srcKey}`);
    }
    throw Errors.noRoute(`Source asset ${srcKey} exists but has no active trading relationships`);
  }

  if (!graph.hasNode(dstKey)) {
    const assetRecord = getAssetByIdentifier(destCode, destIssuer);
    if (!assetRecord) {
      throw Errors.badRequest(`Destination asset not found: ${dstKey}`);
    }
    throw Errors.noRoute(`Destination asset ${dstKey} exists but has no active trading relationships`);
  }

  if (srcKey === dstKey) {
    throw Errors.badRequest('Source and destination assets must be different');
  }

  // ── 2. Run pathfinder ───────────────────────────────
  log.debug('Running k-shortest path search...');
  const graphPaths = findKShortestPaths(srcKey, dstKey, {
    k: maxRoutes,
    maxHops,
  });

  if (graphPaths.length === 0) {
    // Fallback: try Horizon strict-send directly
    log.debug('No graph paths found — trying Horizon strict-send fallback...');
    const horizonRoutes = await tryHorizonFallback(srcKey, dstKey, amount, mode);
    if (horizonRoutes.length > 0) {
      const durationMs = Date.now() - startTime;
      return {
        routes: horizonRoutes,
        meta: buildMeta(srcKey, dstKey, amount, mode, horizonRoutes.length, durationMs, 'horizon_fallback'),
      };
    }
    throw Errors.noRoute(`No route found from ${srcKey} to ${dstKey}`);
  }

  // ── 3. Enrich each path ─────────────────────────────
  log.debug({ pathCount: graphPaths.length }, 'Enriching graph paths...');
  const enrichedRoutes = [];

  for (const pathResult of graphPaths) {
    const manifest = buildManifest(pathResult, amount, mode);
    enrichedRoutes.push(manifest);
  }

  // ── 4. Score and sort ───────────────────────────────
  enrichedRoutes.sort((a, b) => b.score - a.score);

  const durationMs = Date.now() - startTime;
  log.info({
    routes: enrichedRoutes.length,
    bestScore: enrichedRoutes[0]?.score,
    durationMs,
  }, 'Route resolution complete');

  return {
    routes: enrichedRoutes.slice(0, maxRoutes),
    meta: buildMeta(srcKey, dstKey, amount, mode, enrichedRoutes.length, durationMs, 'graph'),
  };
}

// ═══════════════════════════════════════════════════════════════
// ROUTE MANIFEST BUILDER
// ═══════════════════════════════════════════════════════════════

/**
 * Build a fully detailed Route Manifest from a pathfinder result.
 */
function buildManifest(pathResult, amount, mode) {
  const { path, edges, totalWeight, hops, edgeTypes } = pathResult;

  // Build ordered stops
  const stops = path.map((key) => {
    const node = graph.getNode(key);
    const parsed = parseAssetKey(key);
    return {
      key,
      code: parsed.code,
      issuer: parsed.issuer,
      domain: node?.domain || null,
      name: node?.name || null,
      isNative: !parsed.issuer,
    };
  });

  // Build leg details
  const legs = edges.map((edge, idx) => ({
    step: idx + 1,
    from: edge.source,
    to: edge.target,
    type: edge.type,
    weight: edge.weight,
    details: formatLegDetails(edge),
  }));

  // ── Scoring ─────────────────────────────────────────
  const scoring = computeRouteScore(pathResult);

  // ── Estimate receive amount ─────────────────────────
  // For graph-only routes (no Horizon validation yet), we provide
  // a rough estimate based on edge data. Phase 6 will add
  // real-time Horizon strict-send verification.
  const estimatedReceive = estimateReceiveAmount(edges, amount, mode);

  const routeId = generateRouteId(path, amount);

  return {
    id: routeId,
    sourceAsset: path[0],
    destAsset: path[path.length - 1],
    sendAmount: amount,
    receiveAmount: estimatedReceive,
    hops,
    path: stops,
    legs,
    edgeTypes,
    score: scoring.composite,
    scoring,
    totalWeight: +totalWeight.toFixed(6),
    computedAt: new Date().toISOString(),
    ttlSeconds: 30,
    graphVersion: graph.buildVersion,
  };
}

// ═══════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a composite quality score for a route (0-1, higher is better).
 *
 * Factors:
 *   - Weight efficiency (35%) — lower total weight = higher score
 *   - Hop efficiency (25%) — fewer hops = higher score
 *   - Liquidity (20%) — deeper orderbooks along the path
 *   - Reliability (20%) — anchor health + edge freshness
 */
function computeRouteScore(pathResult) {
  const { edges, totalWeight, hops } = pathResult;

  // ── Weight efficiency (0-1) ─────────────────────────
  // Normalize: weight of 0.1 → 1.0, weight of 5.0 → ~0.0
  const weightScore = Math.max(0, 1 - (totalWeight / 5));

  // ── Hop efficiency (0-1) ────────────────────────────
  // 1 hop = 1.0, 2 hops = 0.75, 3 = 0.5, 4 = 0.25
  const hopScore = Math.max(0, 1 - ((hops - 1) * 0.25));

  // ── Liquidity score (0-1) ───────────────────────────
  let liquidityScore = 0;
  const dexEdges = edges.filter((e) => e.type === EdgeType.DEX);
  const xlmHubEdges = edges.filter((e) => e.type === EdgeType.XLM_HUB);
  if (dexEdges.length > 0) {
    const avgDepth = dexEdges.reduce((sum, e) => sum + (e.askDepth || 0), 0) / dexEdges.length;
    // Normalize: 1000 units depth → 1.0
    liquidityScore = Math.min(1, avgDepth / 1000);
  } else if (xlmHubEdges.length > 0) {
    // XLM hub routes have estimated liquidity (lower than real DEX data)
    liquidityScore = 0.2;
  } else {
    // No DEX edges — give a small base score for bridge-only routes
    liquidityScore = 0.3;
  }

  // ── Reliability score (0-1) ─────────────────────────
  const bridgeEdges = edges.filter((e) => e.type === EdgeType.ANCHOR_BRIDGE);
  let reliabilityScore = 1.0;
  if (bridgeEdges.length > 0) {
    const avgHealth = bridgeEdges.reduce((sum, e) => sum + (e.anchorHealth || 0), 0) / bridgeEdges.length;
    reliabilityScore = avgHealth;
  }

  // ── Composite ───────────────────────────────────────
  const composite = +(
    weightScore * 0.35 +
    hopScore * 0.25 +
    liquidityScore * 0.20 +
    reliabilityScore * 0.20
  ).toFixed(4);

  return {
    composite,
    weight: +weightScore.toFixed(4),
    hops: +hopScore.toFixed(4),
    liquidity: +liquidityScore.toFixed(4),
    reliability: +reliabilityScore.toFixed(4),
  };
}

// ═══════════════════════════════════════════════════════════════
// HORIZON FALLBACK
// ═══════════════════════════════════════════════════════════════

/**
 * If the graph has no path, try Horizon's native strict-send/receive.
 * This covers paths that exist on-chain but weren't in our graph
 * (e.g., because we didn't query that specific orderbook pair).
 */
async function tryHorizonFallback(srcKey, dstKey, amount, mode) {
  try {
    const srcParsed = parseAssetKey(srcKey);
    const dstParsed = parseAssetKey(dstKey);

    const sourceAsset = srcParsed.issuer
      ? new StellarSdk.Asset(srcParsed.code, srcParsed.issuer)
      : StellarSdk.Asset.native();

    const destAsset = dstParsed.issuer
      ? new StellarSdk.Asset(dstParsed.code, dstParsed.issuer)
      : StellarSdk.Asset.native();

    const result = await withTimeout(
      findStrictSendPaths({
        sourceAsset,
        sourceAmount: amount,
        destinationAssets: [destAsset],
      }),
      HORIZON_ENRICH_TIMEOUT_MS
    );

    if (!result.records || result.records.length === 0) {
      return [];
    }

    // Convert Horizon paths to our RouteManifest format
    return result.records.slice(0, config.maxRoutesPerDest).map((record, idx) => {
      const horizonPath = buildHorizonManifest(record, srcKey, dstKey, amount, idx);
      return horizonPath;
    });
  } catch (err) {
    log.debug({ err: err.message }, 'Horizon fallback failed');
    return [];
  }
}

/**
 * Convert a Horizon strict-send path record to a RouteManifest.
 */
function buildHorizonManifest(record, srcKey, dstKey, amount, idx) {
  const intermediates = (record.path || []).map((p) => {
    const key = p.asset_type === 'native'
      ? 'XLM:native'
      : assetKey(p.asset_code, p.asset_issuer);
    return {
      key,
      code: p.asset_type === 'native' ? 'XLM' : p.asset_code,
      issuer: p.asset_type === 'native' ? null : p.asset_issuer,
      isNative: p.asset_type === 'native',
      domain: null,
      name: null,
    };
  });

  const srcParsed = parseAssetKey(srcKey);
  const dstParsed = parseAssetKey(dstKey);

  const fullPath = [
    { key: srcKey, code: srcParsed.code, issuer: srcParsed.issuer, isNative: !srcParsed.issuer, domain: null, name: null },
    ...intermediates,
    { key: dstKey, code: dstParsed.code, issuer: dstParsed.issuer, isNative: !dstParsed.issuer, domain: null, name: null },
  ];

  // Build legs from Horizon data
  const legs = [];
  for (let i = 0; i < fullPath.length - 1; i++) {
    legs.push({
      step: i + 1,
      from: fullPath[i].key,
      to: fullPath[i + 1].key,
      type: 'horizon_path',
      weight: 0, // Horizon paths are pre-validated
      details: { source: 'horizon_strict_send' },
    });
  }

  return {
    id: generateRouteId(fullPath.map((p) => p.key), amount) + `:h${idx}`,
    sourceAsset: srcKey,
    destAsset: dstKey,
    sendAmount: amount,
    receiveAmount: record.destination_amount,
    hops: fullPath.length - 1,
    path: fullPath,
    legs,
    edgeTypes: ['horizon_path'],
    score: 0.8, // Horizon-validated paths are reliable
    scoring: {
      composite: 0.8,
      weight: 0.8,
      hops: Math.max(0, 1 - ((fullPath.length - 2) * 0.25)),
      liquidity: 1.0, // Horizon validated
      reliability: 1.0,
    },
    totalWeight: 0,
    computedAt: new Date().toISOString(),
    ttlSeconds: 30,
    graphVersion: graph.buildVersion,
    source: 'horizon_fallback',
  };
}

// ═══════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════

/**
 * Rough estimate of receive amount based on edge data.
 * For DEX edges, we use the top ask price.
 * For bridge edges, we deduct fees.
 * NOTE: This is an estimate — Phase 6 adds Horizon validation.
 */
function estimateReceiveAmount(edges, amount, mode) {
  let currentAmount = parseFloat(amount);
  if (isNaN(currentAmount) || currentAmount <= 0) return '0';

  for (const edge of edges) {
    if (edge.type === EdgeType.DEX) {
      // Use top ask as conversion rate (selling source, buying dest)
      if (edge.topAsk > 0) {
        currentAmount *= edge.topAsk;
      }
      // Spread deduction
      currentAmount *= (1 - (edge.spread || 0));
    } else if (edge.type === EdgeType.ANCHOR_BRIDGE) {
      // Deduct bridge fees
      currentAmount -= (edge.feeFixed || 0);
      currentAmount *= (1 - (edge.feePercent || 0) / 100);
    } else if (edge.type === EdgeType.XLM_HUB) {
      // XLM hub edges are estimated — apply a conservative 2% spread estimate
      currentAmount *= 0.98;
    }
    // Floor at zero
    currentAmount = Math.max(0, currentAmount);
  }

  return currentAmount.toFixed(7);
}

/**
 * Format leg details based on edge type.
 */
function formatLegDetails(edge) {
  if (edge.type === EdgeType.DEX) {
    return {
      via: 'SDEX Orderbook',
      topBid: edge.topBid,
      topAsk: edge.topAsk,
      spread: edge.spread,
      bidDepth: edge.bidDepth,
      askDepth: edge.askDepth,
    };
  }
  if (edge.type === EdgeType.ANCHOR_BRIDGE) {
    return {
      via: `Anchor Bridge (${edge.anchorDomain})`,
      anchor: edge.anchorDomain,
      health: edge.anchorHealth,
      depositEnabled: edge.depositEnabled,
      withdrawEnabled: edge.withdrawEnabled,
      feeFixed: edge.feeFixed,
      feePercent: edge.feePercent,
    };
  }
  if (edge.type === EdgeType.XLM_HUB) {
    return {
      via: `XLM Hub (${edge.assetDomain || 'SDEX'})`,
      mechanism: 'xlm_hub',
      assetCode: edge.assetCode,
      estimated: true,
    };
  }
  return { via: edge.type };
}

/**
 * Generate a deterministic route ID.
 */
function generateRouteId(path, amount) {
  const pathStr = Array.isArray(path) ? path.join('>') : path;
  // Simple hash: first 8 chars of a pseudo-hash
  let hash = 0;
  const str = `${pathStr}:${amount}:${Date.now()}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 32-bit integer
  }
  return `rt_${Math.abs(hash).toString(36).padStart(8, '0')}`;
}

/**
 * Build response metadata.
 */
function buildMeta(srcKey, dstKey, amount, mode, routeCount, durationMs, strategy) {
  return {
    source: srcKey,
    destination: dstKey,
    amount,
    mode,
    routesFound: routeCount,
    strategy,
    graphVersion: graph.buildVersion,
    graphNodes: graph.nodes.size,
    graphEdges: graph.getStats().edges,
    computeTimeMs: durationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Timeout wrapper for promises.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

export { computeRouteScore, estimateReceiveAmount };
