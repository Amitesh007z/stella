// ─── Stella Protocol — Route Integrity Registry Service ─────────
// Handles commitment storage and verification.
// In production, this would interact with the Soroban smart contract.
// Currently uses local SQLite storage for development/testing.
'use strict';

import crypto from 'crypto';
import db from '../../db/index.js';
import logger from '../../lib/logger.js';

const log = logger.child({ service: 'registry' });

// ─── Initialize Registry Table ────────────────────────────────
async function initRegistryTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS route_commitments (
      route_hash TEXT PRIMARY KEY,
      rules_hash TEXT NOT NULL,
      solver_version_hash TEXT NOT NULL,
      committer TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      expiry INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await db.run(`CREATE INDEX IF NOT EXISTS idx_commitments_timestamp ON route_commitments(timestamp)`);
  log.info('Registry table initialized');
}

// Initialize on module load
initRegistryTable().catch(err => log.error({ err }, 'Failed to init registry table'));

// ─── Commit a Route ───────────────────────────────────────────
export async function commitRoute({ routeHash, rulesHash, solverVersionHash, expiry = 0, committer = 'stella-protocol' }) {
  // Validate inputs
  if (!routeHash || routeHash.length !== 64) {
    throw new Error('Invalid route_hash: must be 64-character hex');
  }
  if (!rulesHash || rulesHash.length !== 64) {
    throw new Error('Invalid rules_hash: must be 64-character hex');
  }
  if (!solverVersionHash || solverVersionHash.length !== 64) {
    throw new Error('Invalid solver_version_hash: must be 64-character hex');
  }
  
  // Check for all zeros
  if (/^0+$/.test(routeHash)) {
    throw new Error('route_hash cannot be all zeros');
  }
  
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Validate expiry
  if (expiry > 0 && expiry <= timestamp) {
    throw new Error('expiry must be in the future');
  }
  
  // Check for duplicate
  const existing = await db.get('SELECT route_hash FROM route_commitments WHERE route_hash = ?', routeHash);
  if (existing) {
    throw new Error('Commitment already exists for this route_hash');
  }
  
  // Store commitment
  await db.run(`
    INSERT INTO route_commitments (route_hash, rules_hash, solver_version_hash, committer, timestamp, expiry)
    VALUES (?, ?, ?, ?, ?, ?)
  `, routeHash, rulesHash, solverVersionHash, committer, timestamp, expiry);
  
  log.info({ routeHash: routeHash.slice(0, 16) + '...' }, 'Route commitment stored');
  
  return {
    routeHash,
    rulesHash,
    solverVersionHash,
    committer,
    timestamp,
    expiry,
  };
}

// ─── Get Commitment by Route Hash ─────────────────────────────
export async function getCommitment(routeHash) {
  if (!routeHash || routeHash.length !== 64) {
    throw new Error('Invalid route_hash: must be 64-character hex');
  }
  
  const row = await db.get(`
    SELECT route_hash, rules_hash, solver_version_hash, committer, timestamp, expiry
    FROM route_commitments
    WHERE route_hash = ?
  `, routeHash);
  
  if (!row) {
    throw new Error('Commitment not found');
  }
  
  return {
    routeHash: row.route_hash,
    rulesHash: row.rules_hash,
    solverVersionHash: row.solver_version_hash,
    committer: row.committer,
    timestamp: row.timestamp,
    expiry: row.expiry,
  };
}

// ─── Verify Commitment ────────────────────────────────────────
export async function verifyCommitment({ routeHash, rulesHash, solverHash }) {
  try {
    const commitment = await getCommitment(routeHash);
    
    const verified = 
      commitment.rulesHash === rulesHash &&
      commitment.solverVersionHash === solverHash;
    
    return {
      verified,
      timestamp: commitment.timestamp,
      expiry: commitment.expiry,
      committer: commitment.committer,
    };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

// ─── Check if Commitment Exists ───────────────────────────────
export async function hasCommitment(routeHash) {
  const row = await db.get('SELECT 1 FROM route_commitments WHERE route_hash = ?', routeHash);
  return !!row;
}

// ─── Get Registry Stats ───────────────────────────────────────
export async function getStats() {
  const total = await db.get('SELECT COUNT(*) as count FROM route_commitments');
  const recent = await db.get(`
    SELECT COUNT(*) as count FROM route_commitments 
    WHERE timestamp > ?
  `, Math.floor(Date.now() / 1000) - 86400); // Last 24h
  
  const oldest = await db.get('SELECT MIN(timestamp) as ts FROM route_commitments');
  const newest = await db.get('SELECT MAX(timestamp) as ts FROM route_commitments');
  
  return {
    totalCommitments: total?.count || 0,
    last24h: recent?.count || 0,
    oldestTimestamp: oldest?.ts || null,
    newestTimestamp: newest?.ts || null,
    contractStatus: 'local-simulation', // Would be 'deployed' when on Soroban
  };
}

// ─── Hash Helpers for Creating Commitments ────────────────────
export function hashRouteManifest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function hashRulesConfig(rules) {
  return crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

export function hashSolverVersion(version) {
  return crypto.createHash('sha256').update(version).digest('hex');
}

// ─── Auto-Commit a Quote Result ───────────────────────────────
// Called internally when a quote is generated
export async function autoCommitQuote(quote, rules = {}) {
  try {
    const routeManifest = {
      sourceAsset: quote.sourceAsset,
      destAsset: quote.destAsset,
      amount: quote.amount,
      routes: quote.routes?.map(r => ({
        path: r.path,
        receiveAmount: r.receiveAmount,
        score: r.score,
      })),
      timestamp: quote.createdAt,
    };
    
    const rulesConfig = {
      strategy: rules.strategy || 'best_output',
      maxHops: rules.maxHops || 4,
      minLiquidity: rules.minLiquidity || 0,
      ...rules,
    };
    
    const solverVersion = process.env.SOLVER_VERSION || 'stella-v1.0.0';
    
    const routeHash = hashRouteManifest(routeManifest);
    const rulesHash = hashRulesConfig(rulesConfig);
    const solverVersionHash = hashSolverVersion(solverVersion);
    
    const commitment = await commitRoute({
      routeHash,
      rulesHash,
      solverVersionHash,
      expiry: quote.expiresAt ? Math.floor(new Date(quote.expiresAt).getTime() / 1000) : 0,
    });
    
    return {
      ...commitment,
      // Return raw data for verification
      _routeManifest: routeManifest,
      _rulesConfig: rulesConfig,
      _solverVersion: solverVersion,
    };
  } catch (err) {
    // Don't fail quote generation if commitment fails
    log.warn({ err }, 'Failed to auto-commit quote');
    return null;
  }
}

export default {
  commitRoute,
  getCommitment,
  verifyCommitment,
  hasCommitment,
  getStats,
  hashRouteManifest,
  hashRulesConfig,
  hashSolverVersion,
  autoCommitQuote,
};
