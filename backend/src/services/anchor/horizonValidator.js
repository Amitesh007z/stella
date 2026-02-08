// ─── Stella Protocol — Horizon Validator ──────────────────────
// Validates anchor issuers and assets on the Stellar network.
// Every issuer and asset declared in a TOML must be verified on-chain
// before being marked as valid in the Anchor Capability Index.

import { accountExists, queryAssets } from '../../lib/horizon.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('horizon-validator');

/**
 * Validate a set of issuing accounts exist on Horizon.
 * @param {string[]} accounts - Stellar public keys to validate.
 * @returns {Promise<Map<string, boolean>>} - Map of pubkey → exists
 */
export async function validateIssuers(accounts) {
  const results = new Map();

  // Validate in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    const checks = await Promise.allSettled(
      batch.map(async (pubkey) => {
        const exists = await accountExists(pubkey);
        return { pubkey, exists };
      })
    );

    for (const result of checks) {
      if (result.status === 'fulfilled') {
        results.set(result.value.pubkey, result.value.exists);
        if (!result.value.exists) {
          log.warn({ pubkey: result.value.pubkey }, 'Issuer account not found on Horizon');
        }
      } else {
        // Network error — mark as unknown (don't hard-fail)
        log.error({ err: result.reason?.message }, 'Issuer validation error');
        results.set(batch[checks.indexOf(result)], false);
      }
    }
  }

  return results;
}

/**
 * Validate individual currencies exist on the network.
 * Checks that the asset code + issuer pair has trustlines.
 * @param {Array<{code: string, issuer: string}>} currencies
 * @returns {Promise<Map<string, {exists: boolean, numAccounts?: number, amount?: string}>>}
 */
export async function validateAssets(currencies) {
  const results = new Map();

  const BATCH_SIZE = 5;
  for (let i = 0; i < currencies.length; i += BATCH_SIZE) {
    const batch = currencies.slice(i, i + BATCH_SIZE);
    const checks = await Promise.allSettled(
      batch.map(async (currency) => {
        const key = `${currency.code}:${currency.issuer}`;

        // Native XLM always exists
        if (currency.code === 'XLM' && !currency.issuer) {
          return { key, exists: true, numAccounts: -1, amount: 'native' };
        }

        try {
          const response = await queryAssets({
            code: currency.code,
            issuer: currency.issuer,
            limit: 1,
          });

          if (response.records && response.records.length > 0) {
            const record = response.records[0];
            return {
              key,
              exists: true,
              numAccounts: record.num_accounts,
              amount: record.amount,
            };
          }

          return { key, exists: false };
        } catch (err) {
          log.error({ key, err: err.message }, 'Asset validation error');
          return { key, exists: false };
        }
      })
    );

    for (const result of checks) {
      if (result.status === 'fulfilled') {
        results.set(result.value.key, {
          exists: result.value.exists,
          numAccounts: result.value.numAccounts,
          amount: result.value.amount,
        });
      }
    }
  }

  return results;
}

/**
 * Combined validation: validate all issuers + all assets for an anchor.
 * Returns enriched validation result.
 */
export async function validateAnchorOnChain(parsedToml) {
  const { accounts, currencies } = parsedToml;

  log.info(
    { domain: parsedToml.domain, issuers: accounts.length, assets: currencies.length },
    'Starting on-chain validation'
  );

  // ── Validate issuers ────────────────────────────────
  const issuerResults = await validateIssuers(accounts);

  // ── Validate assets ─────────────────────────────────
  const assetsToValidate = currencies.filter((c) => c.issuer); // skip native
  const assetResults = await validateAssets(assetsToValidate);

  // ── Aggregate stats ─────────────────────────────────
  const validIssuers = [...issuerResults.values()].filter(Boolean).length;
  const validAssets = [...assetResults.values()].filter((v) => v.exists).length;

  log.info(
    {
      domain: parsedToml.domain,
      validIssuers: `${validIssuers}/${accounts.length}`,
      validAssets: `${validAssets}/${assetsToValidate.length}`,
    },
    'On-chain validation complete'
  );

  return {
    issuerResults,
    assetResults,
    stats: {
      totalIssuers: accounts.length,
      validIssuers,
      totalAssets: assetsToValidate.length,
      validAssets,
    },
  };
}

export default { validateIssuers, validateAssets, validateAnchorOnChain };
