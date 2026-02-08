// ─── Stella Protocol — Graph Refresh Scheduler ────────────────
// Manages the lifecycle of the Route Graph:
//   - Initial build after asset sync completes
//   - Periodic edge weight refresh (orderbook prices)
//   - Full rebuild on anchor re-crawl
//
// Two intervals:
//   - FULL rebuild: every anchorCrawlIntervalMs (anchors may have changed)
//   - LIGHT refresh: every graphRefreshIntervalMs (just update prices)

import { buildRouteGraph, refreshEdgeWeights } from './graphBuilder.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('graph-scheduler');

// ─── Configuration ────────────────────────────────────────────
// Light refresh: every 5 minutes (update orderbook prices)
const LIGHT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Full rebuild: every 30 minutes (discover new edges, sync with registry changes)
const FULL_REBUILD_INTERVAL_MS = 30 * 60 * 1000;
// Delay after boot before first build (wait for asset sync)
const INITIAL_BUILD_DELAY_MS = 1000;

let lightRefreshTimer = null;
let fullRebuildTimer = null;
let isStarted = false;

/**
 * Start the graph scheduler.
 * Called from the boot sequence AFTER asset sync completes.
 *
 * Flow:
 *   1. Wait briefly for asset registry to populate
 *   2. Perform initial full build
 *   3. Schedule periodic light refreshes + full rebuilds
 */
export async function startGraphScheduler() {
  if (isStarted) {
    log.warn('Graph scheduler already running');
    return;
  }
  isStarted = true;

  log.info('Graph scheduler starting...');

  // ── Initial build ───────────────────────────────────
  log.info(`Scheduling initial graph build in ${INITIAL_BUILD_DELAY_MS}ms...`);

  setTimeout(async () => {
    try {
      const result = await buildRouteGraph();
      if (result.ok) {
        log.info({
          nodes: result.nodes,
          edges: result.edges,
          durationMs: result.durationMs,
        }, 'Initial graph build successful');
      } else {
        log.warn({ reason: result.reason || result.error }, 'Initial graph build failed');
      }
    } catch (err) {
      log.error({ err }, 'Initial graph build threw');
    }
  }, INITIAL_BUILD_DELAY_MS);

  // ── Light refresh timer (orderbook prices) ──────────
  lightRefreshTimer = setInterval(async () => {
    try {
      log.debug('Running light edge weight refresh...');
      const result = await refreshEdgeWeights();
      if (result.ok) {
        log.debug({ updated: result.updated, durationMs: result.durationMs }, 'Light refresh done');
      }
    } catch (err) {
      log.error({ err }, 'Light refresh failed');
    }
  }, LIGHT_REFRESH_INTERVAL_MS);

  // ── Full rebuild timer (structural changes) ─────────
  fullRebuildTimer = setInterval(async () => {
    try {
      log.info('Running scheduled full graph rebuild...');
      const result = await buildRouteGraph();
      if (result.ok) {
        log.info({
          nodes: result.nodes,
          edges: result.edges,
          durationMs: result.durationMs,
        }, 'Scheduled rebuild complete');
      } else {
        log.warn({ reason: result.reason || result.error }, 'Scheduled rebuild failed');
      }
    } catch (err) {
      log.error({ err }, 'Scheduled rebuild threw');
    }
  }, FULL_REBUILD_INTERVAL_MS);

  log.info({
    lightRefreshMs: LIGHT_REFRESH_INTERVAL_MS,
    fullRebuildMs: FULL_REBUILD_INTERVAL_MS,
  }, 'Graph scheduler started');
}

/**
 * Stop the graph scheduler cleanly.
 */
export function stopGraphScheduler() {
  if (lightRefreshTimer) {
    clearInterval(lightRefreshTimer);
    lightRefreshTimer = null;
  }
  if (fullRebuildTimer) {
    clearInterval(fullRebuildTimer);
    fullRebuildTimer = null;
  }
  isStarted = false;
  log.info('Graph scheduler stopped');
}

/**
 * Trigger a manual full rebuild (via API).
 */
export async function triggerManualRebuild() {
  log.info('Manual graph rebuild triggered');
  return buildRouteGraph();
}
