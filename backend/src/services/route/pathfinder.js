// ─── Stella Protocol — Pathfinder ─────────────────────────────
// Modified Dijkstra's algorithm with extensions:
//   - k-Shortest Paths (Yen's algorithm variant)
//   - Hop limit (configurable, default 4)
//   - Cycle detection (no asset visited twice per path)
//   - Early termination when enough routes found
//
// Input:  source asset key, destination asset key, options
// Output: Array of weighted paths, sorted best-first

import config from '../../config/index.js';
import graph, { parseAssetKey, EdgeType } from '../graph/routeGraph.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('pathfinder');

/**
 * @typedef {object} PathResult
 * @property {string[]}  path       - Ordered asset keys from source → dest
 * @property {object[]}  edges      - Edge objects connecting each pair
 * @property {number}    totalWeight - Sum of all edge weights
 * @property {number}    hops       - Number of hops (edges)
 * @property {string[]}  edgeTypes  - Types of edges used (dex, anchor_bridge, ...)
 */

// ═══════════════════════════════════════════════════════════════
// SINGLE SHORTEST PATH — Dijkstra with hop limit
// ═══════════════════════════════════════════════════════════════

/**
 * Find the single shortest (lowest weight) path between two assets.
 *
 * @param {string} sourceKey  - e.g. "USDC:GISSUER..."
 * @param {string} destKey    - e.g. "XLM:native"
 * @param {object} options
 * @param {number} options.maxHops     - Max edges per path (default: config.maxHops)
 * @param {Set<string>} options.avoid  - Asset keys to avoid (for k-shortest iteration)
 * @returns {PathResult | null}
 */
export function findShortestPath(sourceKey, destKey, {
  maxHops = config.maxHops,
  avoid = new Set(),
  avoidEdges = new Set(),   // Set of "fromKey→toKey" strings — blocks specific edges
} = {}) {
  if (!graph.hasNode(sourceKey) || !graph.hasNode(destKey)) {
    return null;
  }
  if (sourceKey === destKey) {
    return null; // Same asset — no route needed
  }

  // ── Priority queue (min-heap simulation with sorted array) ──
  // Each entry: { key, weight, hops, prev, prevEdge }
  const dist = new Map();       // key → best known weight
  const hops = new Map();       // key → hops to reach
  const prev = new Map();       // key → previous key
  const prevEdge = new Map();   // key → edge used to reach
  const visited = new Set();

  // Initialize source
  dist.set(sourceKey, 0);
  hops.set(sourceKey, 0);

  // Min-priority queue
  const queue = new MinPriorityQueue();
  queue.enqueue(sourceKey, 0);

  while (!queue.isEmpty()) {
    const { key: current, priority: currentWeight } = queue.dequeue();

    // Already found a shorter path? Skip.
    if (visited.has(current)) continue;
    visited.add(current);

    // Reached destination
    if (current === destKey) {
      return reconstructPath(sourceKey, destKey, prev, prevEdge, dist);
    }

    const currentHops = hops.get(current) || 0;

    // Hop limit reached
    if (currentHops >= maxHops) continue;

    // Explore neighbors
    const node = graph.getNode(current);
    if (!node) continue;

    for (const [neighborKey, edgeList] of node.edges.entries()) {
      // Skip avoided nodes (for k-shortest path diversity)
      if (avoid.has(neighborKey)) continue;
      // Skip specific avoided edges (from→to)
      if (avoidEdges.has(`${current}→${neighborKey}`)) continue;
      // Skip already visited
      if (visited.has(neighborKey)) continue;

      // Pick the best (lowest-weight) edge to this neighbor
      const bestEdge = pickBestEdge(edgeList);
      if (!bestEdge) continue;

      const newWeight = currentWeight + bestEdge.weight;
      const knownWeight = dist.get(neighborKey) ?? Infinity;

      if (newWeight < knownWeight) {
        dist.set(neighborKey, newWeight);
        hops.set(neighborKey, currentHops + 1);
        prev.set(neighborKey, current);
        prevEdge.set(neighborKey, bestEdge);
        queue.enqueue(neighborKey, newWeight);
      }
    }
  }

  return null; // No path found
}

// ═══════════════════════════════════════════════════════════════
// K-SHORTEST PATHS — Yen's Algorithm
// ═══════════════════════════════════════════════════════════════

/**
 * Find up to K shortest paths between two assets.
 * Uses Yen's algorithm: finds shortest path, then systematically
 * deviates from it to discover alternative paths.
 *
 * @param {string} sourceKey
 * @param {string} destKey
 * @param {object} options
 * @param {number} options.k       - Maximum number of paths (default: config.maxRoutesPerDest)
 * @param {number} options.maxHops - Max hops per path
 * @returns {PathResult[]}
 */
export function findKShortestPaths(sourceKey, destKey, {
  k = config.maxRoutesPerDest,
  maxHops = config.maxHops,
} = {}) {
  const paths = [];

  // 1. Find the absolute shortest path
  const shortest = findShortestPath(sourceKey, destKey, { maxHops });
  if (!shortest) return [];

  paths.push(shortest);

  // 2. Candidate pool for alternative paths
  const candidates = [];
  const candidateSet = new Set(); // Dedup by path-key

  for (let i = 1; i < k; i++) {
    const prevPath = paths[i - 1];

    // Try deviating at each node in the previous path
    for (let spurIdx = 0; spurIdx < prevPath.path.length - 1; spurIdx++) {
      const spurNode = prevPath.path[spurIdx];
      const rootPath = prevPath.path.slice(0, spurIdx + 1);

      // Avoid edges already taken by existing paths at this spur point
      const avoid = new Set();
      const avoidEdges = new Set();  // "from→to" edge strings

      for (const existingPath of paths) {
        if (existingPath.path.length > spurIdx) {
          const match = existingPath.path.slice(0, spurIdx + 1).join(',')
            === rootPath.join(',');
          if (match && existingPath.path[spurIdx + 1]) {
            const nextHop = existingPath.path[spurIdx + 1];
            // Block the specific edge spurNode→nextHop
            avoidEdges.add(`${spurNode}→${nextHop}`);
          }
        }
      }

      // Also avoid nodes already in rootPath (cycle prevention)
      for (const node of rootPath.slice(0, -1)) {
        avoid.add(node);
      }

      // Never avoid the destination node itself
      avoid.delete(destKey);

      // Find spur path from spurNode → dest
      const spurPath = findShortestPath(spurNode, destKey, {
        maxHops: maxHops - spurIdx,
        avoid,
        avoidEdges,
      });

      if (!spurPath) continue;

      // Combine root + spur
      const combined = combineRootAndSpur(rootPath, spurPath, prevPath);
      if (!combined) continue;

      const pathKey = combined.path.join('|');
      if (!candidateSet.has(pathKey)) {
        candidateSet.add(pathKey);
        candidates.push(combined);
      }
    }

    if (candidates.length === 0) break;

    // Pick the best candidate
    candidates.sort((a, b) => a.totalWeight - b.totalWeight);
    const best = candidates.shift();
    candidateSet.delete(best.path.join('|'));
    paths.push(best);
  }

  return paths;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Reconstruct the path from Dijkstra's predecessors.
 */
function reconstructPath(sourceKey, destKey, prev, prevEdge, dist) {
  const path = [];
  const edges = [];
  let current = destKey;

  while (current !== sourceKey) {
    path.unshift(current);
    const edge = prevEdge.get(current);
    if (edge) edges.unshift(edge);
    current = prev.get(current);
    if (current === undefined) return null; // Broken chain
  }
  path.unshift(sourceKey);

  const edgeTypes = [...new Set(edges.map((e) => e.type))];

  return {
    path,
    edges,
    totalWeight: dist.get(destKey) || 0,
    hops: edges.length,
    edgeTypes,
  };
}

/**
 * Combine a root prefix path with a spur path.
 */
function combineRootAndSpur(rootPath, spurPath, fullPrevPath) {
  // Root path edges come from the previous full path
  const rootEdges = [];
  for (let i = 0; i < rootPath.length - 1; i++) {
    const edge = fullPrevPath.edges[i];
    if (!edge) return null;
    rootEdges.push(edge);
  }

  const fullPath = [...rootPath, ...spurPath.path.slice(1)];
  const fullEdges = [...rootEdges, ...spurPath.edges];

  // Check for cycles
  const uniqueNodes = new Set(fullPath);
  if (uniqueNodes.size !== fullPath.length) return null;

  const totalWeight = fullEdges.reduce((sum, e) => sum + e.weight, 0);
  const edgeTypes = [...new Set(fullEdges.map((e) => e.type))];

  return {
    path: fullPath,
    edges: fullEdges,
    totalWeight,
    hops: fullEdges.length,
    edgeTypes,
  };
}

/**
 * Pick the best (lowest-weight) edge from a list of edges
 * between two nodes (there may be both DEX and bridge edges).
 */
function pickBestEdge(edgeList) {
  if (!edgeList || edgeList.length === 0) return null;
  let best = edgeList[0];
  for (let i = 1; i < edgeList.length; i++) {
    if (edgeList[i].weight < best.weight) {
      best = edgeList[i];
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
// MIN PRIORITY QUEUE
// ═══════════════════════════════════════════════════════════════
// Simple binary heap implementation. Efficient enough for our
// graph sizes (typically < 1000 nodes).

class MinPriorityQueue {
  constructor() {
    this._heap = []; // [{key, priority}]
  }

  get size() {
    return this._heap.length;
  }

  isEmpty() {
    return this._heap.length === 0;
  }

  enqueue(key, priority) {
    this._heap.push({ key, priority });
    this._bubbleUp(this._heap.length - 1);
  }

  dequeue() {
    if (this._heap.length === 0) return null;
    const min = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._sinkDown(0);
    }
    return min;
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this._heap[idx].priority >= this._heap[parent].priority) break;
      [this._heap[idx], this._heap[parent]] = [this._heap[parent], this._heap[idx]];
      idx = parent;
    }
  }

  _sinkDown(idx) {
    const length = this._heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < length && this._heap[left].priority < this._heap[smallest].priority) {
        smallest = left;
      }
      if (right < length && this._heap[right].priority < this._heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === idx) break;
      [this._heap[idx], this._heap[smallest]] = [this._heap[smallest], this._heap[idx]];
      idx = smallest;
    }
  }
}

export { MinPriorityQueue };
