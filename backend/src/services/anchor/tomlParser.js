// ─── Stella Protocol — TOML Parser ────────────────────────────
// Parses stellar.toml text into canonical Stella anchor format.
// Extracts: CURRENCIES, servers, accounts, metadata.
// Defensive — handles missing/malformed fields gracefully.

import * as TOML from '@iarna/toml';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('toml-parser');

/**
 * Parse raw stellar.toml text into a normalized anchor record.
 * @param {string} domain - The anchor domain.
 * @param {string} rawToml - The raw TOML string.
 * @returns {{ ok: boolean, data?: ParsedAnchor, error?: string }}
 */
export function parseStellarToml(domain, rawToml) {
  try {
    const parsed = TOML.parse(rawToml);

    // ── Extract top-level fields ────────────────────
    const result = {
      domain,
      // Metadata
      version: safeStr(parsed.VERSION),
      networkPassphrase: safeStr(parsed.NETWORK_PASSPHRASE),
      federationServer: safeStr(parsed.FEDERATION_SERVER),
      authServer: safeStr(parsed.AUTH_SERVER),
      transferServer: safeStr(parsed.TRANSFER_SERVER),
      transferServerSep24: safeStr(parsed.TRANSFER_SERVER_SEP0024),
      kycServer: safeStr(parsed.KYC_SERVER),
      webAuthEndpoint: safeStr(parsed.WEB_AUTH_ENDPOINT),
      signingKey: safeStr(parsed.SIGNING_KEY),
      quoteServer: safeStr(parsed.QUOTE_SERVER) || safeStr(parsed.ANCHOR_QUOTE_SERVER),
      directPaymentServer: safeStr(parsed.DIRECT_PAYMENT_SERVER),

      // Organization info
      orgName: parsed.DOCUMENTATION?.ORG_NAME || null,
      orgUrl: parsed.DOCUMENTATION?.ORG_URL || null,
      orgDescription: parsed.DOCUMENTATION?.ORG_DESCRIPTION || null,
      orgLogo: parsed.DOCUMENTATION?.ORG_LOGO || null,

      // Issuing accounts
      accounts: extractAccounts(parsed),

      // Currencies / Assets
      currencies: extractCurrencies(domain, parsed),

      // Validators (optional, not used for routing)
      validators: Array.isArray(parsed.VALIDATORS) ? parsed.VALIDATORS : [],

      // Raw parsed (for debugging)
      _raw: parsed,
    };

    log.info(
      { domain, currencies: result.currencies.length, accounts: result.accounts.length },
      'TOML parsed successfully'
    );

    return { ok: true, data: result };

  } catch (err) {
    log.error({ domain, err: err.message }, 'TOML parse error');
    return { ok: false, error: `TOML parse failed: ${err.message}` };
  }
}

/**
 * Extract issuing accounts from ACCOUNTS array.
 * Some TOMLs put them as PRINCIPALS or in the CURRENCIES.
 */
function extractAccounts(parsed) {
  const accounts = new Set();

  // ── Direct ACCOUNTS array ─────────────────────────
  if (Array.isArray(parsed.ACCOUNTS)) {
    for (const acct of parsed.ACCOUNTS) {
      if (typeof acct === 'string' && isValidPublicKey(acct)) {
        accounts.add(acct);
      }
    }
  }

  // ── Principals ───────────────────────────────────
  if (Array.isArray(parsed.PRINCIPALS)) {
    for (const principal of parsed.PRINCIPALS) {
      if (principal?.public_key && isValidPublicKey(principal.public_key)) {
        accounts.add(principal.public_key);
      }
    }
  }

  // ── Extract issuers from currencies ──────────────
  if (Array.isArray(parsed.CURRENCIES)) {
    for (const currency of parsed.CURRENCIES) {
      if (currency?.issuer && isValidPublicKey(currency.issuer)) {
        accounts.add(currency.issuer);
      }
    }
  }

  return [...accounts];
}

/**
 * Extract and normalize CURRENCIES from TOML.
 * Each currency becomes a canonical asset record.
 */
function extractCurrencies(domain, parsed) {
  if (!Array.isArray(parsed.CURRENCIES)) return [];

  const currencies = [];

  for (const c of parsed.CURRENCIES) {
    // ── Skip malformed entries ─────────────────────
    if (!c || typeof c !== 'object') continue;
    if (!c.code) continue;

    const currency = {
      code: safeStr(c.code)?.toUpperCase(),
      issuer: safeStr(c.issuer),
      domain,
      status: c.status || 'live',

      // Asset type
      assetType: deriveAssetType(c.code),

      // Anchor metadata
      name: safeStr(c.name),
      description: safeStr(c.desc),
      conditions: safeStr(c.conditions),
      image: safeStr(c.image),
      displayDecimals: typeof c.display_decimals === 'number' ? c.display_decimals : 7,

      // Anchoring info
      isAssetAnchored: !!c.is_asset_anchored,
      anchorAsset: safeStr(c.anchor_asset),
      anchorAssetType: safeStr(c.anchor_asset_type),
      redemptionInstructions: safeStr(c.redemption_instructions),

      // SEP support flags
      isDepositEnabled: !(c.deposit === false),     // default true if not specified
      isWithdrawEnabled: !(c.withdraw === false),
      sep38Supported: false,                         // set later from quote_server presence

      // Fees (if declared)
      feeFixed: typeof c.fee_fixed === 'number' ? c.fee_fixed : null,
      feePercent: typeof c.fee_percent === 'number' ? c.fee_percent : null,
      minAmount: typeof c.min_amount === 'number' ? c.min_amount : null,
      maxAmount: typeof c.max_amount === 'number' ? c.max_amount : null,
    };

    // If the anchor declares a quote server, mark SEP-38 supported
    if (parsed.QUOTE_SERVER || parsed.ANCHOR_QUOTE_SERVER) {
      currency.sep38Supported = true;
    }

    // Only include currencies with valid issuers (or native XLM)
    if (currency.code === 'XLM' && !currency.issuer) {
      currency.assetType = 'native';
      currencies.push(currency);
    } else if (currency.issuer && isValidPublicKey(currency.issuer)) {
      currencies.push(currency);
    } else {
      log.debug({ domain, code: currency.code }, 'Skipping currency — no valid issuer');
    }
  }

  return currencies;
}

/**
 * Derive Stellar asset type from code length.
 */
function deriveAssetType(code) {
  if (!code || code === 'XLM') return 'native';
  if (code.length <= 4) return 'credit_alphanum4';
  return 'credit_alphanum12';
}

/**
 * Basic Stellar public key validation.
 * G... keys are 56 characters.
 */
function isValidPublicKey(key) {
  return typeof key === 'string' && /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Safe string extraction — returns null for non-strings.
 */
function safeStr(val) {
  if (typeof val === 'string' && val.trim()) return val.trim();
  return null;
}

export default { parseStellarToml };
