// ─── Asset Identifier Routes ───────────────────────────────────
// API routes for asset identifier parsing, validation, and conversion

import { 
  parseAssetIdentifier, 
  assetToIdentifier,
  assetsEqual,
  getAssetDisplayName,
  isValidAssetIdentifier,
  getSupportedCurrencies,
  convertAssetIdentifier,
  batchParseAssets
} from '../services/asset/fiatAssetSupport.js';
import { createLogger } from '../lib/logger.js';
import { Errors } from '../plugins/errorHandler.js';

const log = createLogger('asset-id-routes');

/**
 * Register asset identifier routes
 * @param {FastifyInstance} fastify - Fastify instance
 */
export async function assetIdentifierRoutes(fastify) {

  // POST /assets/parse
  // Parse asset identifier
  fastify.post('/assets/parse', {
    schema: {
      body: {
        type: 'object',
        required: ['assetId'],
        properties: {
          assetId: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { assetId } = request.body;

    try {
      const parsed = parseAssetIdentifier(assetId);

      return {
        success: true,
        asset: parsed
      };

    } catch (error) {
      log.error({
        error: error.message,
        assetId
      }, 'Asset identifier parsing failed');

      throw Errors.badRequest(error.message);
    }
  });

  // POST /assets/batch-parse
  // Parse multiple asset identifiers  
  fastify.post('/assets/batch-parse', {
    schema: {
      body: {
        type: 'object',
        required: ['assetIds'],
        properties: {
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 100
          }
        }
      }
    }
  }, async (request, reply) => {
    const { assetIds } = request.body;

    try {
      const results = batchParseAssets(assetIds);

      return {
        success: true,
        results,
        count: results.length,
        total: assetIds.length
      };

    } catch (error) {
      log.error({
        error: error.message,
        count: assetIds.length
      }, 'Batch asset parsing failed');

      throw Errors.badRequest(error.message);
    }
  });

  // POST /assets/validate
  // Validate asset identifier
  fastify.post('/assets/validate', {
    schema: {
      body: {
        type: 'object',
        required: ['assetId'],
        properties: {
          assetId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { assetId } = request.body;

    const isValid = isValidAssetIdentifier(assetId);
    
    let parsed = null;
    let displayName = null;

    if (isValid) {
      try {
        parsed = parseAssetIdentifier(assetId);
        displayName = getAssetDisplayName(parsed);
      } catch (error) {
        // Should not happen if isValid is true, but defensive
      }
    }

    return {
      success: true,
      valid: isValid,
      assetId,
      parsed,
      displayName
    };
  });

  // POST /assets/compare
  // Compare if two assets are equal  
  fastify.post('/assets/compare', {
    schema: {
      body: {
        type: 'object',
        required: ['asset1', 'asset2'],
        properties: {
          asset1: { type: 'string' },
          asset2: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { asset1, asset2 } = request.body;

    try {
      const isEqual = assetsEqual(asset1, asset2);

      return {
        success: true,
        equal: isEqual,
        asset1,
        asset2
      };

    } catch (error) {
      log.error({
        error: error.message,
        asset1,
        asset2
      }, 'Asset comparison failed');

      throw Errors.badRequest(error.message);
    }
  });

  // POST /assets/convert
  // Convert asset identifier format
  fastify.post('/assets/convert', {
    schema: {
      body: {
        type: 'object',
        required: ['fromAssetId', 'toType'],
        properties: {
          fromAssetId: { type: 'string' },
          toType: { 
            type: 'string', 
            enum: ['stellar', 'iso4217', 'fiat']
          },
          options: {
            type: 'object',
            properties: {
              issuer: { type: 'string' },
              rail: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { fromAssetId, toType, options = {} } = request.body;

    try {
      const converted = convertAssetIdentifier(fromAssetId, toType, options);

      return {
        success: true,
        fromAssetId,
        toType,
        convertedAssetId: converted,
        convertible: converted !== null
      };

    } catch (error) {
      log.error({
        error: error.message,
        fromAssetId,
        toType
      }, 'Asset conversion failed');

      throw Errors.badRequest(error.message);
    }
  });

  // GET /assets/supported-currencies
  // Get supported currency codes
  fastify.get('/assets/supported-currencies', async (request, reply) => {
    try {
      const currencies = getSupportedCurrencies();

      return {
        success: true,
        currencies
      };

    } catch (error) {
      log.error({
        error: error.message
      }, 'Failed to get supported currencies');

      throw Errors.internalServerError('Failed to get currencies');
    }
  });

  // POST /assets/display-name  
  // Get display name for asset
  fastify.post('/assets/display-name', {
    schema: {
      body: {
        type: 'object',
        required: ['assetId'],
        properties: {
          assetId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { assetId } = request.body;

    try {
      const displayName = getAssetDisplayName(assetId);

      return {
        success: true,
        assetId,
        displayName
      };

    } catch (error) {
      log.error({
        error: error.message,
        assetId
      }, 'Failed to get display name');

      throw Errors.badRequest(error.message);
    }
  });

  log.info('Asset identifier routes registered');
}