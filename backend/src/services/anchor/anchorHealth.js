// ─── Stella Protocol — Anchor Health Scoring ──────────────────
// Lightweight heuristics for anchor quality & reliability.
// Produces: health_score (0.0–1.0), health_status, completeness_score.
//
// This is pure computation — no DB writes, no side effects.

import { createLogger } from '../../lib/logger.js';

const log = createLogger('anchor-health');

// ── Threshold Config ─────────────────────────────────────────
const THRESHOLDS = {
  // Health status thresholds
  HEALTHY_MIN_SCORE: 0.6,
  DEGRADED_MIN_SCORE: 0.3,
  // offline if < DEGRADED_MIN_SCORE

  // Minimum completeness for visibility in routing
  MIN_COMPLETENESS_FOR_ROUTING: 0.3,

  // Crawl fail ratio threshold
  MAX_FAIL_RATIO: 0.5,
};

export { THRESHOLDS };

/**
 * Compute completeness score for an anchor (0.0 – 1.0).
 * Measures how much metadata is available.
 */
export function computeCompletenessScore(parsedToml) {
  let score = 0;
  let maxScore = 0;

  // ── Required fields (high weight) ──────────────────
  const requiredFields = [
    { field: parsedToml.orgName, weight: 10 },
    { field: parsedToml.currencies?.length > 0, weight: 20 },
    { field: parsedToml.accounts?.length > 0, weight: 15 },
  ];

  // ── Important fields ───────────────────────────────
  const importantFields = [
    { field: parsedToml.transferServer || parsedToml.transferServerSep24, weight: 10 },
    { field: parsedToml.webAuthEndpoint, weight: 5 },
    { field: parsedToml.signingKey, weight: 5 },
    { field: parsedToml.orgUrl, weight: 3 },
    { field: parsedToml.orgDescription, weight: 3 },
  ];

  // ── Nice-to-have fields ────────────────────────────
  const optionalFields = [
    { field: parsedToml.quoteServer, weight: 5 },
    { field: parsedToml.federationServer, weight: 2 },
    { field: parsedToml.orgLogo, weight: 2 },
  ];

  const allFields = [...requiredFields, ...importantFields, ...optionalFields];

  for (const { field, weight } of allFields) {
    maxScore += weight;
    if (field) score += weight;
  }

  // ── Per-currency completeness bonus ────────────────
  if (parsedToml.currencies?.length > 0) {
    const currencyBonus = parsedToml.currencies.reduce((acc, c) => {
      let cScore = 0;
      if (c.issuer) cScore += 3;
      if (c.description) cScore += 1;
      if (c.name) cScore += 1;
      if (c.isAssetAnchored) cScore += 1;
      return acc + cScore;
    }, 0);
    const maxCurrencyBonus = parsedToml.currencies.length * 6;
    score += (currencyBonus / maxCurrencyBonus) * 20;
    maxScore += 20;
  }

  return Math.round((score / maxScore) * 100) / 100;
}

/**
 * Compute health score for an anchor (0.0 – 1.0).
 * Combines crawl reliability + on-chain validation.
 */
export function computeHealthScore({ crawlResult, validationStats, crawlHistory }) {
  let score = 0;

  // ── TOML fetch success (40%) ───────────────────────
  if (crawlResult?.ok) {
    score += 0.4;
  }

  // ── On-chain validation (40%) ──────────────────────
  if (validationStats) {
    const { totalIssuers, validIssuers, totalAssets, validAssets } = validationStats;

    // Issuer existence (20%)
    if (totalIssuers > 0) {
      score += 0.2 * (validIssuers / totalIssuers);
    }

    // Asset existence (20%)
    if (totalAssets > 0) {
      score += 0.2 * (validAssets / totalAssets);
    } else if (totalIssuers > 0 && validIssuers > 0) {
      // No specific assets to validate, but issuers exist
      score += 0.1;
    }
  }

  // ── Historical reliability (20%) ───────────────────
  if (crawlHistory && crawlHistory.length > 0) {
    const recent = crawlHistory.slice(0, 10);
    const successCount = recent.filter((c) => c.status === 'success').length;
    score += 0.2 * (successCount / recent.length);
  } else if (crawlResult?.ok) {
    // First crawl and it worked — give partial credit
    score += 0.1;
  }

  return Math.round(score * 100) / 100;
}

/**
 * Derive health status from health score.
 */
export function deriveHealthStatus(healthScore) {
  if (healthScore >= THRESHOLDS.HEALTHY_MIN_SCORE) return 'healthy';
  if (healthScore >= THRESHOLDS.DEGRADED_MIN_SCORE) return 'degraded';
  return 'offline';
}

/**
 * Determine if an anchor should be visible to the routing engine.
 */
export function isRoutingVisible(anchor) {
  return (
    anchor.status === 'active' &&
    anchor.health_status !== 'offline' &&
    anchor.completeness_score >= THRESHOLDS.MIN_COMPLETENESS_FOR_ROUTING
  );
}

export default {
  computeCompletenessScore,
  computeHealthScore,
  deriveHealthStatus,
  isRoutingVisible,
  THRESHOLDS,
};
