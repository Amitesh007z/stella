// ─── Stella Protocol — Migration Runner ───────────────────────
// Discovers and applies pending migrations in order.
// Can be run standalone: node src/db/migrate.js

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initDb } from './index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('migrate');
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const db = initDb();

  // ── Discover migration files ─────────────────────
  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.js'))
    .sort();

  // ── Get already applied migrations ───────────────
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r) => r.name)
  );

  let count = 0;

  for (const file of files) {
    const migrationPath = pathToFileURL(join(migrationsDir, file)).href;
    const migration = await import(migrationPath);
    const migrationName = migration.name || file;

    if (applied.has(migrationName)) {
      log.debug({ name: migrationName }, 'Skipping (already applied)');
      continue;
    }

    log.info({ name: migrationName }, 'Applying migration...');

    const runInTransaction = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migrationName);
    });

    runInTransaction();
    count++;
    log.info({ name: migrationName }, 'Migration applied ✓');
  }

  if (count === 0) {
    log.info('All migrations already applied — nothing to do');
  } else {
    log.info({ count }, 'Migrations complete');
  }

  return count;
}

// ── Allow standalone execution ──────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  runMigrations()
    .then((n) => {
      log.info({ applied: n }, 'Migration runner complete');
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, 'Migration runner failed');
      process.exit(1);
    });
}
