// ─── Stella Protocol — Route Registration ─────────────────────
// All API routes are registered here under /api prefix.

import healthRoutes from './health.js';
import anchorRoutes from './anchors.js';
import assetRoutes from './assets.js';
import graphRoutes from './graph.js';
import routeRoutes from './routes.js';
import quoteRoutes from './quotes.js';
import registryRoutes from './registry.js';
import { sep10Routes } from './sep10.js';
import { sep24Routes } from './sep24.js';
import { trustlineRoutes } from './trustlines.js';
import { assetIdentifierRoutes } from './assetIdentifiers.js';

export default async function registerRoutes(fastify) {
  // ── Unprefixed health routes ──────────────────────
  fastify.register(healthRoutes);

  // ── API v1 routes ─────────────────────────────────
  fastify.register(async function apiRoutes(api) {
    api.register(anchorRoutes);       // Phase 2: /api/anchors/*
    api.register(assetRoutes);        // Phase 3: /api/assets/*
    api.register(graphRoutes);        // Phase 4: /api/graph/*
    api.register(routeRoutes);        // Phase 5: /api/routes/*
    api.register(quoteRoutes);        // Phase 6: /api/quotes/*
    api.register(sep10Routes);        // SEP-10: /api/sep10/*
    api.register(sep24Routes);        // SEP-24: /api/sep24/*
    api.register(trustlineRoutes);    // Trustlines: /api/trustlines/*
    api.register(assetIdentifierRoutes); // Asset IDs: /api/assets/*
  }, { prefix: '/api' });
  
  // ── Registry routes (no prefix - handles /api internally) ──
  fastify.register(registryRoutes);
}
