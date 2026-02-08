// ─── Stella Protocol — Route Cache ────────────────────────────
// Two-layer cache for computed routes:
//   1. In-memory LRU (sub-millisecond, TTL 30s)
//   2. SQLite route_cache table (persistent, TTL configurable)
//
// Cache key = deterministic hash of (source, dest, amount, mode).
// Cache is automatically invalidated when the graph rebuilds.

import { getDb } from '../../db/index.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('route-cache');

// ─── Configuration ────────────────────────────────────────────
const MEMORY_TTL_MS = 30_000;        // 30 seconds in-memory
const SQLITE_TTL_SECONDS = 120;      // 2 minutes in SQLite
const MAX_MEMORY_ENTRIES = 500;       // LRU eviction limit
const CLEANUP_INTERVAL_MS = 60_000;   // Purge expired SQLite entries

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY LRU CACHE
// ═══════════════════════════════════════════════════════════════

class MemoryCache {
  constructor(maxSize = MAX_MEMORY_ENTRIES) {
    this._cache = new Map(); // key → { data, expiresAt, graphVersion }
    this._maxSize = maxSize;
  }

  /**
   * Get a cached entry if it exists and is still valid.
   */
  get(key, currentGraphVersion) {
    const entry = this._cache.get(key);
    if (!entry) return null;

    // Expired?
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }

    // Graph version mismatch — data is stale
    if (entry.graphVersion !== currentGraphVersion) {
      this._cache.delete(key);
      return null;
    }

    // LRU touch: delete and re-insert to move to end
    this._cache.delete(key);
    this._cache.set(key, entry);

    return entry.data;
  }

  /**
   * Store a value with TTL.
   */
  set(key, data, graphVersion) {
    // Evict oldest if at capacity
    if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }

    this._cache.set(key, {
      data,
      expiresAt: Date.now() + MEMORY_TTL_MS,
      graphVersion,
    });
  }

  /**
   * Clear all entries.
   */
  clear() {
    this._cache.clear();
  }

  get size() {
    return this._cache.size;
  }
}

const memCache = new MemoryCache();

// ═══════════════════════════════════════════════════════════════
// SQLITE CACHE LAYER
// ═══════════════════════════════════════════════════════════════

/**
 * Get cached routes from SQLite.
 */
function sqliteGet(cacheKey) {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM route_cache WHERE cache_key = ? AND expires_at > datetime('now')"
    ).get(cacheKey);

    if (!row) return null;

    return JSON.parse(row.routes_json);
  } catch (err) {
    log.debug({ err: err.message }, 'SQLite cache read failed');
    return null;
  }
}

/**
 * Store routes in SQLite cache.
 */
function sqliteSet(cacheKey, sourceAsset, destAsset, amount, data) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO route_cache
        (cache_key, source_asset, dest_asset, source_amount, routes_json, computed_at, expires_at)
      VALUES
        (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+${SQLITE_TTL_SECONDS} seconds'))
    `).run(cacheKey, sourceAsset, destAsset, amount, JSON.stringify(data));
  } catch (err) {
    log.debug({ err: err.message }, 'SQLite cache write failed');
  }
}

/**
 * Remove expired entries from SQLite.
 */
function sqliteCleanup() {
  try {
    const db = getDb();
    const result = db.prepare(
      "DELETE FROM route_cache WHERE expires_at <= datetime('now')"
    ).run();
    if (result.changes > 0) {
      log.debug({ removed: result.changes }, 'Route cache cleanup');
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Route cache cleanup failed');
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Build a deterministic cache key from query parameters.
 */
export function buildCacheKey(sourceKey, destKey, amount, mode) {
  return `${sourceKey}|${destKey}|${amount}|${mode}`;
}

/**
 * Try to get cached routes. Checks memory first, then SQLite.
 *
 * @param {string} cacheKey
 * @param {number} graphVersion - Current graph version for staleness check
 * @returns {{ routes, meta } | null}
 */
export function getCachedRoutes(cacheKey, graphVersion) {
  // Layer 1: Memory
  const memResult = memCache.get(cacheKey, graphVersion);
  if (memResult) {
    log.debug({ cacheKey }, 'Route cache HIT (memory)');
    return { ...memResult, _cacheSource: 'memory' };
  }

  // Layer 2: SQLite
  const sqlResult = sqliteGet(cacheKey);
  if (sqlResult) {
    // Promote to memory cache
    memCache.set(cacheKey, sqlResult, graphVersion);
    log.debug({ cacheKey }, 'Route cache HIT (sqlite)');
    return { ...sqlResult, _cacheSource: 'sqlite' };
  }

  return null;
}

/**
 * Store route results in both cache layers.
 */
export function setCachedRoutes(cacheKey, sourceKey, destKey, amount, data, graphVersion) {
  // Layer 1: Memory
  memCache.set(cacheKey, data, graphVersion);

  // Layer 2: SQLite
  sqliteSet(cacheKey, sourceKey, destKey, amount, data);

  log.debug({ cacheKey }, 'Route cache SET');
}

/**
 * Invalidate all cached routes (called on graph rebuild).
 */
export function invalidateAll() {
  memCache.clear();
  try {
    getDb().prepare('DELETE FROM route_cache').run();
    log.info('Route cache fully invalidated');
  } catch (err) {
    log.debug({ err: err.message }, 'Route cache invalidation failed');
  }
}

/**
 * Get cache statistics.
 */
export function getCacheStats() {
  const db = getDb();
  const sqliteCount = db.prepare('SELECT COUNT(*) as c FROM route_cache').get().c;
  const sqliteValid = db.prepare(
    "SELECT COUNT(*) as c FROM route_cache WHERE expires_at > datetime('now')"
  ).get().c;

  return {
    memory: {
      entries: memCache.size,
      maxSize: MAX_MEMORY_ENTRIES,
      ttlMs: MEMORY_TTL_MS,
    },
    sqlite: {
      total: sqliteCount,
      valid: sqliteValid,
      expired: sqliteCount - sqliteValid,
      ttlSeconds: SQLITE_TTL_SECONDS,
    },
  };
}

// ─── Background cleanup timer ─────────────────────────────────
let cleanupTimer = null;

export function startCacheCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(sqliteCleanup, CLEANUP_INTERVAL_MS);
  log.debug('Route cache cleanup timer started');
}

export function stopCacheCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
