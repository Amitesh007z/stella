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

  // Check graph is built — if not, wait up to 40s for it
  if (graph.buildVersion === 0) {
    log.info('Graph not yet built — waiting for initial build...');
    const waitStart = Date.now();
    const MAX_WAIT_MS = 40000;
    const POLL_MS = 1000;
    while (graph.buildVersion === 0 && Date.now() - waitStart < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    if (graph.buildVersion === 0) {
      throw Errors.noRoute('Route graph is still building — please wait a moment and retry');
    }
    log.info({ waitMs: Date.now() - waitStart }, 'Graph ready after wait');
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

  // ── 3b. Horizon enrichment — get real exchange rates ─
  // Graph estimates use flat multipliers (e.g. XLM_HUB = 0.98) which
  // make all routes show the same receive amount. Horizon strict-send
  // gives actual on-chain prices per route.
  await enrichRoutesWithHorizon(enrichedRoutes, srcKey, dstKey, amount);

  // ── 4. Re-score with receive amounts, then sort ─────
  // Now that we have real (or improved) receive amounts from Horizon,
  // recompute scores so receive amount is the dominant ranking factor.
  const bestReceive = Math.max(
    ...enrichedRoutes.map(r => parseFloat(r.receiveAmount) || 0)
  );
  for (const route of enrichedRoutes) {
    const amountCtx = {
      receiveAmount: parseFloat(route.receiveAmount) || 0,
      sendAmount: parseFloat(amount) || 0,
      bestReceive,
    };
    // Re-run scoring with amount context using the original pathResult data
    const pathResult = {
      edges: route.legs.map(leg => ({
        type: leg.type,
        weight: leg.weight,
        askDepth: leg.details?.askDepth,
        anchorHealth: leg.details?.health,
      })),
      totalWeight: route.totalWeight,
      hops: route.hops,
    };
    const newScoring = computeRouteScore(pathResult, amountCtx);
    route.scoring = newScoring;
    route.score = newScoring.composite;
  }
  enrichedRoutes.sort((a, b) => b.score - a.score);

  // ── 5. Tag data quality on each route ───────────────
  for (const route of enrichedRoutes) {
    if (route.horizonValidated) {
      route.priceSource = 'horizon';
    } else if (route.unverified) {
      route.priceSource = 'unverified';
    } else if (route.horizonEstimated) {
      route.priceSource = 'estimated';
    } else {
      route.priceSource = 'graph';
    }
  }

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
 *   - Receive amount (40%) — higher receive = higher score (DOMINANT)
 *   - Weight efficiency (15%) — lower total weight = higher score
 *   - Hop efficiency (15%) — fewer hops = higher score
 *   - Liquidity (15%) — deeper orderbooks along the path
 *   - Reliability (15%) — anchor health + edge freshness
 *
 * @param {object} pathResult - The pathfinder result with edges, totalWeight, hops.
 * @param {object} [amountCtx] - Optional context for receive-amount scoring.
 * @param {number} amountCtx.receiveAmount - This route's receive amount.
 * @param {number} amountCtx.sendAmount    - The original send amount (used as normalization ceiling).
 * @param {number} amountCtx.bestReceive   - Best receive amount across all routes in this batch.
 */
function computeRouteScore(pathResult, amountCtx = null) {
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

  // ── Receive-amount score (0-1) ──────────────────────
  // Normalized against the best receive amount in this batch.
  // If amountCtx is not provided (pre-enrichment), fall back to
  // the old topology-only composite so initial sorting still works.
  let amountScore = 0;
  let hasAmountCtx = false;
  if (amountCtx && amountCtx.bestReceive > 0) {
    hasAmountCtx = true;
    amountScore = Math.min(1, amountCtx.receiveAmount / amountCtx.bestReceive);
  }

  // ── Composite ───────────────────────────────────────
  let composite;
  if (hasAmountCtx) {
    // Post-enrichment: receive amount is the dominant factor
    composite = +(
      amountScore      * 0.40 +
      weightScore      * 0.15 +
      hopScore         * 0.15 +
      liquidityScore   * 0.15 +
      reliabilityScore * 0.15
    ).toFixed(4);
  } else {
    // Pre-enrichment fallback (topology only, used for initial ordering)
    composite = +(
      weightScore      * 0.30 +
      hopScore         * 0.25 +
      liquidityScore   * 0.20 +
      reliabilityScore * 0.25
    ).toFixed(4);
  }

  return {
    composite,
    amount: +amountScore.toFixed(4),
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
// HORIZON ENRICHMENT — Real exchange rates
// ═══════════════════════════════════════════════════════════════

/**
 * Query Horizon strict-send to get real on-chain exchange rates for
 * each route, replacing the rough graph-based estimates.
 *
 * Strategy:
 *   1. For routes that go entirely through DEX/XLM_HUB edges,
 *      query Horizon strict-send from source→dest and use the best
 *      matching path's `destination_amount`.
 *   2. For routes with ANCHOR_BRIDGE legs, split the estimation:
 *      - DEX/hub legs: use Horizon prices for sub-segments
 *      - Bridge legs: apply fee deductions
 *   3. On any Horizon failure, keep the graph estimate (graceful degradation).
 *
 * @param {RouteManifest[]} routes - Routes to enrich (mutated in place).
 * @param {string} srcKey - Source asset key.
 * @param {string} dstKey - Destination asset key.
 * @param {string} amount - Send amount.
 */
async function enrichRoutesWithHorizon(routes, srcKey, dstKey, amount) {
  if (routes.length === 0) return;

  const srcParsed = parseAssetKey(srcKey);
  const dstParsed = parseAssetKey(dstKey);

  const sourceAsset = srcParsed.issuer
    ? new StellarSdk.Asset(srcParsed.code, srcParsed.issuer)
    : StellarSdk.Asset.native();

  // Collect all unique destination assets we need prices for.
  // For multi-hop routes with anchor bridges, we may need intermediate prices too.
  const destAssets = new Set();
  const intermediateQueries = [];  // { routeIdx, segments[] }

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const hasBridge = route.edgeTypes?.includes('anchor_bridge');

    if (!hasBridge) {
      // Pure DEX/hub route → query source→dest directly
      destAssets.add(dstKey);
    } else {
      // Route with anchor bridges → break into segments between bridge legs
      // and query each DEX/hub segment separately
      const segments = splitRouteSegments(route);
      if (segments.length > 0) {
        intermediateQueries.push({ routeIdx: i, segments });
        for (const seg of segments) {
          if (seg.type === 'market') {
            destAssets.add(seg.destKey);
          }
        }
      }
    }
  }

  // ── Query 1: Main source→dest strict-send ─────────────
  let horizonPaths = [];
  try {
    const destAssetObj = dstParsed.issuer
      ? new StellarSdk.Asset(dstParsed.code, dstParsed.issuer)
      : StellarSdk.Asset.native();

    const result = await withTimeout(
      findStrictSendPaths({
        sourceAsset,
        sourceAmount: amount,
        destinationAssets: [destAssetObj],
      }),
      HORIZON_ENRICH_TIMEOUT_MS
    );
    horizonPaths = result?.records || [];
    log.debug({ pathCount: horizonPaths.length }, 'Horizon enrichment: strict-send paths received');
  } catch (err) {
    log.debug({ err: err.message }, 'Horizon enrichment: strict-send failed (using graph estimates)');
  }

  // ── Match Horizon paths to graph routes ────────────────
  // For non-bridge routes, try to find a matching Horizon path
  // by comparing intermediate assets. If no exact match, use the
  // best (highest destination_amount) Horizon path as a baseline.
  const bestHorizonAmount = horizonPaths.length > 0
    ? Math.max(...horizonPaths.map(p => parseFloat(p.destination_amount)))
    : null;

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const hasBridge = route.edgeTypes?.includes('anchor_bridge');

    if (!hasBridge) {
      // Try exact intermediate match first
      const matchedPath = findMatchingHorizonPath(route, horizonPaths);

      if (matchedPath) {
        const oldAmt = route.receiveAmount;
        route.receiveAmount = matchedPath.destination_amount;
        route.horizonValidated = true;
        log.debug({
          routeId: route.id,
          old: oldAmt,
          new: route.receiveAmount,
        }, 'Horizon enrichment: exact match for route');
      }
      // If Horizon returned paths but none matched this route,
      // this route has no real on-chain liquidity for its specific path.
      // DON'T assign the best Horizon amount — leave it with graph estimate
      // and mark it as unverified so the fallback pass can handle it.
    } else {
      // Route with bridges — enrich segment by segment
      await enrichBridgeRoute(route, intermediateQueries.find(q => q.routeIdx === i), amount);

      // Fallback: if segment enrichment didn't work, use the main Horizon
      // source→dest query adjusted by weight ratio and bridge fees.
      if (!route.horizonValidated && bestHorizonAmount !== null) {
        // Calculate total bridge fees from this route's legs
        let feeDeduction = 1.0;
        for (const leg of (route.legs || [])) {
          if (leg.type === 'anchor_bridge') {
            const feeFixed = leg.details?.feeFixed || 0;
            const feePercent = leg.details?.feePercent || 0;
            feeDeduction *= (1 - feePercent / 100);
            // Fixed fee as proportion of amount
            if (feeFixed > 0) {
              feeDeduction *= Math.max(0, 1 - feeFixed / parseFloat(amount));
            }
          }
        }

        // Weight-based adjustment: heavier routes = worse rate
        const baseRoute = routes.find(r => r.horizonValidated && !r.edgeTypes?.includes('anchor_bridge'));
        const baseWeight = baseRoute ? baseRoute.totalWeight : 0.4;
        const weightPenalty = route.totalWeight > baseWeight
          ? 1 / (1 + (route.totalWeight - baseWeight) * 0.3)
          : 1;

        const adjusted = bestHorizonAmount * feeDeduction * weightPenalty;
        route.receiveAmount = adjusted.toFixed(7);
        route.horizonEstimated = true; // Not exact, but better than flat 0.98
        log.debug({
          routeId: route.id,
          adjusted: route.receiveAmount,
          feeDeduction,
          weightPenalty,
        }, 'Horizon enrichment: bridge route fallback estimate');
      }
    }
  }

  // ── Final fallback pass ────────────────────────────────
  // For any route still not enriched by Horizon or bridge segment pricing,
  // derive a penalized estimate from the best enriched route.
  // These routes have no proven on-chain liquidity, so apply a meaningful
  // discount to reflect uncertainty.
  const enrichedBest = routes
    .filter(r => (r.horizonValidated || r.horizonEstimated) && parseFloat(r.receiveAmount) > 0)
    .sort((a, b) => parseFloat(b.receiveAmount) - parseFloat(a.receiveAmount))[0];

  if (enrichedBest) {
    const bestAmt = parseFloat(enrichedBest.receiveAmount);
    for (const route of routes) {
      if (route.horizonValidated || route.horizonEstimated) continue;

      // This route has NO Horizon validation — its graph-estimate receive
      // amount is unreliable. Derive from the best enriched route with a
      // significant penalty: weight-based + base 15% uncertainty discount.
      const bestW = enrichedBest.totalWeight || 1;
      const thisW = route.totalWeight || 1;
      const weightRatio = thisW / bestW;
      // Base 15% penalty for unverified route + weight-based scaling
      const uncertaintyPenalty = 0.85;
      const weightPenalty = 1 / (1 + Math.max(0, weightRatio - 1) * 0.5);
      const adjusted = bestAmt * uncertaintyPenalty * weightPenalty;
      route.receiveAmount = adjusted.toFixed(7);
      route.horizonEstimated = true;
      route.unverified = true;
      log.debug({
        routeId: route.id,
        derived: route.receiveAmount,
        fromBest: enrichedBest.id,
        weightRatio,
        uncertaintyPenalty,
      }, 'Horizon enrichment: fallback derived (unverified route)');
    }
  }
}

/**
 * Split a route with anchor bridges into market segments and bridge segments.
 * Market segments are consecutive DEX/XLM_HUB legs;
 * Bridge segments are ANCHOR_BRIDGE legs (fees only, no market price).
 */
function splitRouteSegments(route) {
  const segments = [];
  let currentMarketStart = null;

  for (const leg of (route.legs || [])) {
    if (leg.type === 'anchor_bridge') {
      // If we were in a market segment, close it
      if (currentMarketStart) {
        segments.push({
          type: 'market',
          srcKey: currentMarketStart,
          destKey: leg.from,
        });
        currentMarketStart = null;
      }
      segments.push({
        type: 'bridge',
        feeFixed: leg.details?.feeFixed || 0,
        feePercent: leg.details?.feePercent || 0,
        srcKey: leg.from,
        destKey: leg.to,
      });
    } else {
      if (!currentMarketStart) {
        currentMarketStart = leg.from;
      }
    }
  }

  // Close trailing market segment
  if (currentMarketStart && route.legs?.length > 0) {
    const lastLeg = route.legs[route.legs.length - 1];
    if (lastLeg.type !== 'anchor_bridge') {
      segments.push({
        type: 'market',
        srcKey: currentMarketStart,
        destKey: lastLeg.to,
      });
    }
  }

  return segments;
}

/**
 * Enrich a route that has anchor bridge legs.
 * For each segment:
 *   - Market segments: query Horizon strict-send
 *   - Bridge segments: deduct fees
 */
async function enrichBridgeRoute(route, queryInfo, amount) {
  if (!queryInfo || !queryInfo.segments || queryInfo.segments.length === 0) return;

  let currentAmount = parseFloat(amount);
  let anyEnriched = false;

  for (const segment of queryInfo.segments) {
    if (segment.type === 'bridge') {
      // Apply fees
      currentAmount -= segment.feeFixed;
      currentAmount *= (1 - (segment.feePercent || 0) / 100);
      currentAmount = Math.max(0, currentAmount);
    } else if (segment.type === 'market') {
      // Try Horizon for this segment
      try {
        const srcParsed = parseAssetKey(segment.srcKey);
        const dstParsed = parseAssetKey(segment.destKey);

        const srcAsset = srcParsed.issuer
          ? new StellarSdk.Asset(srcParsed.code, srcParsed.issuer)
          : StellarSdk.Asset.native();
        const dstAsset = dstParsed.issuer
          ? new StellarSdk.Asset(dstParsed.code, dstParsed.issuer)
          : StellarSdk.Asset.native();

        const result = await withTimeout(
          findStrictSendPaths({
            sourceAsset: srcAsset,
            sourceAmount: currentAmount.toFixed(7),
            destinationAssets: [dstAsset],
          }),
          HORIZON_ENRICH_TIMEOUT_MS
        );

        const records = result?.records || [];
        if (records.length > 0) {
          // Use the best path (highest destination amount)
          const best = records.reduce((a, b) =>
            parseFloat(a.destination_amount) > parseFloat(b.destination_amount) ? a : b
          );
          currentAmount = parseFloat(best.destination_amount);
          anyEnriched = true;
        }
      } catch (err) {
        log.debug({ segment, err: err.message }, 'Horizon enrichment for segment failed');
        // Keep the current estimate from graph-based calculation
      }
    }
  }

  if (anyEnriched) {
    route.receiveAmount = currentAmount.toFixed(7);
    route.horizonValidated = true;
  }
}

/**
 * Find a Horizon path that matches a graph route's intermediate stops.
 */
function findMatchingHorizonPath(route, horizonPaths) {
  if (!horizonPaths || horizonPaths.length === 0) return null;

  // Extract intermediate asset keys from the route (excluding source and dest)
  const routeIntermediates = (route.path || []).slice(1, -1).map(p => p.key);

  for (const hp of horizonPaths) {
    const hpIntermediates = (hp.path || []).map(p => {
      if (p.asset_type === 'native') return 'XLM:native';
      return assetKey(p.asset_code, p.asset_issuer);
    });

    // Check if intermediates match in order
    if (routeIntermediates.length === hpIntermediates.length &&
      routeIntermediates.every((k, idx) => k === hpIntermediates[idx])) {
      return hp;
    }
  }

  // No exact match — return the best Horizon path (highest dest amount)
  // This is still better than the flat 0.98 estimate
  if (horizonPaths.length > 0 && routeIntermediates.length === 0) {
    // Direct path (no intermediates) — use best Horizon result
    return horizonPaths.reduce((a, b) =>
      parseFloat(a.destination_amount) > parseFloat(b.destination_amount) ? a : b
    );
  }

  return null;
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
      } else {
        // No orderbook data — use weight as a proxy for conversion rate.
        // Lower weight = better route, so use 1/weight as approximate rate.
        // Clamp to avoid crazy values.
        const weightProxy = edge.weight > 0 ? Math.min(2, 1 / edge.weight) : 0.5;
        currentAmount *= weightProxy;
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
      sep24Supported: edge.sep24Supported,
      sep10Supported: edge.sep10Supported,
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
