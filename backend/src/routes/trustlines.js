// ─── Trustline Management Routes ───────────────────────────────
// API routes for checking trustlines and account state

import { trustlineChecker } from '../services/account/trustlineChecker.js';
import { createLogger } from '../lib/logger.js';
import { Errors } from '../plugins/errorHandler.js';

const log = createLogger('trustline-routes');

/**
 * Register trustline routes
 * @param {FastifyInstance} fastify - Fastify instance
 */
export async function trustlineRoutes(fastify) {
  
  // POST /trustlines/check
  // Check trustlines for route assets
  fastify.post('/trustlines/check', {
    schema: {
      body: {
        type: 'object',
        required: ['userPublicKey', 'assetKeys'],
        properties: {
          userPublicKey: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          },
          assetKeys: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          }
        }
      }
    }
  }, async (request, reply) => {
    const { userPublicKey, assetKeys } = request.body;

    try {
      const trustlineInfo = await trustlineChecker.checkRouteTrustlines(
        userPublicKey,
        assetKeys
      );

      log.debug({
        account: userPublicKey,
        assetsChecked: assetKeys.length,
        missingTrustlines: trustlineInfo.missingTrustlines.length,
        accountExists: trustlineInfo.accountExists
      }, 'Trustline check completed');

      return {
        success: true,
        data: trustlineInfo
      };

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey,
        assetCount: assetKeys.length
      }, 'Trustline check failed');

      throw Errors.badRequest(`Trustline check failed: ${error.message}`);
    }
  });

  // POST /trustlines/check-asset
  // Check trustline for specific asset
  fastify.post('/trustlines/check-asset', {
    schema: {
      body: {
        type: 'object',
        required: ['userPublicKey', 'assetCode', 'assetIssuer'],
        properties: {
          userPublicKey: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          },
          assetCode: { type: 'string' },
          assetIssuer: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          }
        }
      }
    }
  }, async (request, reply) => {
    const { userPublicKey, assetCode, assetIssuer } = request.body;

    try {
      const trustlineInfo = await trustlineChecker.checkAssetTrustline(
        userPublicKey,
        assetCode,
        assetIssuer
      );

      return {
        success: true,
        data: trustlineInfo
      };

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey,
        assetCode,
        assetIssuer
      }, 'Asset trustline check failed');

      throw Errors.badRequest(`Asset trustline check failed: ${error.message}`);
    }
  });

  // POST /trustlines/can-receive
  // Check if account can receive asset
  fastify.post('/trustlines/can-receive', {
    schema: {
      body: {
        type: 'object',
        required: ['userPublicKey', 'assetCode', 'assetIssuer'],
        properties: {
          userPublicKey: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          },
          assetCode: { type: 'string' },
          assetIssuer: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          }
        }
      }
    }
  }, async (request, reply) => {
    const { userPublicKey, assetCode, assetIssuer } = request.body;

    try {
      const canReceive = await trustlineChecker.canReceiveAsset(
        userPublicKey,
        assetCode,
        assetIssuer
      );

      return {
        success: true,
        canReceive,
        asset: {
          code: assetCode,
          issuer: assetIssuer
        }
      };

    } catch (error) {
      log.error({
        error: error.message,
        account: userPublicKey,
        assetCode,
        assetIssuer
      }, 'Asset receivability check failed');

      return {
        success: false,
        canReceive: false,
        error: error.message
      };
    }
  });

  // POST /trustlines/generate-operations
  // Generate trustline operations for missing assets
  fastify.post('/trustlines/generate-operations', {
    schema: {
      body: {
        type: 'object',
        required: ['missingTrustlines'],
        properties: {
          missingTrustlines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['assetCode', 'assetIssuer'],
              properties: {
                assetCode: { type: 'string' },
                assetIssuer: { 
                  type: 'string', 
                  pattern: '^G[A-Z2-7]{55}$'
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { missingTrustlines } = request.body;

    try {
      const operations = trustlineChecker.generateTrustlineOperations(
        missingTrustlines
      );

      log.info({
        trustlineCount: missingTrustlines.length,
        operationCount: operations.length
      }, 'Generated trustline operations');

      return {
        success: true,
        operations,
        count: operations.length
      };

    } catch (error) {
      log.error({
        error: error.message,
        trustlineCount: missingTrustlines.length
      }, 'Trustline operation generation failed');

      throw Errors.badRequest(`Operation generation failed: ${error.message}`);
    }
  });

  // GET /trustlines/stats
  // Get trustline checker cache statistics
  fastify.get('/trustlines/stats', async (request, reply) => {
    try {
      const stats = trustlineChecker.getCacheStats();

      return {
        success: true,
        stats
      };

    } catch (error) {
      log.error({
        error: error.message
      }, 'Failed to get trustline stats');

      throw Errors.internalServerError('Failed to get stats');
    }
  });

  // DELETE /trustlines/cache
  // Clear trustline cache
  fastify.delete('/trustlines/cache', {
    schema: {
      querystring: {
        type: 'object',  
        properties: {
          account: { 
            type: 'string',
            pattern: '^G[A-Z2-7]{55}$'
          }
        }
      }
    }
  }, async (request, reply) => {
    const { account } = request.query;

    try {
      trustlineChecker.clearCache(account);

      log.info({
        account: account || 'all'
      }, 'Trustline cache cleared');

      return {
        success: true,
        message: account ? 
          `Cache cleared for account ${account}` : 
          'All cache cleared'
      };

    } catch (error) {
      log.error({
        error: error.message,
        account
      }, 'Cache clear failed');

      throw Errors.internalServerError('Failed to clear cache');
    }
  });

  log.info('Trustline routes registered');
}