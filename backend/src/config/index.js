// ─── Stella Protocol — Centralized Configuration ───────────────
// All env vars parsed, validated, and exported from a single source.
// Every module imports config from here — never reads process.env directly.

import 'dotenv/config';

function required(key) {
  const val = process.env[key];
  if (val === undefined || val === '') {
    throw new Error(`[config] Missing required env var: ${key}`);
  }
  return val;
}

function optional(key, fallback) {
  const val = process.env[key];
  return val !== undefined && val !== '' ? val : fallback;
}

function int(key, fallback) {
  const raw = optional(key, String(fallback));
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`[config] ${key} must be an integer`);
  return parsed;
}

function float(key, fallback) {
  const raw = optional(key, String(fallback));
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) throw new Error(`[config] ${key} must be a number`);
  return parsed;
}

// ─── Stellar Network Mapping ──────────────────────────────────
const NETWORK_PASSPHRASES = {
  stellar_testnet: 'Test SDF Network ; September 2015',
  stellar_pubnet: 'Public Global Stellar Network ; September 2015',
};

const HORIZON_DEFAULTS = {
  stellar_testnet: 'https://horizon-testnet.stellar.org',
  stellar_pubnet: 'https://horizon.stellar.org',
};

const networkId = optional('STELLAR_NETWORK', 'stellar_testnet');

if (!NETWORK_PASSPHRASES[networkId]) {
  throw new Error(`[config] Unknown STELLAR_NETWORK: ${networkId}. Use stellar_testnet or stellar_pubnet`);
}

const config = Object.freeze({
  // ── Server ───────────────────────────────────────
  host: optional('HOST', '0.0.0.0'),
  port: int('PORT', 3001),

  // ── Stellar ──────────────────────────────────────
  network: networkId,
  networkPassphrase: NETWORK_PASSPHRASES[networkId],
  horizonUrl: optional('HORIZON_URL', HORIZON_DEFAULTS[networkId]),

  // ── Database ─────────────────────────────────────
  dbPath: optional('DB_PATH', './data/stella.db'),

  // ── Logging ──────────────────────────────────────
  logLevel: optional('LOG_LEVEL', 'info'),

  // ── Route Engine ─────────────────────────────────
  maxHops: int('MAX_HOPS', 4),
  maxRoutesPerDest: int('MAX_ROUTES_PER_DEST', 5),
  maxRoutesGlobal: int('MAX_ROUTES_GLOBAL', 20),
  orderbookMinDepth: float('ORDERBOOK_MIN_DEPTH', 0.01),

  // ── Anchor Crawl ─────────────────────────────────
  anchorCrawlIntervalMs: int('ANCHOR_CRAWL_INTERVAL_MS', 3600000),
  anchorCacheTtlMs: int('ANCHOR_CACHE_TTL_MS', 1800000),
});

export default config;
