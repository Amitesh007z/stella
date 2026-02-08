// ─── Stella Protocol — Asset Repository ───────────────────────
// Database access layer for the global `assets` table.
// All asset DB reads/writes go through here.
// This is the single source of truth for the Asset Registry.

import { getDb } from '../../db/index.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('asset-repo');

/**
 * Upsert an asset into the global registry.
 * Merges Horizon data + Anchor data into a single record.
 */
export function upsertAsset(asset) {
  const db = getDb();

  // Use NULL for native XLM issuer in unique constraint
  const issuer = asset.issuer || null;

  const existing = db.prepare(
    'SELECT id, source, is_verified FROM assets WHERE code = ? AND (issuer = ? OR (issuer IS NULL AND ? IS NULL))'
  ).get(asset.code, issuer, issuer);

  if (existing) {
    // ── Update — merge fields, preserve higher-trust source ───
    const newSource = resolveSource(existing.source, asset.source);
    const isVerified = asset.isVerified ? 1 : (existing.is_verified || 0);

    db.prepare(`
      UPDATE assets SET
        asset_type = COALESCE(?, asset_type),
        domain = COALESCE(?, domain),
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        is_verified = MAX(?, is_verified),
        num_accounts = COALESCE(?, num_accounts),
        amount = COALESCE(?, amount),
        source = ?,
        anchor_id = COALESCE(?, anchor_id),
        anchor_domain = COALESCE(?, anchor_domain),
        trade_count = COALESCE(?, trade_count),
        is_anchor_asset = COALESCE(?, is_anchor_asset),
        anchor_asset_type = COALESCE(?, anchor_asset_type),
        anchor_asset_code = COALESCE(?, anchor_asset_code),
        is_deposit_enabled = MAX(COALESCE(?, 0), is_deposit_enabled),
        is_withdraw_enabled = MAX(COALESCE(?, 0), is_withdraw_enabled),
        sep38_supported = MAX(COALESCE(?, 0), sep38_supported),
        image_url = COALESCE(?, image_url),
        display_decimals = COALESCE(?, display_decimals),
        last_updated_at = datetime('now')
      WHERE id = ?
    `).run(
      asset.assetType,
      asset.domain,
      asset.name,
      asset.description,
      isVerified,
      asset.numAccounts,
      asset.amount,
      newSource,
      asset.anchorId,
      asset.anchorDomain,
      asset.tradeCount,
      asset.isAnchorAsset ? 1 : 0,
      asset.anchorAssetType,
      asset.anchorAssetCode,
      asset.isDepositEnabled ? 1 : 0,
      asset.isWithdrawEnabled ? 1 : 0,
      asset.sep38Supported ? 1 : 0,
      asset.imageUrl,
      asset.displayDecimals,
      existing.id
    );

    log.debug({ code: asset.code, issuer, id: existing.id }, 'Asset updated');
    return existing.id;
  } else {
    // ── Insert new asset ──────────────────────────────
    const result = db.prepare(`
      INSERT INTO assets (
        code, issuer, asset_type, domain, name, description,
        is_verified, num_accounts, amount, source,
        anchor_id, anchor_domain, trade_count,
        is_anchor_asset, anchor_asset_type, anchor_asset_code,
        is_deposit_enabled, is_withdraw_enabled, sep38_supported,
        image_url, display_decimals
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.code,
      issuer,
      asset.assetType || 'credit_alphanum4',
      asset.domain,
      asset.name,
      asset.description,
      asset.isVerified ? 1 : 0,
      asset.numAccounts || 0,
      asset.amount,
      asset.source || 'horizon',
      asset.anchorId,
      asset.anchorDomain,
      asset.tradeCount || 0,
      asset.isAnchorAsset ? 1 : 0,
      asset.anchorAssetType,
      asset.anchorAssetCode,
      asset.isDepositEnabled ? 1 : 0,
      asset.isWithdrawEnabled ? 1 : 0,
      asset.sep38Supported ? 1 : 0,
      asset.imageUrl,
      asset.displayDecimals || 7
    );

    log.debug({ code: asset.code, issuer, id: result.lastInsertRowid }, 'Asset created');
    return Number(result.lastInsertRowid);
  }
}

/**
 * Batch upsert assets (wrapped in a transaction for speed).
 */
export function batchUpsertAssets(assets) {
  const db = getDb();
  const upserted = [];

  const runBatch = db.transaction(() => {
    for (const asset of assets) {
      const id = upsertAsset(asset);
      upserted.push({ id, code: asset.code, issuer: asset.issuer });
    }
  });

  runBatch();
  return upserted;
}

/**
 * Get assets with flexible filtering.
 */
export function getAssets({
  code,
  issuer,
  domain,
  source,
  isVerified,
  isDepositEnabled,
  isWithdrawEnabled,
  search,
  sortBy = 'num_accounts',
  sortOrder = 'DESC',
  limit = 100,
  offset = 0,
} = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM assets WHERE 1=1';
  const params = [];

  if (code) {
    sql += ' AND UPPER(code) = UPPER(?)';
    params.push(code);
  }
  if (issuer) {
    sql += ' AND issuer = ?';
    params.push(issuer);
  }
  if (domain) {
    sql += ' AND domain = ?';
    params.push(domain);
  }
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  if (isVerified !== undefined) {
    sql += ' AND is_verified = ?';
    params.push(isVerified ? 1 : 0);
  }
  if (isDepositEnabled !== undefined) {
    sql += ' AND is_deposit_enabled = ?';
    params.push(isDepositEnabled ? 1 : 0);
  }
  if (isWithdrawEnabled !== undefined) {
    sql += ' AND is_withdraw_enabled = ?';
    params.push(isWithdrawEnabled ? 1 : 0);
  }
  if (search) {
    sql += ' AND (UPPER(code) LIKE UPPER(?) OR UPPER(name) LIKE UPPER(?) OR domain LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  // ── Validate sort field ─────────────────────────────
  const allowedSort = ['num_accounts', 'code', 'amount', 'last_updated_at', 'created_at'];
  const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'num_accounts';
  const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  sql += ` ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/**
 * Count assets matching filters (for pagination).
 */
export function countAssets(filters = {}) {
  const db = getDb();
  let sql = 'SELECT COUNT(*) as count FROM assets WHERE 1=1';
  const params = [];

  if (filters.code) { sql += ' AND UPPER(code) = UPPER(?)'; params.push(filters.code); }
  if (filters.source) { sql += ' AND source = ?'; params.push(filters.source); }
  if (filters.isVerified !== undefined) { sql += ' AND is_verified = ?'; params.push(filters.isVerified ? 1 : 0); }
  if (filters.search) {
    sql += ' AND (UPPER(code) LIKE UPPER(?) OR UPPER(name) LIKE UPPER(?) OR domain LIKE ?)';
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  return db.prepare(sql).get(...params).count;
}

/**
 * Get a single asset by code + issuer (canonical lookup).
 */
export function getAssetByIdentifier(code, issuer) {
  const db = getDb();
  if (!issuer || issuer === 'native') {
    return db.prepare('SELECT * FROM assets WHERE code = ? AND issuer IS NULL').get(code);
  }
  return db.prepare('SELECT * FROM assets WHERE code = ? AND issuer = ?').get(code, issuer);
}

/**
 * Get all unique asset codes (for autocomplete / picker).
 */
export function getAssetCodes() {
  return getDb().prepare(
    'SELECT DISTINCT code, COUNT(*) as issuer_count FROM assets GROUP BY code ORDER BY issuer_count DESC'
  ).all();
}

/**
 * Get asset registry stats.
 */
export function getAssetStats() {
  const db = getDb();
  return {
    total: db.prepare('SELECT COUNT(*) as c FROM assets').get().c,
    verified: db.prepare('SELECT COUNT(*) as c FROM assets WHERE is_verified = 1').get().c,
    fromHorizon: db.prepare("SELECT COUNT(*) as c FROM assets WHERE source = 'horizon'").get().c,
    fromAnchor: db.prepare("SELECT COUNT(*) as c FROM assets WHERE source = 'anchor'").get().c,
    depositEnabled: db.prepare('SELECT COUNT(*) as c FROM assets WHERE is_deposit_enabled = 1').get().c,
    withdrawEnabled: db.prepare('SELECT COUNT(*) as c FROM assets WHERE is_withdraw_enabled = 1').get().c,
    uniqueCodes: db.prepare('SELECT COUNT(DISTINCT code) as c FROM assets').get().c,
  };
}

/**
 * Get assets suitable for the route graph (Phase 4 data contract).
 * Returns only verified + active assets with enough presence.
 */
export function getRoutableAssets() {
  return getDb().prepare(`
    SELECT * FROM assets
    WHERE is_verified = 1
       OR source = 'anchor'
       OR num_accounts >= 1
    ORDER BY num_accounts DESC
  `).all();
}

/**
 * Source priority: anchor > horizon > manual.
 * Anchor-sourced data is more trusted than raw Horizon.
 */
function resolveSource(existingSource, newSource) {
  const priority = { anchor: 3, horizon: 2, manual: 1 };
  const existingPrio = priority[existingSource] || 0;
  const newPrio = priority[newSource] || 0;
  return newPrio >= existingPrio ? newSource : existingSource;
}

export default {
  upsertAsset, batchUpsertAssets,
  getAssets, countAssets, getAssetByIdentifier,
  getAssetCodes, getAssetStats, getRoutableAssets,
};
