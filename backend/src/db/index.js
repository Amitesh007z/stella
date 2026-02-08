// ─── Stella Protocol — Database Initialization ────────────────
// SQLite via better-sqlite3. Synchronous, fast, zero-config.
// All tables created via migrations.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import config from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');

let db = null;

/**
 * Initialize the SQLite database.
 * Creates the data directory if it doesn't exist.
 * Enables WAL mode for concurrent reads.
 */
export function initDb() {
  if (db) return db;

  const dbDir = dirname(config.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    log.info({ dir: dbDir }, 'Created database directory');
  }

  db = new Database(config.dbPath);

  // ── Performance pragmas ──────────────────────────
  db.pragma('journal_mode = WAL');        // Write-Ahead Logging
  db.pragma('synchronous = NORMAL');       // Balance safety/speed
  db.pragma('foreign_keys = ON');          // Enforce FK constraints
  db.pragma('cache_size = -64000');        // 64MB cache
  db.pragma('busy_timeout = 5000');        // 5s lock wait

  // ── Internal migration tracking table ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT    NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  log.info({ path: config.dbPath }, 'Database initialized');
  return db;
}

/**
 * Get the active database instance. Throws if not initialized.
 */
export function getDb() {
  if (!db) throw new Error('[db] Database not initialized. Call initDb() first.');
  return db;
}

/**
 * Close the database connection gracefully.
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
    log.info('Database connection closed');
  }
}

export default { initDb, getDb, closeDb };
