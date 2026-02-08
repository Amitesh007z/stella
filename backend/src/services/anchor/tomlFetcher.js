// ─── Stella Protocol — TOML Fetcher ───────────────────────────
// Fetches /.well-known/stellar.toml from anchor domains.
// Hardened against malicious/slow/malformed responses.

import { createLogger } from '../../lib/logger.js';

const log = createLogger('toml-fetcher');

// ── Security / Resource Limits ──────────────────────────────
const FETCH_TIMEOUT_MS = 15000;       // 15s max per domain
const MAX_TOML_SIZE = 512 * 1024;     // 512KB max TOML size
const ALLOWED_CONTENT_TYPES = [
  'text/plain',
  'application/toml',
  'text/x-toml',
  'application/octet-stream',         // some anchors serve this
];

/**
 * Fetch stellar.toml from a domain.
 * @param {string} domain - Anchor domain (e.g., 'testanchor.stellar.org')
 * @returns {Promise<{ok: boolean, toml?: string, error?: string, statusCode?: number, durationMs: number}>}
 */
export async function fetchStellarToml(domain) {
  const url = `https://${domain}/.well-known/stellar.toml`;
  const startTime = Date.now();

  log.debug({ domain, url }, 'Fetching stellar.toml');

  try {
    // ── Input validation ─────────────────────────────
    if (!domain || typeof domain !== 'string') {
      return { ok: false, error: 'Invalid domain', durationMs: 0 };
    }

    // Block private/local IPs (basic protection)
    if (isBlockedDomain(domain)) {
      return { ok: false, error: 'Blocked domain (private/local)', durationMs: 0 };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Don't set Accept header - some servers reject non-default Accept for TOML
        'User-Agent': 'StellaProtocol/0.1.0',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const durationMs = Date.now() - startTime;

    // ── Status check ─────────────────────────────────
    if (!response.ok) {
      log.warn({ domain, status: response.status, ms: durationMs }, 'TOML fetch failed');
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        durationMs,
      };
    }

    // ── Content-Type validation ──────────────────────
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isAllowed = ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t));
    if (!isAllowed && contentType && !contentType.includes('text/')) {
      log.warn({ domain, contentType }, 'Unexpected content-type for stellar.toml');
      // Don't hard-fail — some anchors misconfigure content-type
    }

    // ── Size check ───────────────────────────────────
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_TOML_SIZE) {
      return {
        ok: false,
        error: `TOML too large: ${contentLength} bytes (max ${MAX_TOML_SIZE})`,
        durationMs,
      };
    }

    // ── Read body with size guard ────────────────────
    const text = await response.text();
    if (text.length > MAX_TOML_SIZE) {
      return {
        ok: false,
        error: `TOML body too large: ${text.length} chars`,
        durationMs,
      };
    }

    if (!text.trim()) {
      return { ok: false, error: 'Empty TOML response', durationMs };
    }

    log.info({ domain, size: text.length, ms: durationMs }, 'TOML fetched successfully');
    return { ok: true, toml: text, durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;

    if (err.name === 'AbortError') {
      log.warn({ domain, ms: durationMs }, 'TOML fetch timed out');
      return { ok: false, error: `Timeout after ${FETCH_TIMEOUT_MS}ms`, durationMs };
    }

    log.error({ domain, err: err.message, ms: durationMs }, 'TOML fetch error');
    return { ok: false, error: err.message, durationMs };
  }
}

/**
 * Block obviously malicious/local domains.
 */
function isBlockedDomain(domain) {
  const blocked = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '10.',
    '192.168.',
    '172.16.',
    'metadata.google.internal',
    '169.254.',
  ];
  const lower = domain.toLowerCase();
  return blocked.some((b) => lower.startsWith(b) || lower.includes(b));
}

export default { fetchStellarToml };
