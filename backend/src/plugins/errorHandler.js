// ─── Stella Protocol — Global Error Handler ───────────────────
// Fastify plugin for consistent error responses.

import { createLogger } from '../lib/logger.js';

const log = createLogger('error-handler');

/**
 * Standard error response shape:
 * {
 *   error: true,
 *   code: "ROUTE_NOT_FOUND",
 *   message: "Human-readable message",
 *   statusCode: 404
 * }
 */
export class StellaError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'StellaError';
  }
}

// ── Named error factories ──────────────────────────────────────
export const Errors = {
  notFound: (msg = 'Resource not found') =>
    new StellaError(msg, 404, 'NOT_FOUND'),
  badRequest: (msg = 'Bad request') =>
    new StellaError(msg, 400, 'BAD_REQUEST'),
  noRoute: (msg = 'No viable route found') =>
    new StellaError(msg, 404, 'NO_ROUTE_FOUND'),
  insufficientLiquidity: (msg = 'Insufficient liquidity on this path') =>
    new StellaError(msg, 422, 'INSUFFICIENT_LIQUIDITY'),
  anchorUnavailable: (domain) =>
    new StellaError(`Anchor temporarily unavailable: ${domain}`, 503, 'ANCHOR_UNAVAILABLE'),
  unauthorized: (msg = 'Authentication required or token expired') =>
    new StellaError(msg, 403, 'UNAUTHORIZED'),
  quoteExpired: (msg = 'Quote has expired') =>
    new StellaError(msg, 410, 'QUOTE_EXPIRED'),
  horizonError: (msg = 'Horizon request failed') =>
    new StellaError(msg, 502, 'HORIZON_ERROR'),
  internalServerError: (msg = 'Internal server error') =>
    new StellaError(msg, 500, 'INTERNAL_ERROR'),
};

/**
 * Fastify error handler plugin.
 */
export default async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    // ── Known Stella errors ────────────────────────
    if (error instanceof StellaError) {
      log.warn(
        { code: error.code, path: request.url },
        error.message
      );
      return reply.status(error.statusCode).send({
        error: true,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
      });
    }

    // ── Fastify validation errors ──────────────────
    if (error.validation) {
      return reply.status(400).send({
        error: true,
        code: 'VALIDATION_ERROR',
        message: error.message,
        statusCode: 400,
      });
    }

    // ── Rate limit errors ──────────────────────────
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: true,
        code: 'RATE_LIMITED',
        message: 'Too many requests — slow down',
        statusCode: 429,
      });
    }

    // ── Unhandled errors ───────────────────────────
    log.error(
      { err: error, path: request.url, method: request.method },
      'Unhandled server error'
    );
    return reply.status(500).send({
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
  });

  // NOTE: 404 handler is set in app.js (after static file registration)
  // to support SPA fallback when frontend/dist exists.
}
