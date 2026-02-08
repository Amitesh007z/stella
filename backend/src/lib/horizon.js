// ─── Stella Protocol — Horizon Client ──────────────────────────
// Singleton Stellar SDK Horizon server instance.
// All Horizon queries go through this module.

import * as StellarSdk from '@stellar/stellar-sdk';
import config from '../config/index.js';
import { createLogger } from './logger.js';

const log = createLogger('horizon');

// ─── Network Passphrase Setup ──────────────────────────────────
if (config.network === 'stellar_testnet') {
  StellarSdk.Networks.TESTNET;
} else {
  StellarSdk.Networks.PUBLIC;
}

// ─── Horizon Server ────────────────────────────────────────────
const horizon = new StellarSdk.Horizon.Server(config.horizonUrl);

/**
 * Verify Horizon connectivity. Called at startup.
 * Returns the latest ledger sequence number.
 */
export async function checkHorizonHealth() {
  try {
    const root = await horizon.ledgers().order('desc').limit(1).call();
    const latestLedger = root.records[0];
    log.info(
      { ledger: latestLedger.sequence, closedAt: latestLedger.closed_at },
      'Horizon connected — latest ledger'
    );
    return {
      ok: true,
      ledger: latestLedger.sequence,
      closedAt: latestLedger.closed_at,
      horizonUrl: config.horizonUrl,
      network: config.network,
    };
  } catch (err) {
    log.error({ err }, 'Horizon health check failed');
    return { ok: false, error: err.message };
  }
}

/**
 * Load an account from Horizon.
 */
export async function loadAccount(publicKey) {
  return horizon.loadAccount(publicKey);
}

/**
 * Check if an account (e.g., anchor issuer) exists on the network.
 */
export async function accountExists(publicKey) {
  try {
    await horizon.loadAccount(publicKey);
    return true;
  } catch (err) {
    if (err?.response?.status === 404) return false;
    throw err;
  }
}

/**
 * Strict-send path query — core of route discovery.
 */
export async function findStrictSendPaths({ sourceAsset, sourceAmount, destinationAssets }) {
  return horizon
    .strictSendPaths(sourceAsset, sourceAmount, destinationAssets)
    .call();
}

/**
 * Strict-receive path query.
 */
export async function findStrictReceivePaths({ destinationAsset, destinationAmount, sourceAccount }) {
  return horizon
    .strictReceivePaths(sourceAccount, destinationAsset, destinationAmount)
    .call();
}

/**
 * Fetch orderbook for a trading pair.
 */
export async function getOrderbook(selling, buying, limit = 20) {
  return horizon.orderbook(selling, buying).limit(limit).call();
}

/**
 * Query assets on the network.
 */
export async function queryAssets({ code, issuer, limit = 200 } = {}) {
  let builder = horizon.assets();
  if (code) builder = builder.forCode(code);
  if (issuer) builder = builder.forIssuer(issuer);
  return builder.limit(limit).call();
}

// Re-export SDK and horizon for direct use when needed
export { StellarSdk, horizon };
export default horizon;
