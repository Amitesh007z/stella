// ─── Stella Protocol — Graph API Routes ───────────────────────
// REST endpoints for the Route Graph.
// Read-only monitoring + manual rebuild trigger.

import graph, { assetKey, EdgeType, formatEdge } from '../services/graph/routeGraph.js';
import { refreshEdgeWeights } from '../services/graph/graphBuilder.js';
import { triggerManualRebuild } from '../services/graph/graphScheduler.js';
import { Errors } from '../plugins/errorHandler.js';

export default async function graphRoutes(fastify) {

  // ═══════════════════════════════════════════════════════
  // GET /api/graph/stats — Graph statistics & health
  // ═══════════════════════════════════════════════════════
  fastify.get('/graph/stats', async () => {
    return graph.getStats();
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/graph/nodes — List all graph nodes
  // ═══════════════════════════════════════════════════════
  fastify.get('/graph/nodes', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          connected: { type: 'boolean', description: 'Only nodes with edges' },
        },
      },
    },
  }, async (request) => {
    const { connected } = request.query;

    let nodes = Array.from(graph.nodes.values()).map((n) => ({
      key: n.key,
      code: n.code,
      issuer: n.issuer,
      domain: n.domain,
      name: n.name,
      isNative: n.isNative,
      isVerified: n.isVerified,
      edgeCount: n.edges.size,
      neighborCount: n.edges.size,
    }));

    if (connected !== undefined) {
      nodes = connected
        ? nodes.filter((n) => n.edgeCount > 0)
        : nodes.filter((n) => n.edgeCount === 0);
    }

    return {
      count: nodes.length,
      graphVersion: graph.buildVersion,
      nodes,
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/graph/edges — List all edges with optional type filter
  // ═══════════════════════════════════════════════════════
  fastify.get('/graph/edges', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['dex', 'anchor_bridge', 'xlm_hub'] },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request) => {
    const { type, limit = 200, offset = 0 } = request.query;

    let edges = type
      ? graph.getEdgesByType(type)
      : graph.getAllEdges();

    const total = edges.length;
    edges = edges.slice(offset, offset + limit);

    return {
      total,
      count: edges.length,
      limit,
      offset,
      graphVersion: graph.buildVersion,
      edges: edges.map(formatEdge),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/graph/neighbors/:code/:issuer — Direct neighbors
  // ═══════════════════════════════════════════════════════
  fastify.get('/graph/neighbors/:code/:issuer', async (request) => {
    const { code, issuer } = request.params;
    const key = assetKey(code.toUpperCase(), issuer === 'native' ? null : issuer);

    if (!graph.hasNode(key)) {
      throw Errors.notFound(`Asset not found in graph: ${code}:${issuer}`);
    }

    const neighbors = graph.getNeighbors(key);

    return {
      asset: key,
      neighborCount: neighbors.length,
      graphVersion: graph.buildVersion,
      neighbors,
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/graph/snapshot — Full graph export (debug)
  // ═══════════════════════════════════════════════════════
  fastify.get('/graph/snapshot', async () => {
    return graph.toSnapshot();
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/graph/rebuild — Trigger manual full rebuild
  // ═══════════════════════════════════════════════════════
  fastify.post('/graph/rebuild', async () => {
    const result = await triggerManualRebuild();
    return result;
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/graph/refresh — Trigger edge weight refresh
  // ═══════════════════════════════════════════════════════
  fastify.post('/graph/refresh', async () => {
    const result = await refreshEdgeWeights();
    return result;
  });
}
