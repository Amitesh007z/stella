// ─── Stella Protocol — Migration: 002 Anchor Capability Index ──
// Extends anchors + anchor_assets tables for full capability indexing.

export const name = '002_anchor_capability_index';

export function up(db) {
  // ── Extend anchors table ────────────────────────────
  db.exec(`
    ALTER TABLE anchors ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'discovered'
      CHECK (trust_level IN ('seeded', 'discovered', 'community'));
  `);
  db.exec(`ALTER TABLE anchors ADD COLUMN completeness_score REAL NOT NULL DEFAULT 0.0;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN health_score REAL NOT NULL DEFAULT 0.0;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('healthy', 'degraded', 'offline', 'unknown'));`);
  db.exec(`ALTER TABLE anchors ADD COLUMN toml_version TEXT;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN horizon_validated_at TEXT;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN crawl_success_count INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN crawl_fail_count INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE anchors ADD COLUMN signing_key TEXT;`);

  // ── Extend anchor_assets table ──────────────────────
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN is_on_chain INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN horizon_validated_at TEXT;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN num_accounts INTEGER DEFAULT 0;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN amount_circulating TEXT;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN anchor_name TEXT;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN display_decimals INTEGER DEFAULT 7;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN conditions TEXT;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN is_asset_anchored INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN anchor_asset_type TEXT;`);
  db.exec(`ALTER TABLE anchor_assets ADD COLUMN redemption_instructions TEXT;`);
}

export function down(db) {
  // SQLite doesn't support DROP COLUMN cleanly prior to 3.35.0
  // For dev: just recreate tables via migration 001 down + up
}
