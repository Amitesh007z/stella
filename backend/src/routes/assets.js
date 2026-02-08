// ─── Stella Protocol — Asset API Routes ───────────────────────
// REST endpoints for the Global Asset Registry.
// Read-only public access + manual sync trigger.

import {
  getAssets,
  countAssets,
  getAssetByIdentifier,
  getAssetCodes,
  getAssetStats,
  getRoutableAssets,
} from '../services/asset/assetRepository.js';
import { syncAssetRegistry } from '../services/asset/assetSync.js';
import { discoverAssetByCode } from '../services/asset/assetDiscovery.js';
import { Errors } from '../plugins/errorHandler.js';

export default async function assetRoutes(fastify) {

  // ═══════════════════════════════════════════════════════
  // GET /api/assets — Browse the asset registry with filters
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Filter by asset code (e.g., USDC, XLM)' },
          issuer: { type: 'string', description: 'Filter by issuer public key' },
          domain: { type: 'string', description: 'Filter by anchor domain' },
          source: { type: 'string', enum: ['horizon', 'anchor', 'manual'] },
          verified: { type: 'boolean', description: 'Only verified on-chain assets' },
          deposit: { type: 'boolean', description: 'Only assets with deposit enabled' },
          withdraw: { type: 'boolean', description: 'Only assets with withdraw enabled' },
          search: { type: 'string', description: 'Free-text search (code, name, domain)' },
          sort: { type: 'string', enum: ['num_accounts', 'code', 'amount', 'last_updated_at'] },
          order: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request) => {
    const {
      code, issuer, domain, source,
      verified, deposit, withdraw,
      search, sort, order,
      limit = 100, offset = 0,
    } = request.query;

    const assets = getAssets({
      code,
      issuer,
      domain,
      source,
      isVerified: verified,
      isDepositEnabled: deposit,
      isWithdrawEnabled: withdraw,
      search,
      sortBy: sort,
      sortOrder: order,
      limit,
      offset,
    });

    const total = countAssets({ code, source, isVerified: verified, search });

    return {
      total,
      count: assets.length,
      limit,
      offset,
      assets: assets.map(formatAssetResponse),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/assets/stats — Registry statistics
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets/stats', async () => {
    return getAssetStats();
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/assets/codes — Unique asset codes (for pickers)
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets/codes', async () => {
    const codes = getAssetCodes();
    return {
      count: codes.length,
      codes: codes.map((c) => ({ code: c.code, issuers: c.issuer_count })),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/assets/routable — Assets available for routing
  //   Data contract for Phase 4 (Route Graph)
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets/routable', async () => {
    const assets = getRoutableAssets();
    return {
      count: assets.length,
      assets: assets.map(formatAssetResponse),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/assets/:code — Get all issuers for an asset code
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets/:code', async (request) => {
    const { code } = request.params;
    const assets = getAssets({ code: code.toUpperCase(), limit: 100 });

    if (assets.length === 0) {
      throw Errors.notFound(`No assets found with code: ${code}`);
    }

    return {
      code: code.toUpperCase(),
      issuers: assets.length,
      assets: assets.map(formatAssetResponse),
    };
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/assets/:code/:issuer — Single asset lookup
  // ═══════════════════════════════════════════════════════
  fastify.get('/assets/:code/:issuer', async (request) => {
    const { code, issuer } = request.params;
    const asset = getAssetByIdentifier(code.toUpperCase(), issuer === 'native' ? null : issuer);

    if (!asset) {
      throw Errors.notFound(`Asset not found: ${code}:${issuer}`);
    }

    return formatAssetResponse(asset);
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/assets/sync — Manually trigger asset sync
  // ═══════════════════════════════════════════════════════
  fastify.post('/assets/sync', async () => {
    const result = await syncAssetRegistry();
    return result;
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/assets/discover/:code — Discover a specific asset
  // ═══════════════════════════════════════════════════════
  fastify.post('/assets/discover/:code', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          issuer: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { code } = request.params;
    const { issuer } = request.query;
    const result = await discoverAssetByCode(code.toUpperCase(), issuer);
    return result;
  });
}

// ─── Response Formatter ──────────────────────────────────────

function formatAssetResponse(asset) {
  return {
    code: asset.code,
    issuer: asset.issuer,
    assetType: asset.asset_type,
    // Canonical identifier used by the route graph
    identifier: asset.issuer ? `${asset.code}:${asset.issuer}` : `${asset.code}:native`,
    // Metadata
    name: asset.name,
    description: asset.description,
    domain: asset.domain || asset.anchor_domain,
    imageUrl: asset.image_url,
    displayDecimals: asset.display_decimals || 7,
    // Verification & source
    isVerified: !!asset.is_verified,
    source: asset.source,
    // On-chain stats
    numAccounts: asset.num_accounts,
    amount: asset.amount,
    // Anchor capabilities
    anchorDomain: asset.anchor_domain,
    isDepositEnabled: !!asset.is_deposit_enabled,
    isWithdrawEnabled: !!asset.is_withdraw_enabled,
    sep38Supported: !!asset.sep38_supported,
    // Anchoring info
    isAnchorAsset: !!asset.is_anchor_asset,
    anchorAssetType: asset.anchor_asset_type,
    // Timestamps
    lastUpdated: asset.last_updated_at,
    created: asset.created_at,
  };
}
