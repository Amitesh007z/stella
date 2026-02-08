// ─── Stella Protocol — Fastify App Factory ────────────────────
// Builds and configures the Fastify instance.
// Separated from index.js for testability.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import config from './config/index.js';
import logger from './lib/logger.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import registerRoutes from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = join(__dirname, '..', '..', 'frontend', 'dist');

export async function buildApp() {
  const app = Fastify({
    logger: false,           // We use our own pino instance
    trustProxy: true,
    requestTimeout: 30000,   // 30s per request
    bodyLimit: 1048576,      // 1MB
  });

  // ── Plugins ────────────────────────────────────────
  await app.register(cors, {
    origin: true,            // Allow all origins in dev; restrict for production
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(rateLimit, {
    max: 100,                // 100 requests per minute per IP
    timeWindow: '1 minute',
  });

  // ── Error handling ─────────────────────────────────
  await app.register(errorHandlerPlugin);

  // ── Request logging + request-id tracing ────────────
  app.addHook('onRequest', (request, reply, done) => {
    request.startTime = Date.now();
    request.reqId = request.headers['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    reply.header('x-request-id', request.reqId);
    reply.header('x-powered-by', 'Stella Protocol');
    logger.debug({ method: request.method, url: request.url, reqId: request.reqId }, '→ incoming');
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const duration = Date.now() - request.startTime;
    logger.info(
      { method: request.method, url: request.url, status: reply.statusCode, ms: duration, reqId: request.reqId },
      '← response'
    );
    done();
  });

  // ── Routes ─────────────────────────────────────────
  await app.register(registerRoutes);

  // ── Production: serve frontend build ───────────────
  if (existsSync(FRONTEND_DIST)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: FRONTEND_DIST,
      wildcard: false,
    });
    // SPA fallback: serve index.html for non-API, non-file routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/health') || request.url.startsWith('/info')) {
        return reply.status(404).send({
          error: true,
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${request.url} not found`,
          statusCode: 404,
        });
      }
      return reply.sendFile('index.html');
    });
    logger.info('Serving production frontend from frontend/dist');
  } else {
    // No frontend build — API-only 404
    app.setNotFoundHandler((request, reply) => {
      reply.status(404).send({
        error: true,
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
      });
    });
  }

  return app;
}
