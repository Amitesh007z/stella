// ─── Stella Protocol — Crawl Scheduler ────────────────────────
// Manages periodic anchor crawling: initial bootstrap + refresh loop.
// Runs as a background service tied to the server lifecycle.

import config from '../../config/index.js';
import { createLogger } from '../../lib/logger.js';
import { getSeeds } from './seeds.js';
import { crawlSeeds, refreshStaleAnchors } from './anchorIndexer.js';
import { getStaleAnchors, getAnchorStats, getAnchorByDomain } from './anchorRepository.js';
import { discoverAnchorsFromDirectory } from './directoryDiscovery.js';

const log = createLogger('crawl-scheduler');

let refreshTimer = null;
let isRunning = false;

/**
 * Start the crawl scheduler.
 * 1. Run initial bootstrap crawl of seed anchors
 * 2. Schedule periodic refresh of stale anchors
 */
export async function startCrawlScheduler() {
  log.info('Starting crawl scheduler...');

  // ── Phase 1: Bootstrap seed anchors ─────────────────
  try {
    const seeds = getSeeds(config.network);
    log.info({ network: config.network, seeds: seeds.length }, 'Bootstrapping seed anchors');

    const results = await crawlSeeds(seeds);
    const stats = getAnchorStats();

    log.info(
      {
        total: stats.total,
        active: stats.active,
        healthy: stats.healthy,
        degraded: stats.degraded,
        offline: stats.offline,
      },
      'Bootstrap crawl complete — anchor index stats'
    );
  } catch (err) {
    log.error({ err: err.message }, 'Bootstrap crawl failed — will retry on next cycle');
  }

  // ── Phase 1b: Dynamic directory discovery ───────────
  try {
    log.info('Discovering anchors from public directories...');
    const directoryDomains = await discoverAnchorsFromDirectory();

    // Filter out domains we already have
    const newDomains = directoryDomains.filter(
      (d) => !getAnchorByDomain(d.domain)
    );

    if (newDomains.length > 0) {
      log.info({ newDomains: newDomains.length }, 'Crawling newly discovered anchor domains');
      await crawlSeeds(newDomains.map((d) => ({
        domain: d.domain,
        name: d.name,
        description: d.description,
      })));

      const updatedStats = getAnchorStats();
      log.info(
        { total: updatedStats.total, active: updatedStats.active },
        'Directory discovery crawl complete'
      );
    } else {
      log.info('No new domains discovered from directories');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Directory discovery failed — continuing with seeds only');
  }

  // ── Phase 2: Schedule periodic refresh ──────────────
  const intervalMs = config.anchorCrawlIntervalMs;
  log.info({ intervalMs, intervalMin: Math.round(intervalMs / 60000) }, 'Scheduling periodic refresh');

  refreshTimer = setInterval(async () => {
    if (isRunning) {
      log.debug('Refresh already in progress — skipping');
      return;
    }

    isRunning = true;
    try {
      await runRefreshCycle();
    } catch (err) {
      log.error({ err: err.message }, 'Refresh cycle error');
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  // Prevent timer from keeping Node alive after shutdown
  if (refreshTimer.unref) refreshTimer.unref();
}

/**
 * Run a single refresh cycle — recrawl anchors past their TTL.
 */
async function runRefreshCycle() {
  const stale = getStaleAnchors(config.anchorCacheTtlMs);

  if (stale.length === 0) {
    log.debug('No stale anchors — skipping refresh');
    return;
  }

  log.info({ count: stale.length }, 'Refreshing stale anchors');
  const results = await refreshStaleAnchors(stale);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const stats = getAnchorStats();

  log.info(
    { refreshed: succeeded, failed, ...stats },
    'Refresh cycle complete'
  );
}

/**
 * Stop the crawl scheduler.
 */
export function stopCrawlScheduler() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    log.info('Crawl scheduler stopped');
  }
}

/**
 * Manually trigger a refresh (for API/admin use).
 */
export async function triggerManualRefresh() {
  if (isRunning) {
    return { ok: false, message: 'Refresh already in progress' };
  }

  isRunning = true;
  try {
    await runRefreshCycle();
    return { ok: true, message: 'Refresh complete' };
  } finally {
    isRunning = false;
  }
}

export default { startCrawlScheduler, stopCrawlScheduler, triggerManualRefresh };
