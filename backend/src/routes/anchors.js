// ─── Stella Protocol — Anchor API Routes ──────────────────────
// REST endpoints for the Anchor Capability Index.
// Read-only public access to anchor data.

import {
  getAnchors,
  getAnchorByDomain,
  getAnchorAssets,
  getAnchorStats,
  getCrawlHistory,
  getAllVerifiedAssets,
} from '../services/anchor/anchorRepository.js';
import { triggerManualRefresh } from '../services/anchor/crawlScheduler.js';
import { crawlAnchor } from '../services/anchor/anchorIndexer.js';
import { Errors } from '../plugins/errorHandler.js';

export default async function anchorRoutes(fastify) {

  // ═══════════════════════════════════════════════════════
  // GET /api/anchors — List all anchors with optional filters
  // ═══════════════════════════════════════════════════════
  fastify.get('/anchors', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'paused', 'error', 'unreachable'] },
          health: { type: 'string', enum: ['healthy', 'degraded', 'offline', 'unknown'] },
          trust: { type: 'string', enum: ['seeded', 'discovered', 'community'] },
          min_completeness: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  }, async (request) => {
    const { status, health, trust, min_completeness } = request.query;

    const anchors = getAnchors({
      status,
      healthStatus: health,
      trustLevel: trust,
      minCompleteness: min_completeness,
    });

    // Attach asset counts to each anchor
    const result = anchors.map((anchor) => {
      const assets = getAnchorAssets(anchor.id);
      return formatAnchorResponse(anchor, assets);
    });

    return {
      count: result.length,
      anchors: result,
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/anchors/stats — Aggregate anchor statistics
  // ═══════════════════════════════════════════════════════
  fastify.get('/anchors/stats', async () => {
    return getAnchorStats();
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/anchors/:domain — Single anchor details
  // ═══════════════════════════════════════════════════════
  fastify.get('/anchors/:domain', async (request) => {
    const { domain } = request.params;
    const anchor = getAnchorByDomain(domain);

    if (!anchor) {
      throw Errors.notFound(`Anchor not found: ${domain}`);
    }

    const assets = getAnchorAssets(anchor.id);
    const crawlHist = getCrawlHistory(domain, 5);

    return {
      ...formatAnchorResponse(anchor, assets),
      crawlHistory: crawlHist.map((c) => ({
        status: c.status,
        assetsFound: c.assets_found,
        durationMs: c.duration_ms,
        error: c.error_message,
        timestamp: c.created_at,
      })),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/anchors/:domain/assets — Assets for an anchor
  // ═══════════════════════════════════════════════════════
  fastify.get('/anchors/:domain/assets', async (request) => {
    const { domain } = request.params;
    const anchor = getAnchorByDomain(domain);

    if (!anchor) {
      throw Errors.notFound(`Anchor not found: ${domain}`);
    }

    const assets = getAnchorAssets(anchor.id);
    return {
      domain,
      count: assets.length,
      assets: assets.map(formatAssetResponse),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/anchors/assets/verified — All verified on-chain assets
  // Data contract for Phase 3 (Asset Registry)
  // ═══════════════════════════════════════════════════════
  fastify.get('/anchors/assets/verified', async () => {
    const assets = getAllVerifiedAssets();
    return {
      count: assets.length,
      assets: assets.map((a) => ({
        code: a.code,
        issuer: a.issuer,
        assetType: a.asset_type,
        domain: a.anchor_domain,
        anchorName: a.anchor_display_name,
        anchorHealth: a.anchor_health,
        anchorTrust: a.anchor_trust,
        isDepositEnabled: !!a.is_deposit_enabled,
        isWithdrawEnabled: !!a.is_withdraw_enabled,
        sep38Supported: !!a.sep38_supported,
        isOnChain: !!a.is_on_chain,
        numAccounts: a.num_accounts,
        feeFixed: a.fee_fixed,
        feePercent: a.fee_percent,
      })),
    };
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/anchors/crawl/:domain — Manually trigger crawl
  // ═══════════════════════════════════════════════════════
  fastify.post('/anchors/crawl/:domain', async (request) => {
    const { domain } = request.params;
    const result = await crawlAnchor(domain, { trustLevel: 'discovered' });
    return result;
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/anchors/refresh — Trigger full refresh cycle
  // ═══════════════════════════════════════════════════════
  fastify.post('/anchors/refresh', async () => {
    return triggerManualRefresh();
  });
}

// ─── Response Formatters ──────────────────────────────────────

function formatAnchorResponse(anchor, assets = []) {
  return {
    id: anchor.id,
    domain: anchor.domain,
    name: anchor.name,
    status: anchor.status,
    trustLevel: anchor.trust_level,
    healthStatus: anchor.health_status,
    healthScore: anchor.health_score,
    completenessScore: anchor.completeness_score,
    capabilities: {
      transferServer: !!anchor.transfer_server,
      transferServerSep24: !!anchor.transfer_server_sep24,
      quoteServer: !!anchor.quote_server,
      webAuth: !!anchor.web_auth_endpoint,
    },
    assets: {
      total: assets.length,
      onChain: assets.filter((a) => a.is_on_chain).length,
      depositEnabled: assets.filter((a) => a.is_deposit_enabled).length,
      withdrawEnabled: assets.filter((a) => a.is_withdraw_enabled).length,
    },
    crawlStats: {
      successCount: anchor.crawl_success_count,
      failCount: anchor.crawl_fail_count,
      lastCrawled: anchor.last_crawled_at,
      lastError: anchor.last_error,
    },
    timestamps: {
      created: anchor.created_at,
      updated: anchor.updated_at,
      horizonValidated: anchor.horizon_validated_at,
    },
  };
}

function formatAssetResponse(asset) {
  return {
    id: asset.id,
    code: asset.code,
    issuer: asset.issuer,
    assetType: asset.asset_type,
    status: asset.status,
    isOnChain: !!asset.is_on_chain,
    isDepositEnabled: !!asset.is_deposit_enabled,
    isWithdrawEnabled: !!asset.is_withdraw_enabled,
    sep38Supported: !!asset.sep38_supported,
    fees: {
      fixed: asset.fee_fixed,
      percent: asset.fee_percent,
    },
    limits: {
      min: asset.min_amount,
      max: asset.max_amount,
    },
    onChainData: {
      numAccounts: asset.num_accounts,
      amountCirculating: asset.amount_circulating,
      validatedAt: asset.horizon_validated_at,
    },
    metadata: {
      name: asset.anchor_name,
      description: asset.description,
      displayDecimals: asset.display_decimals,
      isAssetAnchored: !!asset.is_asset_anchored,
      anchorAssetType: asset.anchor_asset_type,
    },
  };
}
