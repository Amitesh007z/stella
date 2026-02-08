// ─── SEP-10 Web Authentication Service ─────────────────────────
// Implements SEP-10 challenge/response flow to obtain JWT tokens
// from anchors for authenticated access to SEP-6/24/38 endpoints.
//
// Flow:
// 1. GET /auth?account=GCXXX&home_domain=anchor.com → challenge transaction
// 2. Sign challenge with user's keypair
// 3. POST /auth with signed transaction → JWT token
// 4. Use JWT in Authorization: Bearer header for anchor APIs

import StellarSdk from '@stellar/stellar-sdk';
import { createLogger } from '../../lib/logger.js';
import config from '../../config/index.js';

const { Keypair, TransactionBuilder, Networks, Utils } = StellarSdk;

const log = createLogger('sep10-auth');

// Token cache - in production, use Redis or secure storage
const tokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * @typedef {object} AuthToken
 * @property {string} token - JWT token
 * @property {number} expiresAt - Unix timestamp
 * @property {string} account - Stellar account public key
 * @property {string} anchorDomain - Anchor domain
 */

class SEP10AuthService {
  constructor() {
    this.horizon = new StellarSdk.Horizon.Server(config.horizonUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Get authentication token for user account with specific anchor
   * @param {string} anchorDomain - Anchor domain (e.g., 'anclap.com')
   * @param {string} userPublicKey - User's Stellar public key
   * @param {string} userSecretKey - User's Stellar secret key
   * @param {string} [webAuthEndpoint] - SEP-10 endpoint URL (optional, will auto-discover)
   * @returns {Promise<AuthToken>} JWT token with metadata
   */
  async getAuthToken(anchorDomain, userPublicKey, userSecretKey, webAuthEndpoint) {
    const cacheKey = `${anchorDomain}:${userPublicKey}`;
    
    // Check cache first
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      log.debug({ anchorDomain, account: userPublicKey }, 'Using cached SEP-10 token');
      return cached;
    }

    log.info({ anchorDomain, account: userPublicKey }, 'Fetching new SEP-10 token');

    try {
      // Step 1: Discover web auth endpoint if not provided
      const authEndpoint = webAuthEndpoint || await this._discoverWebAuthEndpoint(anchorDomain);
      if (!authEndpoint) {
        throw new Error(`No WEB_AUTH_ENDPOINT found for ${anchorDomain}`);
      }

      // Step 2: Get challenge transaction
      const challengeUrl = new URL(authEndpoint);
      challengeUrl.searchParams.set('account', userPublicKey);
      challengeUrl.searchParams.set('home_domain', anchorDomain);

      const challengeResponse = await fetch(challengeUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (!challengeResponse.ok) {
        throw new Error(`Challenge request failed: ${challengeResponse.status} ${challengeResponse.statusText}`);
      }

      const challengeData = await challengeResponse.json();
      
      if (!challengeData.transaction) {
        throw new Error('Challenge response missing transaction');
      }

      log.debug({ anchorDomain, account: userPublicKey }, 'Received challenge transaction');

      // Step 3: Sign challenge transaction
      const userKeypair = Keypair.fromSecret(userSecretKey);
      const transaction = TransactionBuilder.fromXDR(challengeData.transaction, this.networkPassphrase);
      
      // Verify challenge is valid
      this._validateChallenge(transaction, userPublicKey, anchorDomain);
      
      transaction.sign(userKeypair);
      const signedTxXdr = transaction.toXDR();

      // Step 4: Submit signed challenge to get JWT
      const authResponse = await fetch(authEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ transaction: signedTxXdr }),
        timeout: 10000
      });

      if (!authResponse.ok) {
        throw new Error(`Auth submission failed: ${authResponse.status} ${authResponse.statusText}`);
      }

      const authData = await authResponse.json();
      
      if (!authData.token) {
        throw new Error('Auth response missing JWT token');
      }

      // Step 5: Cache token
      const tokenObj = {
        token: authData.token,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
        account: userPublicKey,
        anchorDomain,
        obtainedAt: new Date().toISOString()
      };

      tokenCache.set(cacheKey, tokenObj);

      log.info({ anchorDomain, account: userPublicKey }, 'SEP-10 authentication successful');
      return tokenObj;

    } catch (error) {
      log.error({ 
        error: error.message, 
        anchorDomain, 
        account: userPublicKey 
      }, 'SEP-10 authentication failed');
      throw error;
    }
  }

  /**
   * Get cached token without making new requests
   * @param {string} anchorDomain - Anchor domain
   * @param {string} userPublicKey - User public key
   * @returns {AuthToken|null} Cached token or null if expired/missing
   */
  getCachedToken(anchorDomain, userPublicKey) {
    const cacheKey = `${anchorDomain}:${userPublicKey}`;
    const cached = tokenCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }
    
    // Clean up expired token
    if (cached) {
      tokenCache.delete(cacheKey);
    }
    
    return null;
  }

  /**
   * Clear cached token for account/anchor pair
   * @param {string} anchorDomain - Anchor domain
   * @param {string} userPublicKey - User public key
   */
  clearToken(anchorDomain, userPublicKey) {
    const cacheKey = `${anchorDomain}:${userPublicKey}`;
    tokenCache.delete(cacheKey);
    log.debug({ anchorDomain, account: userPublicKey }, 'Cleared SEP-10 token from cache');
  }

  /**
   * Auto-discover web auth endpoint from stellar.toml
   * @private
   */
  async _discoverWebAuthEndpoint(anchorDomain) {
    try {
      const tomlUrl = `https://${anchorDomain}/.well-known/stellar.toml`;
      const response = await fetch(tomlUrl, { timeout: 10000 });
      
      if (!response.ok) {
        log.warn({ anchorDomain }, 'Could not fetch stellar.toml for auth endpoint discovery');
        return null;
      }

      const tomlText = await response.text();
      const lines = tomlText.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('WEB_AUTH_ENDPOINT')) {
          const match = line.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/);
          if (match) {
            return match[1];
          }
        }
      }
      
      return null;
    } catch (error) {
      log.error({ error: error.message, anchorDomain }, 'Failed to discover web auth endpoint');
      return null;
    }
  }

  /**
   * Validate challenge transaction meets SEP-10 requirements
   * @private
   */
  _validateChallenge(transaction, userPublicKey, anchorDomain) {
    // Basic validation - in production, add more comprehensive checks:
    // - Sequence number is 0
    // - Contains manage_data operation with proper domain
    // - Source account matches user
    // - Network is correct
    
    if (transaction.source !== userPublicKey) {
      throw new Error('Challenge transaction source does not match user account');
    }

    const hasManageDataOp = transaction.operations.some(op => 
      op.type === 'manageData' && 
      op.name && 
      op.name.includes(anchorDomain)
    );

    if (!hasManageDataOp) {
      throw new Error('Challenge transaction missing required manage_data operation');
    }

    log.debug('Challenge transaction validation passed');
  }

  /**
   * Get stats about cached tokens
   * @returns {object} Cache statistics
   */
  getStats() {
    const now = Date.now();
    const tokens = Array.from(tokenCache.values());
    
    return {
      totalTokens: tokens.length,
      activeTokens: tokens.filter(t => t.expiresAt > now).length,
      expiredTokens: tokens.filter(t => t.expiresAt <= now).length,
      domains: [...new Set(tokens.map(t => t.anchorDomain))],
      oldestToken: tokens.length > 0 ? Math.min(...tokens.map(t => t.expiresAt)) : null
    };
  }
}

export const sep10AuthService = new SEP10AuthService();