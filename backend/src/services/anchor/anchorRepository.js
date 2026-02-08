// ─── Stella Protocol — Anchor Repository ──────────────────────
// Database access layer for anchors and anchor_assets tables.
// All DB writes for anchor data go through here.
// Pure data operations — no business logic.

import { getDb } from '../../db/index.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('anchor-repo');

// ═══════════════════════════════════════════════════════════════
// ANCHOR CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * Upsert an anchor record. Creates if new, updates if domain exists.
 */
export function upsertAnchor(anchor) {
  const db = getDb();

  const existing = db.prepare('SELECT id FROM anchors WHERE domain = ?').get(anchor.domain);

  if (existing) {
    db.prepare(`
      UPDATE anchors SET
        name = ?, transfer_server = ?, transfer_server_sep24 = ?,
        quote_server = ?, web_auth_endpoint = ?, signing_key = ?,
        toml_raw = ?, toml_version = ?,
        status = ?, trust_level = COALESCE(?, trust_level),
        health_status = ?, health_score = ?, completeness_score = ?,
        last_crawled_at = datetime('now'),
        last_error = ?,
        horizon_validated_at = ?,
        updated_at = datetime('now')
      WHERE domain = ?
    `).run(
      anchor.name, anchor.transferServer, anchor.transferServerSep24,
      anchor.quoteServer, anchor.webAuthEndpoint, anchor.signingKey,
      anchor.tomlRaw, anchor.tomlVersion,
      anchor.status || 'active', anchor.trustLevel,
      anchor.healthStatus || 'unknown', anchor.healthScore || 0,
      anchor.completenessScore || 0,
      anchor.lastError,
      anchor.horizonValidatedAt,
      anchor.domain
    );

    log.debug({ domain: anchor.domain, id: existing.id }, 'Anchor updated');
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO anchors (
        domain, name, transfer_server, transfer_server_sep24,
        quote_server, web_auth_endpoint, signing_key,
        toml_raw, toml_version,
        status, trust_level,
        health_status, health_score, completeness_score,
        last_crawled_at, last_error, horizon_validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      anchor.domain, anchor.name, anchor.transferServer, anchor.transferServerSep24,
      anchor.quoteServer, anchor.webAuthEndpoint, anchor.signingKey,
      anchor.tomlRaw, anchor.tomlVersion,
      anchor.status || 'active', anchor.trustLevel || 'discovered',
      anchor.healthStatus || 'unknown', anchor.healthScore || 0,
      anchor.completenessScore || 0,
      anchor.lastError, anchor.horizonValidatedAt
    );

    log.debug({ domain: anchor.domain, id: result.lastInsertRowid }, 'Anchor created');
    return Number(result.lastInsertRowid);
  }
}

/**
 * Increment crawl success/fail counters.
 */
export function incrementCrawlCount(domain, success) {
  const db = getDb();
  if (success) {
    db.prepare('UPDATE anchors SET crawl_success_count = crawl_success_count + 1 WHERE domain = ?').run(domain);
  } else {
    db.prepare('UPDATE anchors SET crawl_fail_count = crawl_fail_count + 1 WHERE domain = ?').run(domain);
  }
}

/**
 * Mark an anchor as errored.
 */
export function markAnchorError(domain, errorMsg) {
  const db = getDb();
  db.prepare(`
    UPDATE anchors SET
      status = 'error',
      health_status = 'offline',
      last_error = ?,
      updated_at = datetime('now')
    WHERE domain = ?
  `).run(errorMsg, domain);
}

/**
 * Get anchor by domain.
 */
export function getAnchorByDomain(domain) {
  return getDb().prepare('SELECT * FROM anchors WHERE domain = ?').get(domain);
}

/**
 * Get anchor by ID.
 */
export function getAnchorById(id) {
  return getDb().prepare('SELECT * FROM anchors WHERE id = ?').get(id);
}

/**
 * Get all anchors matching filters.
 */
export function getAnchors({ status, healthStatus, trustLevel, minCompleteness } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM anchors WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (healthStatus) {
    sql += ' AND health_status = ?';
    params.push(healthStatus);
  }
  if (trustLevel) {
    sql += ' AND trust_level = ?';
    params.push(trustLevel);
  }
  if (minCompleteness != null) {
    sql += ' AND completeness_score >= ?';
    params.push(minCompleteness);
  }

  sql += ' ORDER BY completeness_score DESC, health_score DESC';
  return db.prepare(sql).all(...params);
}

/**
 * Get all active anchor domains that need crawling (TTL expired).
 */
export function getStaleAnchors(ttlMs) {
  const db = getDb();
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  return db.prepare(`
    SELECT * FROM anchors
    WHERE last_crawled_at IS NULL
       OR last_crawled_at < ?
    ORDER BY last_crawled_at ASC NULLS FIRST
  `).all(cutoff);
}

/**
 * Get count of anchors by status.
 */
export function getAnchorStats() {
  const db = getDb();
  return {
    total: db.prepare('SELECT COUNT(*) as count FROM anchors').get().count,
    active: db.prepare("SELECT COUNT(*) as count FROM anchors WHERE status = 'active'").get().count,
    error: db.prepare("SELECT COUNT(*) as count FROM anchors WHERE status = 'error'").get().count,
    healthy: db.prepare("SELECT COUNT(*) as count FROM anchors WHERE health_status = 'healthy'").get().count,
    degraded: db.prepare("SELECT COUNT(*) as count FROM anchors WHERE health_status = 'degraded'").get().count,
    offline: db.prepare("SELECT COUNT(*) as count FROM anchors WHERE health_status = 'offline'").get().count,
  };
}

// ═══════════════════════════════════════════════════════════════
// ANCHOR ASSETS CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * Upsert an anchor asset (currency).
 */
export function upsertAnchorAsset(anchorId, asset) {
  const db = getDb();

  const existing = db.prepare(
    'SELECT id FROM anchor_assets WHERE code = ? AND issuer = ?'
  ).get(asset.code, asset.issuer);

  if (existing) {
    db.prepare(`
      UPDATE anchor_assets SET
        anchor_id = ?, asset_type = ?, status = ?,
        is_deposit_enabled = ?, is_withdraw_enabled = ?,
        fee_fixed = ?, fee_percent = ?, min_amount = ?, max_amount = ?,
        sep38_supported = ?, description = ?,
        is_on_chain = ?, horizon_validated_at = ?,
        num_accounts = ?, amount_circulating = ?,
        anchor_name = ?, display_decimals = ?,
        conditions = ?, is_asset_anchored = ?,
        anchor_asset_type = ?, redemption_instructions = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      anchorId, asset.assetType, asset.status || 'active',
      asset.isDepositEnabled ? 1 : 0, asset.isWithdrawEnabled ? 1 : 0,
      asset.feeFixed, asset.feePercent, asset.minAmount, asset.maxAmount,
      asset.sep38Supported ? 1 : 0, asset.description,
      asset.isOnChain ? 1 : 0, asset.horizonValidatedAt,
      asset.numAccounts, asset.amountCirculating,
      asset.anchorName, asset.displayDecimals,
      asset.conditions, asset.isAssetAnchored ? 1 : 0,
      asset.anchorAssetType, asset.redemptionInstructions,
      existing.id
    );
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO anchor_assets (
        anchor_id, code, issuer, asset_type, status,
        is_deposit_enabled, is_withdraw_enabled,
        fee_fixed, fee_percent, min_amount, max_amount,
        sep38_supported, description,
        is_on_chain, horizon_validated_at,
        num_accounts, amount_circulating,
        anchor_name, display_decimals,
        conditions, is_asset_anchored,
        anchor_asset_type, redemption_instructions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      anchorId, asset.code, asset.issuer, asset.assetType, asset.status || 'active',
      asset.isDepositEnabled ? 1 : 0, asset.isWithdrawEnabled ? 1 : 0,
      asset.feeFixed, asset.feePercent, asset.minAmount, asset.maxAmount,
      asset.sep38Supported ? 1 : 0, asset.description,
      asset.isOnChain ? 1 : 0, asset.horizonValidatedAt,
      asset.numAccounts, asset.amountCirculating,
      asset.anchorName, asset.displayDecimals,
      asset.conditions, asset.isAssetAnchored ? 1 : 0,
      asset.anchorAssetType, asset.redemptionInstructions
    );
    return Number(result.lastInsertRowid);
  }
}

/**
 * Get all assets for an anchor.
 */
export function getAnchorAssets(anchorId) {
  return getDb().prepare(
    'SELECT * FROM anchor_assets WHERE anchor_id = ? ORDER BY code'
  ).all(anchorId);
}

/**
 * Get all verified on-chain assets across all active anchors.
 * This is the primary data contract for Phase 3 (Asset Registry).
 */
export function getAllVerifiedAssets() {
  return getDb().prepare(`
    SELECT aa.*, a.domain as anchor_domain, a.name as anchor_display_name,
           a.health_status as anchor_health, a.trust_level as anchor_trust
    FROM anchor_assets aa
    JOIN anchors a ON aa.anchor_id = a.id
    WHERE aa.is_on_chain = 1
      AND aa.status = 'active'
      AND a.status = 'active'
    ORDER BY aa.code, a.completeness_score DESC
  `).all();
}

/**
 * Remove stale assets for an anchor (assets no longer in TOML).
 */
export function deactivateRemovedAssets(anchorId, currentAssetKeys) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, code, issuer FROM anchor_assets WHERE anchor_id = ?'
  ).all(anchorId);

  const currentSet = new Set(currentAssetKeys); // Set of "CODE:ISSUER"
  let deactivated = 0;

  for (const asset of existing) {
    const key = `${asset.code}:${asset.issuer}`;
    if (!currentSet.has(key)) {
      db.prepare("UPDATE anchor_assets SET status = 'inactive', updated_at = datetime('now') WHERE id = ?")
        .run(asset.id);
      deactivated++;
    }
  }

  return deactivated;
}

// ═══════════════════════════════════════════════════════════════
// CRAWL LOG
// ═══════════════════════════════════════════════════════════════

/**
 * Record a crawl attempt in the audit log.
 */
export function logCrawl(domain, status, assetsFound, durationMs, errorMessage) {
  getDb().prepare(`
    INSERT INTO crawl_log (anchor_domain, status, assets_found, duration_ms, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(domain, status, assetsFound, durationMs, errorMessage);
}

/**
 * Get recent crawl history for a domain.
 */
export function getCrawlHistory(domain, limit = 10) {
  return getDb().prepare(
    'SELECT * FROM crawl_log WHERE anchor_domain = ? ORDER BY created_at DESC LIMIT ?'
  ).all(domain, limit);
}

export default {
  upsertAnchor, incrementCrawlCount, markAnchorError,
  getAnchorByDomain, getAnchorById, getAnchors, getStaleAnchors, getAnchorStats,
  upsertAnchorAsset, getAnchorAssets, getAllVerifiedAssets, deactivateRemovedAssets,
  logCrawl, getCrawlHistory,
};
