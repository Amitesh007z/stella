// ─── Fiat Asset Identifier Support ─────────────────────────────
// Extends asset identification to support both Stellar and fiat assets
// using SEP-38 standard format:
//
// Stellar assets: stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
// Fiat currencies: iso4217:USD, iso4217:EUR, iso4217:JPY
// Bank rails: fiat:USD:bank_wire, fiat:EUR:sepa
//
// Provides utilities for parsing, validation, and conversion between formats.

import { createLogger } from '../../lib/logger.js';

const log = createLogger('fiat-assets');

// ISO 4217 currency codes (major ones - extend as needed)
const ISO4217_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK',
  'CNY', 'INR', 'KRW', 'SGD', 'HKD', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND',
  'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'MXN', 'ZAR', 'NGN', 'EGP', 'TRY', 'RUB',
  'UAH', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'RSD', 'MKD', 'BAM', 'ALL'
]);

/**
 * @typedef {object} ParsedAsset
 * @property {'stellar'|'iso4217'|'fiat'} type - Asset type
 * @property {string} code - Asset code (USD, USDC, etc.)
 * @property {string} [issuer] - Stellar issuer (stellar assets only)
 * @property {string} [rail] - Payment rail (fiat assets only)
 * @property {string} original - Original identifier string
 * @property {boolean} isNative - Whether it's native XLM
 * @property {boolean} isFiat - Whether it's fiat currency
 * @property {boolean} isStellar - Whether it's on-chain Stellar asset
 */

/**
 * Parse asset identifier into components
 * @param {string} assetId - Asset identifier (stellar:CODE:ISSUER or iso4217:USD)
 * @returns {ParsedAsset} Parsed asset information
 */
export function parseAssetIdentifier(assetId) {
  if (!assetId || typeof assetId !== 'string') {
    throw new Error('Asset identifier must be a non-empty string');
  }

  const original = assetId;
  const parts = assetId.split(':');

  if (parts.length < 2) {
    throw new Error(`Invalid asset identifier format: ${assetId}`);
  }

  const scheme = parts[0].toLowerCase();

  switch (scheme) {
    case 'stellar': {
      if (parts.length === 2 && parts[1].toUpperCase() === 'XLM') {
        // Native XLM: stellar:XLM
        return {
          type: 'stellar',
          code: 'XLM',
          issuer: null,
          original,
          isNative: true,
          isFiat: false,
          isStellar: true
        };
      }

      if (parts.length !== 3) {
        throw new Error(`Stellar asset must have format stellar:CODE:ISSUER, got: ${assetId}`);
      }

      const [, code, issuer] = parts;
      
      if (!code || !issuer) {
        throw new Error(`Invalid stellar asset format: ${assetId}`);
      }

      if (issuer.length !== 56 || !issuer.match(/^G[A-Z2-7]{55}$/)) {
        throw new Error(`Invalid Stellar issuer format: ${issuer}`);
      }

      return {
        type: 'stellar',
        code: code.toUpperCase(),
        issuer,
        original,
        isNative: false,
        isFiat: false,
        isStellar: true
      };
    }

    case 'iso4217': {
      if (parts.length !== 2) {
        throw new Error(`ISO4217 asset must have format iso4217:CURRENCY, got: ${assetId}`);
      }

      const [, currencyCode] = parts;
      const code = currencyCode.toUpperCase();

      if (!ISO4217_CURRENCIES.has(code)) {
        log.warn({ currencyCode: code }, 'Unknown ISO4217 currency code');
        // Don't throw - allow unknown currencies but log warning
      }

      return {
        type: 'iso4217',
        code,
        original,
        isNative: false,
        isFiat: true,
        isStellar: false
      };
    }

    case 'fiat': {
      if (parts.length < 2 || parts.length > 3) {
        throw new Error(`Fiat asset must have format fiat:CURRENCY[:RAIL], got: ${assetId}`);
      }

      const [, currencyCode, rail] = parts;
      const code = currencyCode.toUpperCase();

      return {
        type: 'fiat',
        code,
        rail: rail || 'default',
        original,
        isNative: false,
        isFiat: true,
        isStellar: false
      };
    }

    default:
      throw new Error(`Unsupported asset scheme: ${scheme}. Supported: stellar, iso4217, fiat`);
  }
}

/**
 * Convert asset to canonical identifier string
 * @param {ParsedAsset} asset - Parsed asset
 * @returns {string} Canonical identifier
 */
export function assetToIdentifier(asset) {
  switch (asset.type) {
    case 'stellar':
      if (asset.isNative) {
        return 'stellar:XLM';
      }
      return `stellar:${asset.code}:${asset.issuer}`;

    case 'iso4217':
      return `iso4217:${asset.code}`;

    case 'fiat':
      if (asset.rail && asset.rail !== 'default') {
        return `fiat:${asset.code}:${asset.rail}`;
      }
      return `fiat:${asset.code}`;

    default:
      throw new Error(`Cannot convert unknown asset type: ${asset.type}`);
  }
}

/**
 * Check if two assets are the same
 * @param {string|ParsedAsset} asset1 - First asset
 * @param {string|ParsedAsset} asset2 - Second asset
 * @returns {boolean} Whether assets are equivalent
 */
export function assetsEqual(asset1, asset2) {
  const parsed1 = typeof asset1 === 'string' ? parseAssetIdentifier(asset1) : asset1;
  const parsed2 = typeof asset2 === 'string' ? parseAssetIdentifier(asset2) : asset2;

  if (parsed1.type !== parsed2.type) return false;
  if (parsed1.code !== parsed2.code) return false;

  switch (parsed1.type) {
    case 'stellar':
      return parsed1.issuer === parsed2.issuer;
    case 'fiat':
      return (parsed1.rail || 'default') === (parsed2.rail || 'default');
    case 'iso4217':
      return true; // Only code matters for ISO currencies
    default:
      return false;
  }
}

/**
 * Get display name for asset
 * @param {string|ParsedAsset} asset - Asset to display
 * @returns {string} Human-readable name
 */
export function getAssetDisplayName(asset) {
  const parsed = typeof asset === 'string' ? parseAssetIdentifier(asset) : asset;

  switch (parsed.type) {
    case 'stellar':
      if (parsed.isNative) {
        return 'Stellar Lumens (XLM)';
      }
      return `${parsed.code} (${parsed.issuer.slice(0, 8)}...)`;

    case 'iso4217':
    case 'fiat':
      const currencyNames = {
        'USD': 'US Dollar',
        'EUR': 'Euro',
        'GBP': 'British Pound',
        'JPY': 'Japanese Yen',
        'CHF': 'Swiss Franc',
        'CAD': 'Canadian Dollar',
        'AUD': 'Australian Dollar',
        'BRL': 'Brazilian Real',
        'ARS': 'Argentine Peso',
        'PEN': 'Peruvian Sol'
      };
      
      const name = currencyNames[parsed.code] || parsed.code;
      
      if (parsed.type === 'fiat' && parsed.rail && parsed.rail !== 'default') {
        return `${name} (${parsed.rail})`;
      }
      
      return name;

    default:
      return parsed.original;
  }
}

/**
 * Check if asset identifier is valid
 * @param {string} assetId - Asset identifier to validate
 * @returns {boolean} Whether identifier is valid
 */
export function isValidAssetIdentifier(assetId) {
  try {
    parseAssetIdentifier(assetId);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get all supported currency codes by type
 * @returns {object} Supported currencies by type
 */
export function getSupportedCurrencies() {
  return {
    iso4217: Array.from(ISO4217_CURRENCIES).sort(),
    stellar: ['XLM'], // Native - issued assets discovered dynamically
    fiatRails: ['bank_wire', 'ach', 'sepa', 'swift', 'pix', 'interac', 'fps']
  };
}

/**
 * Convert between asset identifier formats when possible
 * @param {string} fromAssetId - Source asset identifier
 * @param {'stellar'|'iso4217'|'fiat'} toType - Target type
 * @param {object} [options] - Conversion options
 * @param {string} [options.issuer] - Stellar issuer (for stellar conversion)
 * @param {string} [options.rail] - Payment rail (for fiat conversion)
 * @returns {string|null} Converted identifier or null if not possible
 */
export function convertAssetIdentifier(fromAssetId, toType, options = {}) {
  try {
    const parsed = parseAssetIdentifier(fromAssetId);
    
    // Same type - return as-is
    if (parsed.type === toType) {
      return fromAssetId;
    }

    switch (toType) {
      case 'iso4217':
        if (parsed.isFiat) {
          return `iso4217:${parsed.code}`;
        }
        // Can't convert Stellar assets to ISO4217
        return null;

      case 'fiat':
        if (parsed.isFiat || parsed.type === 'iso4217') {
          const rail = options.rail || 'default';
          return rail === 'default' ? 
            `fiat:${parsed.code}` : 
            `fiat:${parsed.code}:${rail}`;
        }
        return null;

      case 'stellar':
        if (parsed.isFiat) {
          // Can't directly convert fiat to stellar without knowing issuer
          return null;
        }
        if (parsed.type === 'stellar') {
          return fromAssetId;
        }
        return null;

      default:
        return null;
    }

  } catch (error) {
    log.error({ fromAssetId, toType, error: error.message }, 'Asset conversion failed');
    return null;
  }
}

/**
 * Batch parse multiple asset identifiers
 * @param {string[]} assetIds - Array of asset identifiers
 * @returns {ParsedAsset[]} Array of parsed assets
 */
export function batchParseAssets(assetIds) {
  return assetIds.map(assetId => {
    try {
      return parseAssetIdentifier(assetId);
    } catch (error) {
      log.error({ assetId, error: error.message }, 'Failed to parse asset in batch');
      return null;
    }
  }).filter(Boolean);
}