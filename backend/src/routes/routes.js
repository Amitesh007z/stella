// ─── Stella Protocol — Route API Endpoints ────────────────────
// REST endpoints for the Route Discovery Engine.
//
//   POST /api/routes/find   — Find routes between two assets
//   GET  /api/routes/cache  — Cache statistics
//   DELETE /api/routes/cache — Invalidate cache

import { findRoutes } from '../services/route/routeResolver.js';
import {
  buildCacheKey,
  getCachedRoutes,
  setCachedRoutes,
  invalidateAll,
  getCacheStats,
} from '../services/route/routeCache.js';
import graph, { assetKey } from '../services/graph/routeGraph.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('routes-api');

// ─── Request counters ─────────────────────────────────────────
let totalQueries = 0;
let cacheHits = 0;
let cacheMisses = 0;
let failedQueries = 0;

export default async function routeRoutes(fastify) {

  // ═══════════════════════════════════════════════════════
  // POST /api/routes/find — Find routes between two assets
  // ═══════════════════════════════════════════════════════
  fastify.post('/routes/find', {
    schema: {
      body: {
        type: 'object',
        required: ['sourceCode', 'destCode', 'amount'],
        properties: {
          sourceCode:   { type: 'string', minLength: 1, description: 'Source asset code' },
          sourceIssuer: { type: 'string', nullable: true, description: 'Source issuer (null for XLM)' },
          destCode:     { type: 'string', minLength: 1, description: 'Destination asset code' },
          destIssuer:   { type: 'string', nullable: true, description: 'Destination issuer (null for XLM)' },
          amount:       { type: 'string', minLength: 1, description: 'Amount (string)' },
          mode:         { type: 'string', enum: ['send', 'receive'], default: 'send' },
          maxHops:      { type: 'integer', minimum: 1, maximum: 6 },
          maxRoutes:    { type: 'integer', minimum: 1, maximum: 20 },
          noCache:      { type: 'boolean', default: false, description: 'Skip cache lookup' },
        },
      },
    },
  }, async (request) => {
    totalQueries++;
    const {
      sourceCode, sourceIssuer,
      destCode, destIssuer,
      amount,
      mode = 'send',
      maxHops,
      maxRoutes,
      noCache = false,
    } = request.body;

    // ── Build cache key ───────────────────────────────
    const srcKey = assetKey(sourceCode, sourceIssuer);
    const dstKey = assetKey(destCode, destIssuer);
    const cacheKey = buildCacheKey(srcKey, dstKey, amount, mode);

    // ── Try cache first ───────────────────────────────
    if (!noCache) {
      const cached = getCachedRoutes(cacheKey, graph.buildVersion);
      if (cached) {
        cacheHits++;
        const { _cacheSource, ...data } = cached;
        return {
          ...data,
          meta: {
            ...data.meta,
            cached: true,
            cacheSource: _cacheSource,
          },
        };
      }
    }

    cacheMisses++;

    // ── Compute fresh routes ──────────────────────────
    const result = await findRoutes({
      sourceCode,
      sourceIssuer: sourceIssuer || null,
      destCode,
      destIssuer: destIssuer || null,
      amount,
      mode,
      maxHops,
      maxRoutes,
    });

    // ── Store in cache ────────────────────────────────
    setCachedRoutes(cacheKey, srcKey, dstKey, amount, result, graph.buildVersion);

    return {
      ...result,
      meta: {
        ...result.meta,
        cached: false,
      },
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/routes/stats — Route engine statistics
  // ═══════════════════════════════════════════════════════
  fastify.get('/routes/stats', async () => {
    const cache = getCacheStats();
    const graphStats = graph.getStats();

    return {
      queries: {
        total: totalQueries,
        cacheHits,
        cacheMisses,
        failed: failedQueries,
        hitRate: totalQueries > 0
          ? Number(((cacheHits / totalQueries) * 100).toFixed(1))
          : 0,
      },
      cache,
      graph: {
        version: graphStats.buildVersion,
        nodes: graphStats.nodeCount,
        edges: graphStats.edgeCount,
        lastBuild: graphStats.lastBuildTime,
      },
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/routes/cache — Cache details
  // ═══════════════════════════════════════════════════════
  fastify.get('/routes/cache', async () => {
    return getCacheStats();
  });

  // ═══════════════════════════════════════════════════════
  // DELETE /api/routes/cache — Invalidate all cached routes
  // ═══════════════════════════════════════════════════════
  fastify.delete('/routes/cache', async () => {
    invalidateAll();
    return { status: 'ok', message: 'Route cache invalidated' };
  });

  // ─── Error counter hook ─────────────────────────────
  fastify.addHook('onError', (request, reply, error, done) => {
    if (request.url.includes('/routes/find')) {
      failedQueries++;
    }
    done();
  });
}
