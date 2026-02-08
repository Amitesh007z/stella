// ─── Stella Protocol — Quote API Endpoints ────────────────────
// REST endpoints for the execution-grade quote system.
//
//   POST   /api/quotes          — Create a new quote
//   GET    /api/quotes/:id      — Get an existing quote
//   POST   /api/quotes/:id/refresh — Refresh a quote with live data
//   GET    /api/quotes/stats    — Quote manager statistics

import {
  createQuote,
  getQuote,
  refreshQuote,
  getQuoteStats,
} from '../services/execution/quoteManager.js';
import { Errors } from '../plugins/errorHandler.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('quotes-api');

export default async function quoteRoutes(fastify) {

  // ═══════════════════════════════════════════════════════
  // POST /api/quotes — Create a new quote
  // ═══════════════════════════════════════════════════════
  fastify.post('/quotes', {
    schema: {
      body: {
        type: 'object',
        required: ['sourceCode', 'destCode', 'amount'],
        properties: {
          sourceCode:         { type: 'string', minLength: 1 },
          sourceIssuer:       { type: 'string', nullable: true },
          destCode:           { type: 'string', minLength: 1 },
          destIssuer:         { type: 'string', nullable: true },
          amount:             { type: 'string', minLength: 1 },
          mode:               { type: 'string', enum: ['send', 'receive'], default: 'send' },
          maxHops:            { type: 'integer', minimum: 1, maximum: 6 },
          maxRoutes:          { type: 'integer', minimum: 1, maximum: 20 },
          slippageTolerance:  { type: 'number', minimum: 0, maximum: 50, default: 1.0 },
          liveSlippage:       { type: 'boolean', default: false },
        },
      },
    },
  }, async (request) => {
    const {
      sourceCode, sourceIssuer,
      destCode, destIssuer,
      amount,
      mode,
      maxHops,
      maxRoutes,
      slippageTolerance = 1.0,
      liveSlippage = false,
    } = request.body;

    const quote = await createQuote(
      {
        sourceCode,
        sourceIssuer: sourceIssuer || null,
        destCode,
        destIssuer: destIssuer || null,
        amount,
        mode,
        maxHops,
        maxRoutes,
      },
      { slippageTolerance, liveSlippage }
    );

    return quote;
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/quotes/stats — Quote system statistics
  // ═══════════════════════════════════════════════════════
  // NOTE: Registered before :id to avoid matching "stats" as an ID
  fastify.get('/quotes/stats', async () => {
    return getQuoteStats();
  });

  // ═══════════════════════════════════════════════════════
  // GET /api/quotes/:id — Retrieve an existing quote
  // ═══════════════════════════════════════════════════════
  fastify.get('/quotes/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request) => {
    const quote = getQuote(request.params.id);
    if (!quote) {
      throw Errors.notFound(`Quote not found: ${request.params.id}`);
    }
    return quote;
  });

  // ═══════════════════════════════════════════════════════
  // POST /api/quotes/:id/refresh — Refresh with live data
  // ═══════════════════════════════════════════════════════
  fastify.post('/quotes/:id/refresh', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request) => {
    const refreshed = await refreshQuote(request.params.id);
    return refreshed;
  });
}
