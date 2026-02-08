// ─── Stella Protocol — Registry Routes ────────────────────────
// REST endpoints for Route Integrity Registry interactions
'use strict';

import * as registry from '../services/registry/index.js';

export default async function registryRoutes(fastify) {
  // ─── Get Commitment by Route Hash ───────────────────────────
  fastify.get('/api/registry/commitment/:routeHash', {
    schema: {
      description: 'Retrieve a route commitment by its hash',
      params: {
        type: 'object',
        properties: {
          routeHash: { type: 'string', minLength: 64, maxLength: 64 }
        },
        required: ['routeHash']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            routeHash: { type: 'string' },
            rulesHash: { type: 'string' },
            solverVersionHash: { type: 'string' },
            committer: { type: 'string' },
            timestamp: { type: 'integer' },
            expiry: { type: 'integer' }
          }
        }
      }
    }
  }, async (req, reply) => {
    const { routeHash } = req.params;
    
    try {
      const commitment = await registry.getCommitment(routeHash);
      return commitment;
    } catch (err) {
      reply.code(404);
      return { error: err.message };
    }
  });

  // ─── Verify Commitment ──────────────────────────────────────
  fastify.post('/api/registry/verify', {
    schema: {
      description: 'Verify a route commitment matches expected hashes',
      body: {
        type: 'object',
        properties: {
          routeHash: { type: 'string', minLength: 64, maxLength: 64 },
          rulesHash: { type: 'string', minLength: 64, maxLength: 64 },
          solverHash: { type: 'string', minLength: 64, maxLength: 64 }
        },
        required: ['routeHash', 'rulesHash', 'solverHash']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            verified: { type: 'boolean' },
            timestamp: { type: 'integer' },
            expiry: { type: 'integer' },
            committer: { type: 'string' },
            error: { type: 'string' }
          }
        }
      }
    }
  }, async (req) => {
    const { routeHash, rulesHash, solverHash } = req.body;
    return registry.verifyCommitment({ routeHash, rulesHash, solverHash });
  });

  // ─── Commit a Route (Admin/Testing) ─────────────────────────
  fastify.post('/api/registry/commit', {
    schema: {
      description: 'Store a new route commitment',
      body: {
        type: 'object',
        properties: {
          routeHash: { type: 'string', minLength: 64, maxLength: 64 },
          rulesHash: { type: 'string', minLength: 64, maxLength: 64 },
          solverVersionHash: { type: 'string', minLength: 64, maxLength: 64 },
          expiry: { type: 'integer', default: 0 }
        },
        required: ['routeHash', 'rulesHash', 'solverVersionHash']
      }
    }
  }, async (req, reply) => {
    try {
      const commitment = await registry.commitRoute(req.body);
      reply.code(201);
      return commitment;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  // ─── Check if Commitment Exists ─────────────────────────────
  fastify.get('/api/registry/exists/:routeHash', {
    schema: {
      description: 'Check if a commitment exists for a route hash',
      params: {
        type: 'object',
        properties: {
          routeHash: { type: 'string', minLength: 64, maxLength: 64 }
        },
        required: ['routeHash']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' }
          }
        }
      }
    }
  }, async (req) => {
    const { routeHash } = req.params;
    const exists = await registry.hasCommitment(routeHash);
    return { exists };
  });

  // ─── Registry Stats ─────────────────────────────────────────
  fastify.get('/api/registry/stats', {
    schema: {
      description: 'Get registry statistics',
      response: {
        200: {
          type: 'object',
          properties: {
            totalCommitments: { type: 'integer' },
            last24h: { type: 'integer' },
            oldestTimestamp: { type: ['integer', 'null'] },
            newestTimestamp: { type: ['integer', 'null'] },
            contractStatus: { type: 'string' }
          }
        }
      }
    }
  }, async () => {
    return registry.getStats();
  });

  // ─── Hash Utilities (for testing/debugging) ─────────────────
  fastify.post('/api/registry/hash', {
    schema: {
      description: 'Compute hashes for testing purposes',
      body: {
        type: 'object',
        properties: {
          routeManifest: { type: 'object' },
          rulesConfig: { type: 'object' },
          solverVersion: { type: 'string' }
        }
      }
    }
  }, async (req) => {
    const { routeManifest, rulesConfig, solverVersion } = req.body;
    
    const result = {};
    if (routeManifest) {
      result.routeHash = registry.hashRouteManifest(routeManifest);
    }
    if (rulesConfig) {
      result.rulesHash = registry.hashRulesConfig(rulesConfig);
    }
    if (solverVersion) {
      result.solverVersionHash = registry.hashSolverVersion(solverVersion);
    }
    
    return result;
  });
}
