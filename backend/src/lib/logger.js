// ─── Stella Protocol — Logger ──────────────────────────────────
// Structured logging via Pino. All modules use this singleton.

import pino from 'pino';
import config from '../config/index.js';

const isDevMode = config.logLevel === 'debug';

const logger = pino({
  level: config.logLevel,
  ...(isDevMode && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
  // Production: raw JSON logs (default pino behavior)
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export default logger;

/**
 * Create a child logger scoped to a module.
 * Usage: const log = createLogger('anchor-crawl');
 */
export function createLogger(module) {
  return logger.child({ module });
}
