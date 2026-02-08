// ─── Stella Protocol — Dynamic Anchor Directory Discovery ─────
// Fetches known anchor/issuer domains from public Stellar
// directories (stellar.expert, etc.) and feeds them into the
// crawl pipeline. This supplements the static seed list.
//
// Sources:
//   1. stellar.expert — well-known asset directory
//   2. Horizon — top assets by number of trustlines

import { createLogger } from '../../lib/logger.js';
import config from '../../config/index.js';
import { queryAssets } from '../../lib/horizon.js';

const log = createLogger('directory-discovery');

const DIRECTORY_TIMEOUT_MS = 15000;

/**
 * Discover anchor domains dynamically from public sources.
 * Returns unique domain objects ready for the crawl pipeline.
 *
 * @returns {Promise<Array<{domain: string, name: string, description: string}>>}
 */
export async function discoverAnchorsFromDirectory() {
  const discovered = new Map(); // domain → {domain, name, description}
  const startTime = Date.now();

  // ── Source 1: stellar.expert known directory ─────────
  try {
    const expertDomains = await fetchStellarExpertDirectory();
    for (const entry of expertDomains) {
      if (entry.domain && !discovered.has(entry.domain)) {
        discovered.set(entry.domain, entry);
      }
    }
    log.info({ count: expertDomains.length }, 'stellar.expert directory domains fetched');
  } catch (err) {
    log.warn({ err: err.message }, 'stellar.expert directory fetch failed — continuing');
  }

  // ── Source 2: Horizon top assets (extract home_domain) ──
  try {
    const horizonDomains = await fetchDomainsFromHorizon();
    for (const entry of horizonDomains) {
      if (entry.domain && !discovered.has(entry.domain)) {
        discovered.set(entry.domain, entry);
      }
    }
    log.info({ count: horizonDomains.length }, 'Horizon asset-domain extraction complete');
  } catch (err) {
    log.warn({ err: err.message }, 'Horizon domain extraction failed — continuing');
  }

  const results = Array.from(discovered.values());
  const durationMs = Date.now() - startTime;
  log.info({ totalDiscovered: results.length, durationMs }, 'Directory discovery complete');

  return results;
}

/**
 * Fetch the stellar.expert known-assets directory.
 * The public API lists known assets with their home domains.
 */
async function fetchStellarExpertDirectory() {
  const domains = [];
  const isTestnet = config.network === 'stellar_testnet';
  const networkSlug = isTestnet ? 'testnet' : 'public';

  // stellar.expert lists known assets — we extract unique home_domains
  const url = `https://api.stellar.expert/explorer/${networkSlug}/asset?order=rating&limit=50`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const records = data._embedded?.records || data.records || [];
    const seen = new Set();

    for (const asset of records) {
      const domain = asset.domain || asset.home_domain;
      if (domain && !seen.has(domain)) {
        seen.add(domain);
        domains.push({
          domain,
          name: asset.code || domain,
          description: `Discovered via stellar.expert — ${asset.code || 'multi-asset'}`,
        });
      }
    }
  } catch (err) {
    log.debug({ err: err.message, url }, 'stellar.expert fetch failed');
  }

  return domains;
}

/**
 * Extract unique home_domains from Horizon's top assets.
 * We query well-known asset codes and extract issuer domains.
 */
async function fetchDomainsFromHorizon() {
  const domains = [];
  const seen = new Set();

  // Common asset codes to search for — we'll discover their issuers' domains
  const wellKnownCodes = [
    'USDC', 'USDT', 'BTC', 'ETH', 'EURC', 'NGNT', 'BRL', 'ARS',
    'yXLM', 'AQUA', 'SHX', 'RMT', 'MOBI', 'SLT', 'TERN', 'XRP',
    'LSP', 'DOGET', 'GRAT', 'ARST',
  ];

  for (const code of wellKnownCodes) {
    try {
      const result = await queryAssets({ code, limit: 5 });
      const records = result.records || [];

      for (const record of records) {
        // The home_domain from the issuer account would be ideal,
        // but the assets endpoint gives us asset_issuer.
        // We'll rely on the stellar.toml link which uses the domain.
        const domain = record._links?.toml?.href
          ? new URL(record._links.toml.href).hostname
          : null;

        if (domain && !seen.has(domain)) {
          seen.add(domain);
          domains.push({
            domain,
            name: `${code} Issuer`,
            description: `Discovered via Horizon asset query — issues ${code}`,
          });
        }
      }
    } catch (err) {
      // Silently skip individual code failures
      log.debug({ code, err: err.message }, 'Horizon asset query failed');
    }
  }

  return domains;
}

export default { discoverAnchorsFromDirectory };
