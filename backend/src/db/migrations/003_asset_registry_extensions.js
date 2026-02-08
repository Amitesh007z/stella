// ─── Stella Protocol — Migration: 003 Asset Registry Extensions ─
// Extends the assets table for full registry support:
// anchor linking, popularity tracking, canonical identifiers.

export const name = '003_asset_registry_extensions';

export function up(db) {
  // ── Link assets to their anchor(s) ──────────────────
  db.exec(`ALTER TABLE assets ADD COLUMN anchor_id INTEGER REFERENCES anchors(id);`);
  db.exec(`ALTER TABLE assets ADD COLUMN anchor_domain TEXT;`);
  
  // ── Popularity / activity metrics ───────────────────
  db.exec(`ALTER TABLE assets ADD COLUMN trade_count INTEGER DEFAULT 0;`);
  db.exec(`ALTER TABLE assets ADD COLUMN bid_count INTEGER DEFAULT 0;`);
  db.exec(`ALTER TABLE assets ADD COLUMN ask_count INTEGER DEFAULT 0;`);
  
  // ── Anchoring metadata ──────────────────────────────
  db.exec(`ALTER TABLE assets ADD COLUMN is_anchor_asset INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE assets ADD COLUMN anchor_asset_type TEXT;`);
  db.exec(`ALTER TABLE assets ADD COLUMN anchor_asset_code TEXT;`);
  
  // ── Deposit/Withdraw capability (propagated from anchor_assets) ──
  db.exec(`ALTER TABLE assets ADD COLUMN is_deposit_enabled INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE assets ADD COLUMN is_withdraw_enabled INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE assets ADD COLUMN sep38_supported INTEGER NOT NULL DEFAULT 0;`);
  
  // ── Display fields ──────────────────────────────────
  db.exec(`ALTER TABLE assets ADD COLUMN image_url TEXT;`);
  db.exec(`ALTER TABLE assets ADD COLUMN display_decimals INTEGER DEFAULT 7;`);
  
  // ── Composite index for route graph lookups ─────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_verified ON assets(is_verified, source);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_anchor ON assets(anchor_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_code_issuer ON assets(code, issuer);`);
}

export function down(db) {
  // SQLite ALTER TABLE DROP COLUMN requires 3.35.0+
}
