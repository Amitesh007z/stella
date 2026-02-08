// ─── Stella Protocol — Migration: 001 Initial Schema ──────────
// Core tables for anchors, assets, and route cache.

export const name = '001_initial_schema';

export function up(db) {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════
    -- ANCHORS — Discovered anchor metadata
    -- ═══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS anchors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      domain          TEXT    NOT NULL UNIQUE,
      name            TEXT,
      transfer_server TEXT,
      transfer_server_sep24 TEXT,
      quote_server    TEXT,
      web_auth_endpoint TEXT,
      toml_raw        TEXT,
      status          TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'error', 'unreachable')),
      last_crawled_at TEXT,
      last_error      TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_anchors_status ON anchors(status);
    CREATE INDEX IF NOT EXISTS idx_anchors_domain ON anchors(domain);

    -- ═══════════════════════════════════════════════════════════
    -- ANCHOR ASSETS — Assets issued by specific anchors
    -- ═══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS anchor_assets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_id       INTEGER NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
      code            TEXT    NOT NULL,
      issuer          TEXT    NOT NULL,
      asset_type      TEXT    NOT NULL DEFAULT 'credit_alphanum4'
                      CHECK (asset_type IN ('credit_alphanum4', 'credit_alphanum12', 'native')),
      status          TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'unverified')),
      is_deposit_enabled   INTEGER NOT NULL DEFAULT 0,
      is_withdraw_enabled  INTEGER NOT NULL DEFAULT 0,
      fee_fixed       REAL,
      fee_percent     REAL,
      min_amount      REAL,
      max_amount      REAL,
      sep38_supported INTEGER NOT NULL DEFAULT 0,
      description     TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(code, issuer)
    );

    CREATE INDEX IF NOT EXISTS idx_anchor_assets_code ON anchor_assets(code);
    CREATE INDEX IF NOT EXISTS idx_anchor_assets_issuer ON anchor_assets(issuer);
    CREATE INDEX IF NOT EXISTS idx_anchor_assets_anchor ON anchor_assets(anchor_id);

    -- ═══════════════════════════════════════════════════════════
    -- ASSETS — Global asset registry (union of anchor + discovered)
    -- ═══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS assets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT    NOT NULL,
      issuer          TEXT,
      asset_type      TEXT    NOT NULL DEFAULT 'credit_alphanum4'
                      CHECK (asset_type IN ('credit_alphanum4', 'credit_alphanum12', 'native')),
      domain          TEXT,
      name            TEXT,
      description     TEXT,
      is_verified     INTEGER NOT NULL DEFAULT 0,
      num_accounts    INTEGER DEFAULT 0,
      amount          TEXT,
      source          TEXT    NOT NULL DEFAULT 'horizon'
                      CHECK (source IN ('horizon', 'anchor', 'manual')),
      last_updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(code, issuer)
    );

    CREATE INDEX IF NOT EXISTS idx_assets_code ON assets(code);
    CREATE INDEX IF NOT EXISTS idx_assets_issuer ON assets(issuer);

    -- ═══════════════════════════════════════════════════════════
    -- ROUTE CACHE — Cached route computation results
    -- ═══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS route_cache (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key       TEXT    NOT NULL UNIQUE,
      source_asset    TEXT    NOT NULL,
      dest_asset      TEXT    NOT NULL,
      source_amount   TEXT    NOT NULL,
      routes_json     TEXT    NOT NULL,
      computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_route_cache_key ON route_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_route_cache_expires ON route_cache(expires_at);

    -- ═══════════════════════════════════════════════════════════
    -- CRAWL LOG — Audit trail for anchor crawls
    -- ═══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS crawl_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_domain   TEXT    NOT NULL,
      status          TEXT    NOT NULL CHECK (status IN ('success', 'error')),
      assets_found    INTEGER DEFAULT 0,
      duration_ms     INTEGER,
      error_message   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_log_domain ON crawl_log(anchor_domain);
    CREATE INDEX IF NOT EXISTS idx_crawl_log_created ON crawl_log(created_at);
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS crawl_log;
    DROP TABLE IF EXISTS route_cache;
    DROP TABLE IF EXISTS assets;
    DROP TABLE IF EXISTS anchor_assets;
    DROP TABLE IF EXISTS anchors;
  `);
}
