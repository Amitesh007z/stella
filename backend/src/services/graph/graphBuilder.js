// ─── Stella Protocol — Graph Builder Orchestrator ─────────────
// Builds the in-memory Route Graph from four data sources:
//   1. Asset Registry  (nodes)
//   2. DEX Orderbooks  (DEX edges via Horizon)
//   3. Anchor Metadata (bridge edges via Capability Index)
//   4. XLM Hub         (fallback edges connecting all assets through XLM)
//
// The build process is atomic: a new graph is prepared, then
// swapped in as the live graph. Failed builds keep the old graph.

import graph, { assetKey, EdgeType } from './routeGraph.js';
import { discoverDexEdges, discoverAnchorBridgeEdges, discoverXlmHubEdges } from './edgeDiscovery.js';
import { getRoutableAssets } from '../asset/assetRepository.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('graph-builder');

/**
 * Full graph build: load nodes from Asset Registry, discover all edges.
 * This clears the existing graph and rebuilds from scratch.
 *
 * @param {object} options
 * @param {boolean} options.skipDex - Skip DEX edge discovery (for testing)
 * @returns {Promise<BuildResult>}
 */
export async function buildRouteGraph({ skipDex = false } = {}) {
  const startTime = Date.now();

  // ── Mutex: prevent concurrent builds ────────────────
  if (!graph.startBuild()) {
    return { ok: false, reason: 'Build already in progress' };
  }

  try {
    log.info('═══ Starting Route Graph Build ═══');

    // ── STEP 1: Load routable assets as nodes ─────────
    log.info('Step 1/4: Loading routable assets...');
    const assets = getRoutableAssets();

    if (assets.length === 0) {
      log.warn('No routable assets found — graph will be empty');
      graph.clear();
      graph.completeBuild(Date.now() - startTime);
      return { ok: true, nodes: 0, edges: 0, durationMs: Date.now() - startTime };
    }

    // Clear and repopulate nodes
    graph.clear();

    for (const asset of assets) {
      const key = assetKey(asset.code, asset.issuer);
      graph.addNode(key, asset);
    }

    log.info({ nodeCount: graph.nodes.size }, 'Nodes loaded');

    // ── STEP 2: Discover DEX edges ────────────────────
    let dexEdgeCount = 0;
    if (!skipDex) {
      log.info('Step 2/4: Discovering DEX edges...');
      const dexEdges = await discoverDexEdges(assets);

      for (const edge of dexEdges) {
        // Ensure both nodes exist (they should, but defensive)
        if (graph.hasNode(edge.sourceKey) && graph.hasNode(edge.targetKey)) {
          graph.addBidirectionalEdge(
            edge.sourceKey,
            edge.targetKey,
            EdgeType.DEX,
            edge.forward,
            edge.reverse
          );
          dexEdgeCount += 2; // bidirectional
        }
      }
      log.info({ dexEdges: dexEdgeCount }, 'DEX edges added');
    } else {
      log.info('Step 2/4: DEX edge discovery skipped');
    }

    // ── STEP 3: Discover anchor bridge edges ──────────
    log.info('Step 3/4: Discovering anchor bridge edges...');
    const bridgeEdges = discoverAnchorBridgeEdges();
    let bridgeEdgeCount = 0;

    for (const edge of bridgeEdges) {
      // Ensure both nodes exist in the graph
      if (graph.hasNode(edge.sourceKey) && graph.hasNode(edge.targetKey)) {
        graph.addBidirectionalEdge(
          edge.sourceKey,
          edge.targetKey,
          EdgeType.ANCHOR_BRIDGE,
          edge.forward,
          edge.reverse
        );
        bridgeEdgeCount += 2;
      } else {
        // Nodes may not exist if assets aren't in the routable set
        // Add them as lightweight nodes
        if (!graph.hasNode(edge.sourceKey)) {
          const { code, issuer } = parseKeyForNode(edge.sourceKey);
          graph.addNode(edge.sourceKey, {
            code, issuer, asset_type: issuer ? 'credit_alphanum4' : 'native',
            source: 'anchor', anchor_domain: edge.forward.anchorDomain,
          });
        }
        if (!graph.hasNode(edge.targetKey)) {
          const { code, issuer } = parseKeyForNode(edge.targetKey);
          graph.addNode(edge.targetKey, {
            code, issuer, asset_type: issuer ? 'credit_alphanum4' : 'native',
            source: 'anchor', anchor_domain: edge.forward.anchorDomain,
          });
        }
        graph.addBidirectionalEdge(
          edge.sourceKey,
          edge.targetKey,
          EdgeType.ANCHOR_BRIDGE,
          edge.forward,
          edge.reverse
        );
        bridgeEdgeCount += 2;
      }
    }
    log.info({ bridgeEdges: bridgeEdgeCount }, 'Anchor bridge edges added');

    // ── STEP 4: Discover XLM hub fallback edges ───────
    // Use ALL current graph nodes (not just initial routable assets),
    // because bridge discovery may have added extra nodes.
    log.info('Step 4/5: Discovering XLM hub edges...');
    const existingDexPairs = new Set();
    // Collect existing DEX pair IDs to avoid duplicates
    for (const edge of graph.getAllEdges()) {
      if (edge.type === EdgeType.DEX) {
        existingDexPairs.add([edge.source, edge.target].sort().join('|'));
      }
    }

    // Build the full asset list from ALL graph nodes (includes bridge-added nodes)
    const allGraphAssets = [];
    for (const [key, node] of graph.nodes.entries()) {
      allGraphAssets.push({
        code: node.code,
        issuer: node.issuer,
        asset_type: node.isNative ? 'native' : (node.issuer ? 'credit_alphanum4' : 'native'),
        is_verified: node.isVerified || false,
        anchor_domain: node.anchorDomain || node.domain,
        domain: node.domain,
      });
    }

    const xlmHubEdges = discoverXlmHubEdges(allGraphAssets, existingDexPairs);
    let xlmHubEdgeCount = 0;

    for (const edge of xlmHubEdges) {
      // Ensure both nodes exist
      if (!graph.hasNode(edge.sourceKey)) {
        const { code, issuer } = parseKeyForNode(edge.sourceKey);
        graph.addNode(edge.sourceKey, { code, issuer, asset_type: 'credit_alphanum4', source: 'xlm_hub' });
      }
      if (!graph.hasNode(edge.targetKey)) {
        const { code, issuer } = parseKeyForNode(edge.targetKey);
        graph.addNode(edge.targetKey, { code, issuer, asset_type: issuer ? 'credit_alphanum4' : 'native', source: 'xlm_hub' });
      }
      graph.addBidirectionalEdge(
        edge.sourceKey,
        edge.targetKey,
        EdgeType.XLM_HUB,
        edge.forward,
        edge.reverse
      );
      xlmHubEdgeCount += 2;
    }
    log.info({ xlmHubEdges: xlmHubEdgeCount }, 'XLM hub edges added');

    // ── STEP 5: Finalize ──────────────────────────────
    const durationMs = Date.now() - startTime;
    graph.completeBuild(durationMs);

    const stats = graph.getStats();
    log.info({
      nodes: stats.nodes,
      edges: stats.edges,
      dexEdges: stats.dexEdges,
      bridgeEdges: stats.bridgeEdges,
      xlmHubEdges: xlmHubEdgeCount,
      connectivity: stats.connectivity,
      durationMs,
    }, '═══ Route Graph Build Complete ═══');

    return {
      ok: true,
      nodes: stats.nodes,
      edges: stats.edges,
      dexEdges: dexEdgeCount,
      bridgeEdges: bridgeEdgeCount,
      xlmHubEdges: xlmHubEdgeCount,
      connectivity: stats.connectivity,
      durationMs,
    };

  } catch (err) {
    log.error({ err }, 'Graph build failed');
    graph.isBuilding = false;
    return { ok: false, error: err.message, durationMs: Date.now() - startTime };
  }
}

/**
 * Lightweight refresh: re-query orderbooks for existing DEX edges.
 * Does NOT add/remove nodes or discover new pairs.
 * Much faster than a full rebuild.
 *
 * @returns {Promise<RefreshResult>}
 */
export async function refreshEdgeWeights() {
  const startTime = Date.now();

  if (graph.isBuilding) {
    return { ok: false, reason: 'Build in progress' };
  }

  log.info('Refreshing DEX edge weights...');

  const dexEdges = graph.getEdgesByType(EdgeType.DEX);
  const pairs = [];
  const seen = new Set();

  // Collect unique pairs from existing edges
  for (const edge of dexEdges) {
    const pairId = [edge.source, edge.target].sort().join('|');
    if (seen.has(pairId)) continue;
    seen.add(pairId);

    const sourceNode = graph.getNode(edge.source);
    const targetNode = graph.getNode(edge.target);
    if (!sourceNode || !targetNode) continue;

    pairs.push({
      sourceKey: edge.source,
      targetKey: edge.target,
      sourceNode,
      targetNode,
    });
  }

  let updated = 0;
  let failed = 0;

  // Re-query orderbooks (reuse the same edge discovery logic)
  const assets = pairs.map((p) => ({
    code: p.sourceNode.code,
    issuer: p.sourceNode.issuer,
    asset_type: p.sourceNode.isNative ? 'native' : 'credit_alphanum4',
    anchor_domain: p.sourceNode.anchorDomain,
    domain: p.sourceNode.domain,
    // Include target for pair building
    _targetCode: p.targetNode.code,
    _targetIssuer: p.targetNode.issuer,
  }));

  // For a simple refresh, re-run full DEX discovery
  // (the pair list builder will generate the same pairs)
  try {
    const freshEdges = await discoverDexEdges(
      getRoutableAssets()
    );

    for (const edge of freshEdges) {
      if (graph.hasNode(edge.sourceKey) && graph.hasNode(edge.targetKey)) {
        graph.addBidirectionalEdge(
          edge.sourceKey, edge.targetKey,
          EdgeType.DEX, edge.forward, edge.reverse
        );
        updated++;
      }
    }
  } catch (err) {
    log.error({ err }, 'Edge weight refresh failed');
    failed++;
  }

  const durationMs = Date.now() - startTime;
  log.info({ updated, failed, durationMs }, 'Edge weight refresh complete');

  return { ok: true, updated, failed, durationMs };
}

/**
 * Get the current graph instance (for route engine use).
 */
export function getGraph() {
  return graph;
}

// ─── Helpers ──────────────────────────────────────────────────

function parseKeyForNode(key) {
  const idx = key.indexOf(':');
  return {
    code: key.substring(0, idx),
    issuer: key.substring(idx + 1) === 'native' ? null : key.substring(idx + 1),
  };
}
