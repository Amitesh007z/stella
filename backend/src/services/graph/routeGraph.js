// ─── Stella Protocol — Route Graph Data Structure ─────────────
// In-memory directed weighted graph for payment path discovery.
//
// Nodes  = Stellar assets  (keyed by "CODE:ISSUER" or "XLM:native")
// Edges  = Trading relationships (DEX orderbook, anchor bridge)
// Weight = Lower is better (computed from spread, liquidity, reliability)
//
// This is a singleton — one global graph instance shared across the app.
// Thread safety is ensured by atomic JavaScript execution + controlled rebuild.

import { createLogger } from '../../lib/logger.js';

const log = createLogger('route-graph');

// ─── Edge Types ───────────────────────────────────────────────
export const EdgeType = Object.freeze({
  DEX:            'dex',             // Stellar SDEX orderbook pair
  ANCHOR_BRIDGE:  'anchor_bridge',   // Deposit A → Withdraw B via anchor
  XLM_HUB:       'xlm_hub',         // Transitive via native XLM (implied)
});

// ─── Asset Key Helper ─────────────────────────────────────────
export function assetKey(code, issuer) {
  return issuer ? `${code}:${issuer}` : `${code}:native`;
}

export function parseAssetKey(key) {
  const idx = key.indexOf(':');
  const code = key.substring(0, idx);
  const issuer = key.substring(idx + 1);
  return { code, issuer: issuer === 'native' ? null : issuer };
}

// ─── Graph Node ───────────────────────────────────────────────
class GraphNode {
  constructor(key, assetData) {
    this.key = key;
    this.code = assetData.code;
    this.issuer = assetData.issuer || null;
    this.domain = assetData.domain || assetData.anchor_domain || null;
    this.name = assetData.name || null;
    this.isNative = assetData.asset_type === 'native' || !assetData.issuer;
    this.isVerified = !!assetData.is_verified;
    this.source = assetData.source;
    this.numAccounts = assetData.num_accounts || 0;
    this.isDepositEnabled = !!assetData.is_deposit_enabled;
    this.isWithdrawEnabled = !!assetData.is_withdraw_enabled;
    this.anchorDomain = assetData.anchor_domain || null;
    // Adjacency: Map<targetKey, Edge[]>
    this.edges = new Map();
  }
}

// ─── Graph Edge ───────────────────────────────────────────────
class GraphEdge {
  constructor({ source, target, type, metadata = {} }) {
    this.id = `${source}->${target}:${type}`;
    this.source = source;
    this.target = target;
    this.type = type;              // EdgeType enum

    // ── DEX fields ────────────────────────────────────
    this.topBid = metadata.topBid || 0;         // Best bid price
    this.topAsk = metadata.topAsk || 0;         // Best ask price
    this.spread = metadata.spread || 0;         // Bid-ask spread %
    this.bidDepth = metadata.bidDepth || 0;     // Total bid volume
    this.askDepth = metadata.askDepth || 0;     // Total ask volume
    this.bidCount = metadata.bidCount || 0;     // Number of bid orders
    this.askCount = metadata.askCount || 0;     // Number of ask orders

    // ── Anchor bridge fields ──────────────────────────
    this.anchorDomain = metadata.anchorDomain || null;
    this.anchorHealth = metadata.anchorHealth || 0;
    this.depositEnabled = metadata.depositEnabled ?? false;
    this.withdrawEnabled = metadata.withdrawEnabled ?? false;
    this.feeFixed = metadata.feeFixed || 0;
    this.feePercent = metadata.feePercent || 0;

    // ── Common ────────────────────────────────────────
    this.weight = metadata.weight || Infinity;  // Pathfinding cost
    this.lastUpdated = new Date().toISOString();
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE GRAPH — Singleton
// ═══════════════════════════════════════════════════════════════

class RouteGraph {
  constructor() {
    /** @type {Map<string, GraphNode>} */
    this.nodes = new Map();
    this.buildVersion = 0;
    this.lastBuildTime = null;
    this.lastBuildDurationMs = 0;
    this.isBuilding = false;
    this._edgeCount = 0;
  }

  // ─── Node Operations ─────────────────────────────────

  /**
   * Add or update a node in the graph.
   */
  addNode(key, assetData) {
    if (this.nodes.has(key)) {
      // Merge data into existing node (preserve edges)
      const existing = this.nodes.get(key);
      existing.domain = assetData.domain || assetData.anchor_domain || existing.domain;
      existing.name = assetData.name || existing.name;
      existing.isVerified = assetData.is_verified ?? existing.isVerified;
      existing.numAccounts = assetData.num_accounts ?? existing.numAccounts;
      existing.isDepositEnabled = assetData.is_deposit_enabled ?? existing.isDepositEnabled;
      existing.isWithdrawEnabled = assetData.is_withdraw_enabled ?? existing.isWithdrawEnabled;
      existing.anchorDomain = assetData.anchor_domain || existing.anchorDomain;
      return existing;
    }

    const node = new GraphNode(key, assetData);
    this.nodes.set(key, node);
    return node;
  }

  /**
   * Check if a node exists.
   */
  hasNode(key) {
    return this.nodes.has(key);
  }

  /**
   * Get a node by key.
   */
  getNode(key) {
    return this.nodes.get(key) || null;
  }

  // ─── Edge Operations ─────────────────────────────────

  /**
   * Add a directed edge from source → target.
   * If an edge of the same type already exists, it is replaced.
   */
  addEdge(sourceKey, targetKey, type, metadata = {}) {
    const sourceNode = this.nodes.get(sourceKey);
    const targetNode = this.nodes.get(targetKey);

    if (!sourceNode || !targetNode) {
      log.warn({ sourceKey, targetKey }, 'Cannot add edge — node missing');
      return null;
    }

    const edge = new GraphEdge({
      source: sourceKey,
      target: targetKey,
      type,
      metadata,
    });

    // Get or create edge list for this target
    if (!sourceNode.edges.has(targetKey)) {
      sourceNode.edges.set(targetKey, []);
    }

    const edgeList = sourceNode.edges.get(targetKey);

    // Replace existing edge of same type, or add new
    const existingIdx = edgeList.findIndex((e) => e.type === type);
    if (existingIdx >= 0) {
      edgeList[existingIdx] = edge;
    } else {
      edgeList.push(edge);
      this._edgeCount++;
    }

    return edge;
  }

  /**
   * Add bidirectional edges (convenience for DEX pairs).
   * The reverse edge has inverted bid/ask since selling/buying are swapped.
   */
  addBidirectionalEdge(keyA, keyB, type, forwardMeta, reverseMeta) {
    const fwd = this.addEdge(keyA, keyB, type, forwardMeta);
    const rev = this.addEdge(keyB, keyA, type, reverseMeta || forwardMeta);
    return { forward: fwd, reverse: rev };
  }

  /**
   * Get all edges from a source node.
   * Returns a flat array of all edges.
   */
  getEdgesFrom(key) {
    const node = this.nodes.get(key);
    if (!node) return [];

    const edges = [];
    for (const edgeList of node.edges.values()) {
      edges.push(...edgeList);
    }
    return edges;
  }

  /**
   * Get edges between two specific nodes.
   */
  getEdgesBetween(sourceKey, targetKey) {
    const node = this.nodes.get(sourceKey);
    if (!node) return [];
    return node.edges.get(targetKey) || [];
  }

  /**
   * Get all neighbor keys of a node (assets directly reachable in one hop).
   */
  getNeighborKeys(key) {
    const node = this.nodes.get(key);
    if (!node) return [];
    return Array.from(node.edges.keys());
  }

  /**
   * Get neighbors with full edge data.
   */
  getNeighbors(key) {
    const node = this.nodes.get(key);
    if (!node) return [];

    const neighbors = [];
    for (const [targetKey, edgeList] of node.edges.entries()) {
      const targetNode = this.nodes.get(targetKey);
      if (targetNode) {
        neighbors.push({
          key: targetKey,
          code: targetNode.code,
          issuer: targetNode.issuer,
          domain: targetNode.domain,
          name: targetNode.name,
          edges: edgeList.map((e) => formatEdge(e)),
        });
      }
    }
    return neighbors;
  }

  // ─── Bulk Operations ──────────────────────────────────

  /**
   * Clear the entire graph for a full rebuild.
   */
  clear() {
    this.nodes.clear();
    this._edgeCount = 0;
    log.debug('Graph cleared');
  }

  /**
   * Mark build as started. Returns false if already building (mutex).
   */
  startBuild() {
    if (this.isBuilding) {
      log.warn('Graph build already in progress — skipping');
      return false;
    }
    this.isBuilding = true;
    return true;
  }

  /**
   * Mark build as complete.
   */
  completeBuild(durationMs) {
    this.buildVersion++;
    this.lastBuildTime = new Date().toISOString();
    this.lastBuildDurationMs = durationMs;
    this.isBuilding = false;
    log.info({
      version: this.buildVersion,
      nodes: this.nodes.size,
      edges: this._edgeCount,
      durationMs,
    }, 'Graph build complete');
  }

  // ─── Query Utilities ──────────────────────────────────

  /**
   * Get all edges in the graph (flat list).
   */
  getAllEdges() {
    const edges = [];
    for (const node of this.nodes.values()) {
      for (const edgeList of node.edges.values()) {
        edges.push(...edgeList);
      }
    }
    return edges;
  }

  /**
   * Get all edges of a specific type.
   */
  getEdgesByType(type) {
    return this.getAllEdges().filter((e) => e.type === type);
  }

  /**
   * Graph statistics for monitoring and API.
   */
  getStats() {
    const allEdges = this.getAllEdges();
    const dexEdges = allEdges.filter((e) => e.type === EdgeType.DEX);
    const bridgeEdges = allEdges.filter((e) => e.type === EdgeType.ANCHOR_BRIDGE);
    const xlmHubEdges = allEdges.filter((e) => e.type === EdgeType.XLM_HUB);

    const nativeKey = 'XLM:native';
    const nativeNode = this.nodes.get(nativeKey);
    const xlmPairCount = nativeNode ? nativeNode.edges.size : 0;

    // Average edge weight (excluding Infinity)
    const finiteWeights = allEdges.map((e) => e.weight).filter((w) => w < Infinity);
    const avgWeight = finiteWeights.length > 0
      ? finiteWeights.reduce((s, w) => s + w, 0) / finiteWeights.length
      : 0;

    // Connectivity: % of nodes with at least one edge
    const connectedNodes = Array.from(this.nodes.values()).filter((n) => n.edges.size > 0).length;

    return {
      version: this.buildVersion,
      lastBuildTime: this.lastBuildTime,
      lastBuildDurationMs: this.lastBuildDurationMs,
      isBuilding: this.isBuilding,
      nodes: this.nodes.size,
      edges: this._edgeCount,
      dexEdges: dexEdges.length,
      bridgeEdges: bridgeEdges.length,
      xlmHubEdges: xlmHubEdges.length,
      xlmPairs: xlmPairCount,
      connectedNodes,
      disconnectedNodes: this.nodes.size - connectedNodes,
      connectivity: this.nodes.size > 0
        ? +(connectedNodes / this.nodes.size).toFixed(4)
        : 0,
      avgEdgeWeight: +avgWeight.toFixed(6),
    };
  }

  /**
   * Export graph as a serializable snapshot for debugging.
   */
  toSnapshot() {
    const nodes = [];
    const edges = [];

    for (const [key, node] of this.nodes.entries()) {
      nodes.push({
        key,
        code: node.code,
        issuer: node.issuer,
        domain: node.domain,
        name: node.name,
        isNative: node.isNative,
        edgeCount: node.edges.size,
      });

      for (const edgeList of node.edges.values()) {
        for (const edge of edgeList) {
          edges.push(formatEdge(edge));
        }
      }
    }

    return {
      version: this.buildVersion,
      builtAt: this.lastBuildTime,
      stats: this.getStats(),
      nodes,
      edges,
    };
  }
}

// ─── Edge Formatter ─────────────────────────────────────────

function formatEdge(edge) {
  const base = {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    weight: edge.weight,
    lastUpdated: edge.lastUpdated,
  };

  if (edge.type === EdgeType.DEX) {
    return {
      ...base,
      topBid: edge.topBid,
      topAsk: edge.topAsk,
      spread: edge.spread,
      bidDepth: edge.bidDepth,
      askDepth: edge.askDepth,
      bidCount: edge.bidCount,
      askCount: edge.askCount,
    };
  }

  if (edge.type === EdgeType.ANCHOR_BRIDGE) {
    return {
      ...base,
      anchorDomain: edge.anchorDomain,
      anchorHealth: edge.anchorHealth,
      depositEnabled: edge.depositEnabled,
      withdrawEnabled: edge.withdrawEnabled,
      feeFixed: edge.feeFixed,
      feePercent: edge.feePercent,
    };
  }

  if (edge.type === EdgeType.XLM_HUB) {
    return {
      ...base,
      mechanism: edge.mechanism || 'xlm_hub',
      assetCode: edge.assetCode,
      assetDomain: edge.assetDomain,
      estimated: true,
    };
  }

  return base;
}

// ─── Singleton Instance ─────────────────────────────────────

const graph = new RouteGraph();

export { RouteGraph, GraphNode, GraphEdge, formatEdge };
export default graph;
