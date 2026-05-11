import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { config } from './config.js';
import healthRouter from './routes/health.js';
import chatRouter from './routes/chat.js';
import agentsRouter from './routes/agents.js';
import projectsRouter from './routes/projects.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createSlackApp } from './slack/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const logger = pino({ level: config.logLevel });

const app = express();

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);

const corsOrigin = config.cors.origin.includes('*') ? true : config.cors.origin;
app.use(cors({ origin: corsOrigin }));

app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.use(healthRouter);
app.use(authMiddleware, rateLimitMiddleware, chatRouter);
app.use(authMiddleware, rateLimitMiddleware, agentsRouter);
app.use(authMiddleware, rateLimitMiddleware, projectsRouter);

app.use('/ui', express.static(publicDir, { fallthrough: true, index: 'index.html' }));
app.get('/', (_req, res) => res.redirect('/ui/'));

app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      env: config.env,
      auth: config.auth.enabled,
      rateLimit: config.rateLimit.enabled,
      claudeBin: config.claude.bin,
      claudeCwd: config.claude.cwd,
      slack: config.slack.enabled,
    },
    'claude-workspace server listening',
  );
});

let slackApp = null;
if (config.slack.enabled) {
  try {
    slackApp = createSlackApp(logger);
    await slackApp.start();
    logger.info({ agent: config.slack.agent }, 'slack bot connected (socket mode)');
  } catch (err) {
    logger.error({ err }, 'failed to start slack bot');
  }
}

const shutdown = (signal) => {
  logger.info({ signal }, 'shutting down');
  const t = setTimeout(() => {
    logger.warn('forcing exit after 10s');
    process.exit(1);
  }, 10_000);
  t.unref();
  const closeSlack = slackApp ? slackApp.stop().catch(() => {}) : Promise.resolve();
  closeSlack.finally(() => {
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      }
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
