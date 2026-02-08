// ─── Trustline Checker Service ─────────────────────────────────
// Validates user account trustlines required for SEP-24 flows.
// Before initiating deposits/withdrawals, ensures user can hold
// the necessary assets on-chain.
//
// Functions:
// - Check if user has trustline for specific asset
// - Get missing trustlines for a route
// - Generate trustline creation transactions
// - Validate account existence and state

import StellarSdk from '@stellar/stellar-sdk';
import { createLogger } from '../../lib/logger.js';
import config from '../../config/index.js';
import { parseAssetKey } from '../graph/routeGraph.js';

const { Asset } = StellarSdk;

const log = createLogger('trustline-checker');

/**
 * @typedef {object} TrustlineInfo
 * @property {string} assetCode - Asset code
 * @property {string} assetIssuer - Asset issuer public key
 * @property {boolean} exists - Whether trustline exists
 * @property {string} [balance] - Current balance (if trustline exists)
 * @property {string} [limit] - Trust limit (if trustline exists)
 * @property {boolean} [authorized] - Whether trustline is authorized
 */

/**
 * @typedef {object} AccountTrustlines
 * @property {string} accountId - Stellar account public key
 * @property {boolean} accountExists - Whether account exists on ledger
 * @property {TrustlineInfo[]} trustlines - All trustlines
 * @property {TrustlineInfo[]} missingTrustlines - Required but missing trustlines
 * @property {object} account - Raw Horizon account data (if exists)
 */

class TrustlineChecker {
  constructor() {
    this.horizon = new StellarSdk.Horizon.Server(config.horizonUrl);
    this.cache = new Map(); // Cache account data for 30s
    this.cacheTimeout = 30000;
  }

  /**
   * Check if user has trustlines for all assets in a route
   * @param {string} userPublicKey - User's Stellar account
   * @param {string[]} assetKeys - Asset keys in stellar:CODE:ISSUER format
   * @returns {Promise<AccountTrustlines>} Trustline analysis 
   */
  async checkRouteTrustlines(userPublicKey, assetKeys) {
    log.info({ 
      account: userPublicKey, 
      assetsCount: assetKeys.length 
    }, 'Checking route trustlines');

    try {
      const account = await this._loadAccount(userPublicKey);
      
      if (!account) {
        return {
          accountId: userPublicKey,
          accountExists: false,
          trustlines: [],
          missingTrustlines: assetKeys.map(assetKey => this._parseAssetInfo(assetKey)),
          account: null
        };
      }

      const requiredAssets = assetKeys
        .filter(key => !key.startsWith('stellar:XLM:')) // Skip native XLM
        .map(key => this._parseAssetInfo(key));

      const existingTrustlines = this._extractTrustlines(account);
      const missingTrustlines = [];

      for (const requiredAsset of requiredAssets) {
        const exists = existingTrustlines.some(tl => 
          tl.assetCode === requiredAsset.assetCode && 
          tl.assetIssuer === requiredAsset.assetIssuer
        );

        if (!exists) {
          missingTrustlines.push({
            ...requiredAsset,
            exists: false
          });
        }
      }

      const result = {
        accountId: userPublicKey,
        accountExists: true,
        trustlines: existingTrustlines,
        missingTrustlines,
        account
      };

      log.info({
        account: userPublicKey,
        existingTrustlines: existingTrustlines.length,
        missingTrustlines: missingTrustlines.length
      }, 'Trustline check complete');

      return result;

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey
      }, 'Trustline check failed');
      throw error;
    }
  }

  /**
   * Check trustline for specific asset
   * @param {string} userPublicKey - User's Stellar account
   * @param {string} assetCode - Asset code (e.g., 'USD')
   * @param {string} assetIssuer - Asset issuer public key
   * @returns {Promise<TrustlineInfo>} Trustline information
   */
  async checkAssetTrustline(userPublicKey, assetCode, assetIssuer) {
    try {
      const account = await this._loadAccount(userPublicKey);
      
      if (!account) {
        return {
          assetCode,
          assetIssuer,
          exists: false
        };
      }

      const trustlines = this._extractTrustlines(account);
      const trustline = trustlines.find(tl => 
        tl.assetCode === assetCode && 
        tl.assetIssuer === assetIssuer
      );

      if (trustline) {
        return trustline;
      }

      return {
        assetCode,
        assetIssuer,
        exists: false
      };

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey,
        assetCode,
        assetIssuer
      }, 'Asset trustline check failed');
      throw error;
    }
  }

  /**
   * Generate change trust operation for missing trustlines
   * @param {TrustlineInfo[]} missingTrustlines - Assets that need trustlines
   * @returns {object[]} Stellar SDK change trust operations
   */
  generateTrustlineOperations(missingTrustlines) {
    const operations = missingTrustlines.map(tl => {
      const asset = new Asset(tl.assetCode, tl.assetIssuer);
      return {
        type: 'changeTrust',
        asset: asset,
        // Default limit - user can change this
        limit: undefined // No limit = maximum possible
      };
    });

    log.info({
      operationsCount: operations.length,
      assets: missingTrustlines.map(tl => `${tl.assetCode}:${tl.assetIssuer.slice(0, 8)}...`)
    }, 'Generated trustline operations');

    return operations;
  }

  /**
   * Check if account can receive asset after trustline creation
   * @param {string} userPublicKey - User account
   * @param {string} assetCode - Asset code
   * @param {string} assetIssuer - Asset issuer
   * @returns {Promise<boolean>} Whether asset is receivable
   */
  async canReceiveAsset(userPublicKey, assetCode, assetIssuer) {
    try {
      // For native XLM, always receivable
      if (assetCode === 'XLM' && !assetIssuer) {
        return true;
      }

      // Check if issuer account exists and allows trustlines
      const issuerAccount = await this._loadAccount(assetIssuer);
      
      if (!issuerAccount) {
        log.warn({ assetCode, assetIssuer }, 'Asset issuer account not found');
        return false;
      }

      // Check for auth required flags
      const authRequired = issuerAccount.flags.auth_required;
      const authRevocable = issuerAccount.flags.auth_revocable;

      if (authRequired) {
        log.info({ 
          assetCode, 
          assetIssuer,
          authRequired,
          authRevocable 
        }, 'Asset requires authorization from issuer');
        // Return true but note that user will need issuer authorization
        return true;
      }

      return true;

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey,
        assetCode,
        assetIssuer
      }, 'Failed to check asset receivability');
      return false;
    }
  }

  /**
   * Load account from Horizon with caching
   * @private
   */
  async _loadAccount(publicKey) {
    const cacheKey = publicKey;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.account;
    }

    try {
      const account = await this.horizon.loadAccount(publicKey);
      this.cache.set(cacheKey, {
        account,
        timestamp: Date.now()
      });
      return account;
    } catch (error) {
      if (error.status === 404) {
        // Account doesn't exist
        this.cache.set(cacheKey, {
          account: null,
          timestamp: Date.now()
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * Extract trustline information from account data
   * @private
   */
  _extractTrustlines(account) {
    return account.balances
      .filter(balance => balance.asset_type !== 'native')
      .map(balance => ({
        assetCode: balance.asset_code,
        assetIssuer: balance.asset_issuer,
        exists: true,
        balance: balance.balance,
        limit: balance.limit,
        authorized: !balance.is_authorized ? false : true
      }));
  }

  /**
   * Parse asset key into components
   * @private
   */
  _parseAssetInfo(assetKey) {
    try {
      const parsed = parseAssetKey(assetKey);
      return {
        assetCode: parsed.code,
        assetIssuer: parsed.issuer,
        exists: false
      };
    } catch (error) {
      log.error({ error: error.message, assetKey }, 'Failed to parse asset key');
      throw new Error(`Invalid asset key format: ${assetKey}`);
    }
  }

  /**
   * Clear account cache for specific account or all accounts
   * @param {string} [publicKey] - Specific account to clear, or all if omitted
   */
  clearCache(publicKey) {
    if (publicKey) {
      this.cache.delete(publicKey);
      log.debug({ account: publicKey }, 'Cleared account cache');
    } else {
      this.cache.clear();
      log.debug('Cleared all account cache');
    }
  }

  /**
   * Get cache statistics
   * @returns {object} Cache stats
   */
  getCacheStats() {
    const now = Date.now();
    const entries = Array.from(this.cache.values());
    const active = entries.filter(entry => now - entry.timestamp < this.cacheTimeout);
    
    return {
      totalEntries: entries.length,
      activeEntries: active.length,
      expiredEntries: entries.length - active.length,
      cacheHitRate: entries.length > 0 ? (active.length / entries.length) : 0
    };
  }
}

export const trustlineChecker = new TrustlineChecker();