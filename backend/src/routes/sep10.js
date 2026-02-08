// ─── SEP-10 Web Authentication Routes ──────────────────────────
// API routes for SEP-10 challenge/response flow with wallet signing.
// v2 — testnet safety: localhost detection, health checks, graceful
//       degradation, network-scoped caching, observability.

import { createLogger } from '../lib/logger.js';
import { Errors } from '../plugins/errorHandler.js';
import config from '../config/index.js';

const log = createLogger('sep10-routes');

// ─── Constants ─────────────────────────────────────────────────
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;           // 5 s for health probe
const TOML_CACHE_TTL_MS = 30 * 60 * 1000;        // 30 min for TOML cache

// ─── Network helpers ───────────────────────────────────────────
const isTestnet = () => config.network === 'stellar_testnet';

/** Detect if a URL points to localhost / loopback / non-routable. */
function isLocalhostEndpoint(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

// ─── Token cache — network-scoped ──────────────────────────────
const tokenCache = new Map();

function tokenCacheKey(anchorDomain, userPublicKey) {
  return `${config.network}:${anchorDomain}:${userPublicKey}`;
}

// ─── TOML / endpoint cache — network-scoped ────────────────────
const tomlCache = new Map();

function tomlCacheKey(anchorDomain) {
  return `${config.network}:${anchorDomain}`;
}

// ─── Observability ─────────────────────────────────────────────
const sep10Metrics = {
  challengeRequests: 0,
  challengeSuccesses: 0,
  challengeFailures: 0,
  submitRequests: 0,
  submitSuccesses: 0,
  submitFailures: 0,
  healthChecks: { attempted: 0, passed: 0, failed: 0 },
  localhostSkips: 0,
  testnetDegradations: 0,
  failuresByCategory: new Map(), // category → count
};

/**
 * Fetch with timeout and descriptive error messages.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    const hostname = safeHostname(url);
    if (error.cause?.code === 'ENOTFOUND') {
      throw new Error(`DNS lookup failed for ${hostname}`);
    }
    if (error.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Connection refused by ${hostname} — is the auth server running?`);
    }
    if (error.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || 
        error.cause?.code === 'CERT_HAS_EXPIRED' ||
        error.message?.includes('certificate')) {
      throw new Error(`SSL certificate error for ${hostname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * Health-check the auth endpoint before making a challenge request.
 * On testnet, if the endpoint is unreachable, we degrade gracefully
 * instead of throwing a hard error.
 *
 * @returns {{ reachable: boolean, reason?: string }}
 */
async function healthCheckEndpoint(url) {
  sep10Metrics.healthChecks.attempted++;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      // Any HTTP response (even 4xx) means the server is reachable
      sep10Metrics.healthChecks.passed++;
      return { reachable: true };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    sep10Metrics.healthChecks.failed++;
    const reason = error.name === 'AbortError'
      ? 'timeout'
      : error.cause?.code || error.message;
    log.warn({ url, reason }, 'SEP-10 health check failed');
    return { reachable: false, reason };
  }
}

function recordFailureCategory(category) {
  sep10Metrics.failuresByCategory.set(
    category,
    (sep10Metrics.failuresByCategory.get(category) || 0) + 1
  );
}

/**
 * Register SEP-10 routes
 * @param {FastifyInstance} fastify - Fastify instance
 */
export async function sep10Routes(fastify) {

  // POST /sep10/challenge
  // Get challenge XDR from anchor for signing
  fastify.post('/sep10/challenge', {
    schema: {
      body: {
        type: 'object',
        required: ['anchorDomain', 'userPublicKey'],
        properties: {
          anchorDomain: { type: 'string', minLength: 1 },
          userPublicKey: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
          webAuthEndpoint: { type: 'string', format: 'uri' }
        }
      }
    }
  }, async (request, reply) => {
    const { anchorDomain, userPublicKey, webAuthEndpoint } = request.body;
    sep10Metrics.challengeRequests++;

    try {
      // Discover web auth endpoint if not provided
      const authEndpoint = webAuthEndpoint || await discoverWebAuthEndpoint(anchorDomain);
      if (!authEndpoint) {
        throw new Error(`No WEB_AUTH_ENDPOINT found for ${anchorDomain}`);
      }

      // ── Localhost detection ────────────────────────────────
      if (isLocalhostEndpoint(authEndpoint)) {
        sep10Metrics.localhostSkips++;
        const msg = `WEB_AUTH_ENDPOINT for ${anchorDomain} points to localhost (${authEndpoint})`;
        log.warn({ anchorDomain, authEndpoint }, msg);

        if (isTestnet()) {
          // On testnet, surface a clear warning but don't block
          return {
            success: false,
            error: 'auth_endpoint_localhost',
            message: `${msg}. On testnet this is expected for some anchors — SEP-10 auth skipped.`,
            anchorDomain,
            authEndpoint,
          };
        }
        // On pubnet, this is always wrong
        throw Errors.badRequest(`${msg}. The anchor TOML has a misconfigured WEB_AUTH_ENDPOINT.`);
      }

      // ── Health check before challenge ──────────────────────
      const health = await healthCheckEndpoint(authEndpoint);
      if (!health.reachable) {
        recordFailureCategory('endpoint_unreachable');

        if (isTestnet()) {
          sep10Metrics.testnetDegradations++;
          log.warn({ anchorDomain, authEndpoint, reason: health.reason },
            'SEP-10 auth endpoint unreachable on testnet — degrading gracefully');
          return {
            success: false,
            error: 'auth_endpoint_unreachable',
            message: `Auth endpoint ${authEndpoint} is unreachable (${health.reason}). On testnet this may be expected.`,
            anchorDomain,
            authEndpoint,
            reason: health.reason,
          };
        }
        throw Errors.anchorUnavailable(
          `Auth endpoint ${authEndpoint} is unreachable: ${health.reason}`
        );
      }

      // ── Fetch challenge ────────────────────────────────────
      const challengeUrl = new URL(authEndpoint);
      challengeUrl.searchParams.set('account', userPublicKey);
      challengeUrl.searchParams.set('home_domain', anchorDomain);

      log.debug({ url: challengeUrl.toString(), anchorDomain }, 'Fetching SEP-10 challenge');

      const challengeResponse = await fetchWithTimeout(challengeUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!challengeResponse.ok) {
        const text = await challengeResponse.text();
        recordFailureCategory(`challenge_http_${challengeResponse.status}`);
        throw new Error(`Challenge request failed: ${challengeResponse.status} - ${text}`);
      }

      const challengeData = await challengeResponse.json();
      
      if (!challengeData.transaction) {
        recordFailureCategory('challenge_missing_xdr');
        throw new Error('Challenge response missing transaction XDR');
      }

      // ── Network passphrase check ─────────────────────────
      const challengeNetwork = challengeData.network_passphrase;
      const expectedNetwork = config.networkPassphrase;
      if (challengeNetwork && challengeNetwork !== expectedNetwork) {
        recordFailureCategory('network_mismatch');
        log.error({
          anchorDomain, challengeNetwork, expectedNetwork,
        }, 'SEP-10 challenge network mismatch — anchor is on a different Stellar network');
        throw Errors.badRequest(
          `Network mismatch: ${anchorDomain} returned a challenge for ` +
          `"${challengeNetwork.slice(0, 40)}..." but you are on ` +
          `"${expectedNetwork.slice(0, 40)}...". ` +
          `This anchor may only support ${challengeNetwork.includes('Test') ? 'testnet' : 'mainnet'}.`
        );
      }

      sep10Metrics.challengeSuccesses++;
      log.info({ anchorDomain, account: userPublicKey, network: challengeNetwork || expectedNetwork },
        'SEP-10 challenge obtained');

      return {
        success: true,
        challengeXdr: challengeData.transaction,
        networkPassphrase: challengeNetwork || expectedNetwork,
        authEndpoint
      };

    } catch (error) {
      sep10Metrics.challengeFailures++;
      // Don't double-wrap errors that already have proper HTTP status
      if (error.statusCode) throw error;
      log.error({ error: error.message, anchorDomain, account: userPublicKey }, 'SEP-10 challenge fetch failed');
      throw Errors.badRequest(`Failed to get challenge: ${error.message}`);
    }
  });

  // POST /sep10/submit
  // Submit signed challenge to get JWT token
  fastify.post('/sep10/submit', {
    schema: {
      body: {
        type: 'object',
        required: ['signedXdr', 'authEndpoint', 'anchorDomain', 'userPublicKey'],
        properties: {
          signedXdr: { type: 'string', minLength: 1 },
          authEndpoint: { type: 'string', format: 'uri' },
          anchorDomain: { type: 'string', minLength: 1 },
          userPublicKey: { type: 'string', pattern: '^G[A-Z2-7]{55}$' }
        }
      }
    }
  }, async (request, reply) => {
    const { signedXdr, authEndpoint, anchorDomain, userPublicKey } = request.body;
    sep10Metrics.submitRequests++;

    try {
      log.debug({ authEndpoint, anchorDomain }, 'Submitting signed challenge');

      const authResponse = await fetchWithTimeout(authEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ transaction: signedXdr })
      });

      if (!authResponse.ok) {
        const text = await authResponse.text();
        recordFailureCategory(`submit_http_${authResponse.status}`);

        // ── Provide actionable error for common 403 causes ──
        if (authResponse.status === 403) {
          const lower = text.toLowerCase();
          const isPermission = lower.includes('permission') || lower.includes('forbidden') || lower.includes('not allowed');
          const networkHint = isTestnet()
            ? ` This anchor (${anchorDomain}) may be mainnet-only and not accessible from testnet.`
            : '';
          throw new Error(
            `Anchor ${anchorDomain} rejected authentication (403 Forbidden). ` +
            (isPermission
              ? `The anchor says: ${text.slice(0, 200)}.${networkHint} ` +
                `Possible causes: (1) the anchor only operates on a different Stellar network, ` +
                `(2) your account is not registered with this anchor, ` +
                `(3) the anchor requires KYC or whitelisting before auth.`
              : `Response: ${text.slice(0, 200)}.${networkHint}`)
          );
        }

        throw new Error(`Auth submission failed: ${authResponse.status} - ${text}`);
      }

      const authData = await authResponse.json();
      
      if (!authData.token) {
        recordFailureCategory('submit_missing_token');
        throw new Error('Auth response missing JWT token');
      }

      // Cache the token — network-scoped
      const cacheKey = tokenCacheKey(anchorDomain, userPublicKey);
      const tokenObj = {
        token: authData.token,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
        account: userPublicKey,
        anchorDomain,
        network: config.network,
        obtainedAt: new Date().toISOString()
      };
      tokenCache.set(cacheKey, tokenObj);

      sep10Metrics.submitSuccesses++;
      log.info({ anchorDomain, account: userPublicKey, network: config.network },
        'SEP-10 authentication successful');

      return {
        success: true,
        token: authData.token,
        expiresAt: tokenObj.expiresAt
      };

    } catch (error) {
      sep10Metrics.submitFailures++;
      log.error({ error: error.message, anchorDomain, account: userPublicKey }, 'SEP-10 token submission failed');
      throw Errors.badRequest(`Authentication failed: ${error.message}`);
    }
  });

  // POST /sep10/token — get cached token if available
  fastify.post('/sep10/token', {
    schema: {
      body: {
        type: 'object',
        required: ['anchorDomain', 'userPublicKey'],
        properties: {
          anchorDomain: { type: 'string', minLength: 1 },
          userPublicKey: { type: 'string', pattern: '^G[A-Z2-7]{55}$' }
        }
      }
    }
  }, async (request, reply) => {
    const { anchorDomain, userPublicKey } = request.body;
    const cacheKey = tokenCacheKey(anchorDomain, userPublicKey);
    const cached = tokenCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return {
        success: true,
        hasToken: true,
        token: cached.token,
        expiresAt: cached.expiresAt
      };
    }

    return {
      success: true,
      hasToken: false
    };
  });

  // GET /sep10/diagnostics — observability for auth failures
  fastify.get('/sep10/diagnostics', async () => {
    const failuresByCategory = {};
    for (const [cat, count] of sep10Metrics.failuresByCategory.entries()) {
      failuresByCategory[cat] = count;
    }

    return {
      version: 'v2-testnet-safe',
      network: config.network,
      isTestnet: isTestnet(),
      challenge: {
        requests: sep10Metrics.challengeRequests,
        successes: sep10Metrics.challengeSuccesses,
        failures: sep10Metrics.challengeFailures,
      },
      submit: {
        requests: sep10Metrics.submitRequests,
        successes: sep10Metrics.submitSuccesses,
        failures: sep10Metrics.submitFailures,
      },
      healthChecks: sep10Metrics.healthChecks,
      localhostSkips: sep10Metrics.localhostSkips,
      testnetDegradations: sep10Metrics.testnetDegradations,
      failuresByCategory,
      tokenCacheSize: tokenCache.size,
      tomlCacheSize: tomlCache.size,
    };
  });

  log.info({ network: config.network, isTestnet: isTestnet() },
    'SEP-10 routes registered (v2: testnet-safe + health-checks + network-scoped cache)');
}

/**
 * Auto-discover web auth endpoint from stellar.toml.
 * Network-scoped: caches per-network to avoid cross-network token confusion.
 * On testnet, returns early with clear warnings for localhost endpoints.
 */
async function discoverWebAuthEndpoint(anchorDomain) {
  // Check TOML cache (network-scoped)
  const cacheKey = tomlCacheKey(anchorDomain);
  const cached = tomlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    log.debug({ anchorDomain, endpoint: cached.endpoint }, 'WEB_AUTH_ENDPOINT from cache');
    return cached.endpoint;
  }

  const tomlUrl = `https://${anchorDomain}/.well-known/stellar.toml`;
  log.debug({ tomlUrl, anchorDomain, network: config.network }, 'Discovering WEB_AUTH_ENDPOINT');
  
  let response;
  try {
    response = await fetchWithTimeout(tomlUrl, { method: 'GET' }, 10_000);
  } catch (error) {
    log.warn({ anchorDomain, error: error.message }, 'Failed to fetch stellar.toml');
    recordFailureCategory('toml_fetch_failed');
    throw new Error(`Cannot reach anchor ${anchorDomain}: ${error.message}`);
  }
  
  if (!response.ok) {
    recordFailureCategory(`toml_http_${response.status}`);
    throw new Error(`Anchor ${anchorDomain} returned ${response.status} for stellar.toml`);
  }

  const tomlText = await response.text();
  const lines = tomlText.split('\n');
  
  let endpoint = null;
  let anchorNetwork = null;
  for (const line of lines) {
    const authMatch = line.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/);
    if (authMatch) endpoint = authMatch[1];
    const netMatch = line.match(/NETWORK_PASSPHRASE\s*=\s*"([^"]+)"/);
    if (netMatch) anchorNetwork = netMatch[1];
  }

  if (!endpoint) {
    recordFailureCategory('toml_missing_web_auth');
    throw new Error(`Anchor ${anchorDomain} stellar.toml missing WEB_AUTH_ENDPOINT (SEP-10 not supported)`);
  }

  // ── Network mismatch detection ─────────────────────────
  // If anchor declares a NETWORK_PASSPHRASE, check it matches ours.
  // Most pubnet anchors omit it (pubnet is the default), so if absent
  // AND we're on testnet, that's very likely a pubnet-only anchor.
  const ourNetwork = config.networkPassphrase;
  if (anchorNetwork && anchorNetwork !== ourNetwork) {
    log.warn({ anchorDomain, anchorNetwork, ourNetwork },
      'Network mismatch: anchor is on a different Stellar network');
    throw new Error(
      `Anchor ${anchorDomain} operates on a different network. ` +
      `Anchor: "${anchorNetwork.slice(0, 30)}...", Ours: "${ourNetwork.slice(0, 30)}...". ` +
      `You may be on testnet trying to reach a mainnet anchor, or vice versa.`
    );
  }
  if (!anchorNetwork && isTestnet()) {
    // Pubnet anchors typically don't declare NETWORK_PASSPHRASE (it's the default).
    // If WE are on testnet and the anchor didn't declare it, warn that this is
    // probably a pubnet anchor.
    log.warn({ anchorDomain, endpoint },
      'Anchor TOML has no NETWORK_PASSPHRASE and we are on testnet — likely a pubnet-only anchor');
  }

  // Cache it (network-scoped)
  tomlCache.set(cacheKey, { endpoint, anchorNetwork, expiresAt: Date.now() + TOML_CACHE_TTL_MS });
  log.debug({ anchorDomain, endpoint, network: config.network }, 'WEB_AUTH_ENDPOINT discovered and cached');
  return endpoint;
}

/**
 * Get cached token - exported for use by other services (network-scoped).
 */
export function getCachedToken(anchorDomain, userPublicKey) {
  const cacheKey = tokenCacheKey(anchorDomain, userPublicKey);
  const cached = tokenCache.get(cacheKey);
  
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  
  if (cached) tokenCache.delete(cacheKey);
  return null;
}

/**
 * Store token in cache - exported for use by other services (network-scoped).
 */
export function setCachedToken(anchorDomain, userPublicKey, token, expiresAt) {
  const cacheKey = tokenCacheKey(anchorDomain, userPublicKey);
  const tokenObj = {
    token,
    expiresAt: expiresAt || Date.now() + TOKEN_CACHE_TTL_MS,
    account: userPublicKey,
    anchorDomain,
    network: config.network,
    obtainedAt: new Date().toISOString()
  };
  tokenCache.set(cacheKey, tokenObj);
  return tokenObj;
}
