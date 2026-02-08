// ─── SEP-24 Interactive Flow Routes ────────────────────────────
// Universally compatible SEP-24 interactive deposit/withdraw launcher.
// Defaults to application/json (testanchor & Polaris-based anchors reject
// form-encoded), auto-discovers TRANSFER_SERVER_SEP0024, caches per-anchor
// content-type profiles, retries with alternate Content-Type on 415 / 500
// content-type errors AND on the "param echo" heuristic (anchor says a param
// is missing but we know we sent it → body wasn't parsed → CT mismatch).

import { createLogger } from '../lib/logger.js';
import { Errors } from '../plugins/errorHandler.js';
import { getAnchorByDomain } from '../services/anchor/anchorRepository.js';

const log = createLogger('sep24-routes');

// ─── Constants ─────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 20_000;          // 20 s default
const CACHE_TTL_MS = 30 * 60 * 1000;  // 30 min for endpoint cache
const PROFILE_TTL_MS = 60 * 60 * 1000;  // 60 min for content-type profile
const MAX_CT_RETRIES = 2;               // try up to 3 CTs (form → JSON → multipart)
const MAX_REDIRECT_HOPS = 3;               // follow at most 3 redirects

const CONTENT_TYPES = {
  FORM: 'application/x-www-form-urlencoded',
  JSON: 'application/json',
  MULTIPART: 'multipart/form-data',
};

// Build stamp — increment to verify fresh server is loaded
const BUILD_STAMP = '2026-02-08T6';

// Default strategy order: JSON → multipart → form.
// JSON is first because testanchor (Polaris-based) returns 500 for form-encoded:
//   "Content-Type 'application/x-www-form-urlencoded' is not supported"
// Multipart is second per SEP-24 spec recommendation.
// Form-encoded is last as a fallback for older/custom anchors.
const CT_STRATEGY = [CONTENT_TYPES.JSON, CONTENT_TYPES.MULTIPART, CONTENT_TYPES.FORM];

// ─── Error taxonomy ────────────────────────────────────────────
const ERR_CLASS = {
  UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',
  INVALID_PARAMETERS: 'invalid_parameters',
  NETWORK_MISMATCH: 'network_mismatch',
  ANCHOR_INTERNAL: 'anchor_internal_error',
  TIMEOUT: 'timeout',
  REDIRECT_LOOP: 'redirect_loop',
  UNKNOWN: 'unknown',
};

// Required param names that anchors echo in 400 errors when they can't parse the body.
// When we SENT a param but the anchor says it's missing, that's a content-type parse
// failure — not a real missing-param error.
// NOTE: asset_issuer is excluded — the error "asset_code must be set" when we send
// a mismatched issuer is an ASSET LOOKUP failure, not a body-parse failure.
const REQUIRED_PARAM_NAMES = ['asset_code', 'account', 'amount'];

/**
 * Classify an HTTP error response into a standard error bucket.
 *
 * @param {number} status - HTTP status code from the anchor.
 * @param {string} bodyText - Raw response body text.
 * @param {Record<string,string>|null} sentParams - The params we actually sent.
 * @param {string|null} usedContentType - The Content-Type we actually used in the request.
 *        JSON bodies are ALWAYS parseable, so param-echo heuristic is SKIPPED for JSON.
 */
function classifyError(status, bodyText, sentParams = null, usedContentType = null) {
  const lower = (bodyText || '').toLowerCase();
  const isJSON = usedContentType && usedContentType.includes('application/json');

  // ── Explicit content-type signals (always applies) ────────
  if (status === 415 || lower.includes('unsupported media')) {
    return ERR_CLASS.UNSUPPORTED_CONTENT_TYPE;
  }
  if ((status === 400 || status === 500) &&
    (lower.includes('content-type') || lower.includes('content_type'))) {
    return ERR_CLASS.UNSUPPORTED_CONTENT_TYPE;
  }
  // Only classify parse/json errors as CT issues for non-JSON requests
  if (!isJSON && (status === 400 || status === 500) &&
    (lower.includes('not supported') || lower.includes('parse error') ||
      lower.includes('invalid json') || lower.includes('json parse'))) {
    return ERR_CLASS.UNSUPPORTED_CONTENT_TYPE;
  }

  // ── "Param echo" heuristic ─────────────────────────────────
  // Check if the anchor says a parameter is missing that we actually SENT.
  // This usually means they couldn't parse the body (Content-Type mismatch).
  if (status === 400 && sentParams) {
    for (const paramName of REQUIRED_PARAM_NAMES) {
      if (sentParams[paramName] && lower.includes(paramName)) {
        log.info({ paramName, sentValue: sentParams[paramName] },
          'Param-echo: anchor says param missing but we sent it → CT mismatch');
        return ERR_CLASS.UNSUPPORTED_CONTENT_TYPE;
      }
    }
    if (lower.includes('must be set') || lower.includes('is required') ||
      lower.includes('missing required')) {
      for (const [key, val] of Object.entries(sentParams)) {
        if (val && lower.includes(key)) {
          log.info({ key }, 'Generic param-echo → CT mismatch');
          return ERR_CLASS.UNSUPPORTED_CONTENT_TYPE;
        }
      }
    }
  }

  if (status === 400) return ERR_CLASS.INVALID_PARAMETERS;
  if (status === 403 && lower.includes('network')) return ERR_CLASS.NETWORK_MISMATCH;
  if (status >= 500) return ERR_CLASS.ANCHOR_INTERNAL;
  return ERR_CLASS.UNKNOWN;
}

// ─── Per-Anchor Request Profile Cache ──────────────────────────
// Keyed by anchorDomain → { preferredContentType, lastSuccessFormat,
//   lastFailureReason, updatedAt }
const anchorProfiles = new Map();

function getAnchorProfile(domain) {
  const p = anchorProfiles.get(domain);
  if (p && (Date.now() - p.updatedAt) < PROFILE_TTL_MS) return p;
  return null;
}

function setAnchorProfile(domain, patch) {
  const existing = anchorProfiles.get(domain) || {
    preferredContentType: CONTENT_TYPES.JSON,    // JSON works on testanchor + Polaris
    lastSuccessFormat: null,
    lastFailureReason: null,
    attempts: { json: 0, form: 0, multipart: 0 },
    successes: { json: 0, form: 0, multipart: 0 },
    retries: 0,
  };
  anchorProfiles.set(domain, { ...existing, ...patch, updatedAt: Date.now() });
}

// ─── Observability counters ────────────────────────────────────
const metrics = {
  totalInitiations: 0,
  successByContentType: { json: 0, form: 0, multipart: 0 },
  failureByContentType: { json: 0, form: 0, multipart: 0 },
  retryCount: 0,
  redirectsFollowed: 0,
  anchorErrors: new Map(),   // domain → [{ ts, errClass, status }]
};

function ctKey(ct) {
  if (ct === CONTENT_TYPES.JSON) return 'json';
  if (ct === CONTENT_TYPES.MULTIPART) return 'multipart';
  return 'form';
}

function recordSuccess(domain, contentType) {
  const key = ctKey(contentType);
  metrics.successByContentType[key]++;
  const profile = getAnchorProfile(domain);
  setAnchorProfile(domain, {
    preferredContentType: contentType,
    lastSuccessFormat: contentType,
    lastFailureReason: null,
    successes: {
      ...(profile?.successes || { json: 0, form: 0, multipart: 0 }),
      [key]: ((profile?.successes || {})[key] || 0) + 1,
    },
  });
}

function recordFailure(domain, contentType, errClass) {
  const key = ctKey(contentType);
  metrics.failureByContentType[key]++;
  if (!metrics.anchorErrors.has(domain)) metrics.anchorErrors.set(domain, []);
  const list = metrics.anchorErrors.get(domain);
  list.push({ ts: Date.now(), errClass, contentType });
  if (list.length > 50) list.shift(); // keep last 50

  const profile = getAnchorProfile(domain);
  setAnchorProfile(domain, {
    lastFailureReason: errClass,
    attempts: {
      ...(profile?.attempts || { json: 0, form: 0, multipart: 0 }),
      [key]: ((profile?.attempts || {})[key] || 0) + 1,
    },
  });
}

// ─── Endpoint Discovery Cache ──────────────────────────────────
const sep24EndpointCache = new Map();

// ─── Redirect-safe POST ────────────────────────────────────────
// Node.js native fetch converts POST→GET on 301/302/303 redirects,
// silently dropping the body. This is the #1 cause of "asset_code must
// be set" errors — the anchor redirects (e.g. trailing slash) and the
// body vanishes. We use redirect: 'manual' and re-POST ourselves.

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function fetchPostWithRedirects(url, headers, body, timeoutMs = FETCH_TIMEOUT_MS) {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',          // ← critical: prevent silent POST→GET
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
      const hostname = safeHostname(currentUrl);
      if (error.cause?.code === 'ENOTFOUND') throw new Error(`DNS lookup failed for ${hostname}`);
      if (error.cause?.code === 'ECONNREFUSED') throw new Error(`Connection refused by ${hostname}`);
      if (error.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        error.cause?.code === 'CERT_HAS_EXPIRED' ||
        error.message?.includes('certificate')) throw new Error(`SSL certificate error for ${hostname}`);
      throw new Error(`Network error connecting to ${hostname}: ${error.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    // Not a redirect → return directly
    if (response.status < 300 || response.status >= 400) {
      log.debug({ hop, status: response.status, url: currentUrl }, 'fetchPostWithRedirects: final response');
      return response;
    }

    // 3xx — follow redirect preserving POST + body
    const location = response.headers.get('location');
    if (!location) {
      log.warn({ status: response.status, url: currentUrl }, 'Redirect with no Location header');
      return response;
    }

    currentUrl = new URL(location, currentUrl).toString();
    metrics.redirectsFollowed++;
    log.info({ hop, from: url, to: currentUrl, status: response.status, bodyLength: body?.length },
      '↻ Following redirect with POST body preserved');
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECT_HOPS}) for ${url}`);
}

/** Simple GET with timeout (for TOML, info, status endpoints). */
async function fetchGetWithTimeout(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    const hostname = safeHostname(url);
    if (error.cause?.code === 'ENOTFOUND') throw new Error(`DNS lookup failed for ${hostname}`);
    if (error.cause?.code === 'ECONNREFUSED') throw new Error(`Connection refused by ${hostname}`);
    throw new Error(`Network error: ${error.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── URL helpers ───────────────────────────────────────────────
/**
 * Properly join a base URL with a path suffix (without dropping base path).
 * `new URL('/path', 'https://host/base')` drops /base — this helper doesn't.
 */
function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

// ─── Endpoint discovery ────────────────────────────────────────
/**
 * Discover the real TRANSFER_SERVER_SEP0024 for an anchor domain.
 * Priority: DB record → stellar.toml → guess.
 */
async function discoverSep24Endpoint(anchorDomain) {
  const cached = sep24EndpointCache.get(anchorDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoint;

  // 1. DB
  const anchor = getAnchorByDomain(anchorDomain);
  if (anchor?.transfer_server_sep24) {
    log.debug({ anchorDomain, endpoint: anchor.transfer_server_sep24 }, 'SEP-24 endpoint from DB');
    sep24EndpointCache.set(anchorDomain, { endpoint: anchor.transfer_server_sep24, expiresAt: Date.now() + CACHE_TTL_MS });
    return anchor.transfer_server_sep24;
  }

  // 2. stellar.toml
  try {
    const resp = await fetchGetWithTimeout(`https://${anchorDomain}/.well-known/stellar.toml`, {}, 10_000);
    if (resp.ok) {
      const text = await resp.text();
      for (const line of text.split('\n')) {
        const m = line.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/);
        if (m) {
          log.debug({ anchorDomain, endpoint: m[1] }, 'SEP-24 endpoint from TOML');
          sep24EndpointCache.set(anchorDomain, { endpoint: m[1], expiresAt: Date.now() + CACHE_TTL_MS });
          return m[1];
        }
      }
    }
  } catch (err) {
    log.warn({ anchorDomain, error: err.message }, 'TOML fetch failed during SEP-24 discovery');
  }

  // 3. Guess
  const guess = `https://${anchorDomain}/sep24`;
  log.warn({ anchorDomain, endpoint: guess }, 'Using guessed SEP-24 endpoint');
  return guess;
}

// ─── Request Serializers ───────────────────────────────────────
/**
 * Build the canonical parameter map from the internal request model.
 */
function buildParamMap(txRequest, { includeIssuer = false } = {}) {
  const params = {};
  // Only add params that have actual non-empty values
  if (txRequest.assetCode) params.asset_code = String(txRequest.assetCode).trim();

  // ── asset_issuer is OPTIONAL per SEP-24 spec ──────────────
  // CRITICAL: Only include when explicitly requested AND validated.
  // Sending a mismatched issuer (e.g. network-discovered issuer ≠ anchor's issuer)
  // causes django-polaris to return the misleading error:
  //   "The asset_code of the deposit request must be set"
  // because it can't find an asset matching the code+issuer combo.
  // The issuer from our asset registry (Stellar network) often differs from the
  // anchor's internal issuer (e.g. testanchor: GCDNJUBQSX7AJWLJACMJ7I...
  //   vs network-discovered: GCDNJUBQSX7AJWLJA5FGK7LV...).
  if (includeIssuer && txRequest.assetIssuer) {
    params.asset_issuer = String(txRequest.assetIssuer).trim();
  }

  if (txRequest.amount) params.amount = String(txRequest.amount).trim();
  if (txRequest.account) params.account = String(txRequest.account).trim();
  if (txRequest.memo) params.memo = txRequest.memo;
  if (txRequest.memoType) params.memo_type = txRequest.memoType;
  if (txRequest.email) params.email_address = txRequest.email;
  if (txRequest.firstName) params.first_name = txRequest.firstName;
  if (txRequest.lastName) params.last_name = txRequest.lastName;
  if (txRequest.lang) params.lang = txRequest.lang;
  return params;
}

/** Serialize as JSON body. */
function serializeJSON(params) {
  return { contentType: CONTENT_TYPES.JSON, body: JSON.stringify(params) };
}

/** Serialize as form-encoded body. Returns a plain string. */
function serializeForm(params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null) form.set(k, String(v));
  }
  return { contentType: CONTENT_TYPES.FORM, body: form.toString() };
}

/** Serialize as multipart/form-data with explicit boundary. */
function serializeMultipart(params) {
  const boundary = `----StellaProtocol${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v != null) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`
      );
    }
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: parts.join(''),
  };
}

/**
 * Choose the ordered list of content types to try for this anchor.
 * Known-good format first → then the rest of the strategy.
 */
function chooseContentTypeOrder(anchorDomain) {
  const profile = getAnchorProfile(anchorDomain);
  if (profile?.lastSuccessFormat) {
    const rest = CT_STRATEGY.filter(ct => ct !== profile.lastSuccessFormat);
    return [profile.lastSuccessFormat, ...rest];
  }
  return [...CT_STRATEGY]; // JSON → multipart → form
}

function serialize(params, contentType) {
  if (contentType === CONTENT_TYPES.JSON) return serializeJSON(params);
  if (contentType.startsWith('multipart')) return serializeMultipart(params);
  return serializeForm(params);
}

// ─── Simple JSON POST for SEP-24 ───────────────────────────────
// ─── Robust POST for SEP-24 ──────────────────────────────────
/**
 * Tries multiple content types (JSON → Multipart → Form) to handle
 * finicky anchors. 
 * 
 * Replaces the previous `simpleSep24Post` which was JSON-only and caused
 * 400 "asset_code must be set" errors with non-JSON anchors.
 */
async function robustSep24Post(url, authToken, params, anchorDomain) {
  metrics.totalInitiations++;

  // 1. Determine strategy (e.g. JSON → Multipart → Form)
  const strategy = chooseContentTypeOrder(anchorDomain);

  // 2. Prepare common headers
  const baseHeaders = {
    'Authorization': `Bearer ${authToken}`,
    'Accept': 'application/json',
  };

  let lastError = null;
  let lastStatus = 0;

  // 3. Try each content type in order
  for (const contentType of strategy) {
    const serialized = serialize(params, contentType);

    // Log intent
    log.info({
      anchorDomain,
      url,
      contentType,
      paramKeys: Object.keys(params),
    }, `Sep24Post: Attempting ${contentType}`);

    try {
      const headers = {
        ...baseHeaders,
        'Content-Type': serialized.contentType
      };
      // Content-Length is helpful for some strict servers
      // (fetch usually adds it, but explicit doesn't hurt for buffers/strings)
      // Note: multipart boundary handling is inside serializeMultipart

      const response = await fetchPostWithRedirects(url, headers, serialized.body);

      // Success?
      if (response.ok) {
        recordSuccess(anchorDomain, contentType);
        log.info({ anchorDomain, contentType, status: response.status }, 'SEP-24 POST succeeded');
        return response;
      }

      // Failure - Analyze it
      const errorText = await response.text();
      const errClass = classifyError(response.status, errorText, params, contentType);

      recordFailure(anchorDomain, contentType, errClass);
      lastStatus = response.status;
      lastError = new Error(`${response.status} - ${errorText}`);

      // If it's NOT a content-type issue, we shouldn't retry (e.g. 403 Auth, 500 Internal)
      // Unless it is 500 Internal which *might* be a parse error on some bad stacks.
      // `classifyError` handles the heuristic for us.
      if (errClass !== ERR_CLASS.UNSUPPORTED_CONTENT_TYPE) {
        log.warn({
          anchorDomain,
          contentType,
          status: response.status,
          errClass
        }, 'SEP-24 POST failed with non-retriable error');
        throw lastError;
      }

      log.warn({
        anchorDomain,
        contentType,
        status: response.status,
        errClass
      }, 'SEP-24 POST failed (likely CT mismatch), retrying with next format...');

    } catch (err) {
      // Network errors (DNS, timeout) are fatal immediately for that attempt.
      // But if we haven't tried all CTs, should we? optimize: NO, network is network.
      // Exception: if it was the classifyError logic throwing above, we catch it here.
      if (err === lastError) {
        // This was a throw from the non-retriable block above
        throw err;
      }

      // Real network error
      log.error({ error: err.message, anchorDomain, contentType }, 'SEP-24 network/fetch error');
      throw err;
    }
  }

  // If we exhausted all strategies
  log.error({ anchorDomain, strategies: strategy }, 'SEP-24 POST failed all content-type strategies');
  throw lastError || new Error('Unknown error during SEP-24 initiation');
}

// ════════════════════════════════════════════════════════════════
// Route Registration
// ════════════════════════════════════════════════════════════════
export async function sep24Routes(fastify) {

  // ── POST /sep24/initiate ─────────────────────────────────────
  fastify.post('/sep24/initiate', {
    schema: {
      body: {
        type: 'object',
        required: ['type', 'anchorDomain', 'authToken', 'request'],
        properties: {
          type: { type: 'string', enum: ['deposit', 'withdraw'] },
          anchorDomain: { type: 'string', minLength: 1 },
          sep24Endpoint: { type: 'string' },   // optional — auto-discovered
          authToken: { type: 'string', minLength: 1 },
          request: {
            type: 'object',
            required: ['assetCode', 'account'],
            properties: {
              assetCode: { type: 'string', minLength: 1 },
              assetIssuer: { type: 'string' },
              amount: { type: 'string' },
              account: { type: 'string', minLength: 56 },
              memo: { type: 'string' },
              memoType: { type: 'string' },
              email: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              lang: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { type, anchorDomain, sep24Endpoint: providedEndpoint, authToken, request: txRequest } = request.body;

    let params = null;
    try {
      // ─── Normalization for Test Anchor ─────────────────────
      // testanchor (Polaris) requires 'SRT' for XLM on testnet.
      // Wallets send 'XLM', causing "asset_code must be set" (not found) errors.
      if (anchorDomain.includes('testanchor') && txRequest.assetCode === 'XLM') {
        log.info('Mapping XLM -> SRT for testanchor compatibility');
        txRequest.assetCode = 'SRT';
      }

      // ── Preflight validation ───────────────────────────────
      const assetCode = (txRequest.assetCode || '').trim();
      const account = (txRequest.account || '').trim();

      if (!assetCode) {
        throw new Error('Preflight: assetCode is required but was empty');
      }
      if (!account) {
        throw new Error('Preflight: account is required but was empty');
      }
      if (account.length < 56 || !/^[GMC]/.test(account)) {
        log.warn({ account }, 'Preflight: account does not look like a valid Stellar address');
      }
      if (!authToken || authToken.split('.').length !== 3) {
        throw new Error('Preflight: authToken is missing or not a valid JWT');
      }

      const sep24Base = providedEndpoint || await discoverSep24Endpoint(anchorDomain);
      const endpointPath = type === 'deposit'
        ? 'transactions/deposit/interactive'
        : 'transactions/withdraw/interactive';
      const txUrl = joinUrl(sep24Base, endpointPath);

      // Build params WITHOUT asset_issuer by default.
      // The issuer from our asset registry (Stellar network) often doesn't match
      // the anchor's internal issuer, causing polaris to return:
      //   "The asset_code of the deposit request must be set"
      // SEP-24 says asset_issuer is optional — omit unless explicitly validated.
      params = buildParamMap(txRequest);

      // Final safety check: params MUST contain critical fields
      if (!params.asset_code) {
        throw new Error(`Preflight: buildParamMap produced no asset_code (input=${txRequest.assetCode})`);
      }
      if (!params.account) {
        throw new Error(`Preflight: buildParamMap produced no account (input=${txRequest.account})`);
      }

      log.info({
        type, txUrl, anchorDomain,
        assetCode: params.asset_code,
        account: params.account?.slice(0, 12) + '...',
        paramMap: params,
      }, 'SEP-24 initiate: preflight passed');

      // Robust POST — v5: retry cascade for max compatibility
      const response = await robustSep24Post(txUrl, authToken, params, anchorDomain);
      const data = await response.json();

      if (data.type !== 'interactive_customer_info_needed') {
        throw new Error(`Unexpected response type: ${data.type}`);
      }
      if (!data.url || !data.id) {
        throw new Error('Missing required fields in response (url, id)');
      }

      log.info({
        type, anchorDomain, assetCode: txRequest.assetCode, transactionId: data.id,
      }, 'SEP-24 flow initiated');

      return { success: true, url: data.url, id: data.id, type: data.type };

    } catch (error) {
      log.error({
        error: error.message, type, anchorDomain, assetCode: txRequest.assetCode,
        sentParams: params ? { asset_code: params.asset_code, account: params.account?.slice(0, 12), hasIssuer: !!params.asset_issuer } : 'none',
      }, 'SEP-24 initiation failed');

      // Preserve anchor's HTTP status when possible (e.g. 403 = auth expired)
      const statusMatch = error.message.match(/^(\d{3}) - /);
      if (statusMatch) {
        const anchorStatus = parseInt(statusMatch[1], 10);
        if (anchorStatus === 403) {
          throw Errors.unauthorized('Authentication token expired or invalid. Please re-authenticate via SEP-10.');
        }
      }
      throw Errors.badRequest(error.message);
    }
  });

  // ── POST /sep24/status/:transactionId ────────────────────────
  fastify.post('/sep24/status/:transactionId', {
    schema: {
      params: {
        type: 'object',
        required: ['transactionId'],
        properties: { transactionId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['anchorDomain', 'authToken'],
        properties: {
          anchorDomain: { type: 'string' },
          sep24Endpoint: { type: 'string' },
          authToken: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { transactionId } = request.params;
    const { anchorDomain, sep24Endpoint, authToken } = request.body;

    try {
      const sep24Base = sep24Endpoint || await discoverSep24Endpoint(anchorDomain);
      const statusUrl = joinUrl(sep24Base, 'transaction') + `?id=${encodeURIComponent(transactionId)}`;

      log.debug({ transactionId, statusUrl, sep24Base }, 'Checking SEP-24 transaction status');

      const response = await fetchGetWithTimeout(statusUrl, {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json',
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Status check failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      log.debug({ transactionId, status: data.transaction?.status, anchorDomain }, 'SEP-24 status retrieved');
      return data.transaction || data;

    } catch (error) {
      log.error({ error: error.message, transactionId, anchorDomain }, 'SEP-24 status check failed');
      return { id: transactionId, status: 'unknown', message: 'Status check failed' };
    }
  });

  // ── GET /sep24/info ──────────────────────────────────────────
  fastify.get('/sep24/info', {
    schema: {
      querystring: {
        type: 'object',
        required: ['anchorDomain'],
        properties: {
          anchorDomain: { type: 'string' },
          endpoint: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { anchorDomain, endpoint } = request.query;

    try {
      const sep24Base = endpoint || await discoverSep24Endpoint(anchorDomain);
      const infoUrl = joinUrl(sep24Base, 'info');
      log.debug({ infoUrl, anchorDomain }, 'Fetching SEP-24 info');

      const response = await fetchGetWithTimeout(infoUrl, { 'Accept': 'application/json' }, 10_000);

      if (!response.ok) throw new Error(`Info request failed: ${response.status}`);
      return await response.json();

    } catch (error) {
      log.error({ error: error.message, anchorDomain }, 'SEP-24 info request failed');
      throw Errors.badRequest(`Failed to get SEP-24 info: ${error.message}`);
    }
  });

  // ── DELETE /sep24/cache — clear all caches ───────────────────
  fastify.delete('/sep24/cache', async () => {
    const profileCount = anchorProfiles.size;
    const endpointCount = sep24EndpointCache.size;
    anchorProfiles.clear();
    sep24EndpointCache.clear();
    log.info({ profileCount, endpointCount }, 'SEP-24 caches cleared');
    return { cleared: { profiles: profileCount, endpoints: endpointCount } };
  });

  // ── GET /sep24/diagnostics ───────────────────────────────────
  // Observability: content-type stats, per-anchor profiles, recent errors.
  fastify.get('/sep24/diagnostics', async () => {
    const profiles = {};
    for (const [domain, p] of anchorProfiles.entries()) {
      profiles[domain] = {
        preferredContentType: p.preferredContentType,
        lastSuccessFormat: p.lastSuccessFormat,
        lastFailureReason: p.lastFailureReason,
        attempts: p.attempts,
        successes: p.successes,
        age: `${Math.round((Date.now() - p.updatedAt) / 1000)}s`,
      };
    }

    const recentErrors = {};
    for (const [domain, list] of metrics.anchorErrors.entries()) {
      recentErrors[domain] = list.slice(-10).map(e => ({
        ...e, ago: `${Math.round((Date.now() - e.ts) / 1000)}s`,
      }));
    }

    return {
      version: 'v4-simple-json',
      buildStamp: BUILD_STAMP,
      ctStrategy: CT_STRATEGY.map(c => c.split('/').pop()),
      totalInitiations: metrics.totalInitiations,
      successByContentType: metrics.successByContentType,
      failureByContentType: metrics.failureByContentType,
      retryCount: metrics.retryCount,
      redirectsFollowed: metrics.redirectsFollowed,
      anchorProfiles: profiles,
      recentErrors,
      endpointCacheSize: sep24EndpointCache.size,
      profileCacheSize: anchorProfiles.size,
    };
  });

  log.info('SEP-24 routes registered (v3: redirect-safe + 3-CT-strategy + param-echo)');
}
