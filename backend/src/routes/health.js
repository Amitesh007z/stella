// ─── Stella Protocol — Health Check Route ─────────────────────

import { checkHorizonHealth } from '../lib/horizon.js';
import { getDb } from '../db/index.js';
import config from '../config/index.js';

export default async function healthRoutes(fastify) {
  /**
   * GET /health
   * Quick liveness check — returns 200 if server is up.
   */
  fastify.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  /**
   * GET /health/deep
   * Deep health check — verifies DB + Horizon connectivity.
   */
  fastify.get('/health/deep', async (request, reply) => {
    const checks = {};

    // ── Database ─────────────────────────────────────
    try {
      const db = getDb();
      const row = db.prepare("SELECT datetime('now') AS now").get();
      checks.database = { ok: true, time: row.now };
    } catch (err) {
      checks.database = { ok: false, error: err.message };
    }

    // ── Horizon ──────────────────────────────────────
    checks.horizon = await checkHorizonHealth();

    // ── Aggregate ────────────────────────────────────
    const allOk = Object.values(checks).every((c) => c.ok);

    return reply.status(allOk ? 200 : 503).send({
      status: allOk ? 'healthy' : 'degraded',
      network: config.network,
      horizonUrl: config.horizonUrl,
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /info
   * Protocol metadata — network, version, capabilities.
   */
  fastify.get('/info', async () => {
    return {
      protocol: 'stella',
      version: '0.1.0',
      network: config.network,
      horizonUrl: config.horizonUrl,
      capabilities: {
        anchorDiscovery: true,
        routeSolving: true,
        executionManifest: true,
        sep38Quotes: false, // TODO: Phase 6
      },
    };
  });
}
