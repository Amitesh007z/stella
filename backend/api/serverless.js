// ─── Stella Protocol — Vercel Serverless Entry Point ──────────
// This adapter exposes the Fastify app as a Vercel serverless function.
// Note: Full functionality requires persistent storage (see README).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import config from '../src/config/index.js';
import errorHandlerPlugin from '../src/plugins/errorHandler.js';
import registerRoutes from '../src/routes/index.js';

let app;

async function buildApp() {
  if (app) return app;

  app = Fastify({
    logger: false,
    trustProxy: true,
    requestTimeout: 25000,  // Vercel has 30s limit
    bodyLimit: 1048576,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(errorHandlerPlugin);

  // Request ID header
  app.addHook('onRequest', (request, reply, done) => {
    request.startTime = Date.now();
    request.reqId = request.headers['x-request-id'] || `req_${Date.now().toString(36)}`;
    reply.header('x-request-id', request.reqId);
    reply.header('x-powered-by', 'Stella Protocol');
    done();
  });

  // Register API routes
  await registerRoutes(app);

  await app.ready();
  return app;
}

export default async function handler(req, res) {
  const fastify = await buildApp();
  await fastify.ready();
  fastify.server.emit('request', req, res);
}
