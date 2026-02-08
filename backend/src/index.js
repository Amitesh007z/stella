// ─── Stella Protocol — Entry Point ────────────────────────────
// Boots database, runs migrations, starts the Fastify server.

import config from './config/index.js';
import logger from './lib/logger.js';
import { initDb, closeDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { checkHorizonHealth } from './lib/horizon.js';
import { buildApp } from './app.js';
import { startCrawlScheduler, stopCrawlScheduler } from './services/anchor/crawlScheduler.js';
import { syncAssetRegistry } from './services/asset/assetSync.js';
import { startGraphScheduler, stopGraphScheduler } from './services/graph/graphScheduler.js';
import { startCacheCleanup, stopCacheCleanup } from './services/route/routeCache.js';
import { startQuoteCleanup, stopQuoteCleanup } from './services/execution/quoteManager.js';

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  STELLA PROTOCOL — Routing Intelligence');
  logger.info(`  Network:  ${config.network}`);
  logger.info(`  Horizon:  ${config.horizonUrl}`);
  logger.info('═══════════════════════════════════════════════');

  // ── 1. Initialize database ──────────────────────────
  logger.info('Initializing database...');
  initDb();

  // ── 2. Run pending migrations ───────────────────────
  logger.info('Running migrations...');
  await runMigrations();

  // ── 3. Verify Horizon connectivity ──────────────────
  logger.info('Checking Horizon connectivity...');
  const horizonStatus = await checkHorizonHealth();
  if (!horizonStatus.ok) {
    logger.warn('Horizon unreachable — starting in degraded mode');
  }

  // ── 4. Build and start server ───────────────────────
  const app = await buildApp();

  await app.listen({ host: config.host, port: config.port });
  logger.info(`Server listening on http://${config.host}:${config.port}`);
  logger.info('Ready to accept requests ✓ (background tasks starting...)');

  // ══════════════════════════════════════════════════════
  // BACKGROUND TASKS - Don't block server startup
  // ══════════════════════════════════════════════════════

  // ── 5. Start anchor crawl scheduler (background) ────
  setImmediate(async () => {
    try {
      logger.info('Starting anchor crawl scheduler (background)...');
      await startCrawlScheduler();
    } catch (err) {
      logger.warn({ err: err.message }, 'Anchor crawl scheduler failed to start');
    }
  });

  // ── 6. Sync global asset registry (background) ──────
  setImmediate(async () => {
    try {
      logger.info('Syncing asset registry (background)...');
      const result = await syncAssetRegistry();
      logger.info({ totalAssets: result.totalAssets, sources: result.sources }, 'Asset registry sync complete');
    } catch (err) {
      logger.warn({ err: err.message }, 'Asset registry sync failed — will retry on next crawl');
    }
  });

  // ── 7. Start graph scheduler (background) ───────────
  setImmediate(async () => {
    try {
      logger.info('Starting graph scheduler (background)...');
      await startGraphScheduler();
    } catch (err) {
      logger.warn({ err: err.message }, 'Graph scheduler failed to start');
    }
  });

  // ── 8. Start route cache cleanup ────────────────────
  startCacheCleanup();

  // ── 9. Start quote cleanup ──────────────────────────
  startQuoteCleanup();

  // ── Graceful shutdown ───────────────────────────────
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopQuoteCleanup();
    stopCacheCleanup();
    stopGraphScheduler();
    stopCrawlScheduler();
    await app.close();
    closeDb();
    logger.info('Stella Protocol shut down cleanly');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start Stella Protocol');
  process.exit(1);
});
