import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { config } from './config.js';
import healthRouter from './routes/health.js';
import chatRouter from './routes/chat.js';
import agentsRouter from './routes/agents.js';
import projectsRouter from './routes/projects.js';
import jobsRouter from './routes/jobs.js';
import usageRouter from './routes/usage.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createSlackApps, type SlackAppHandle } from './slack/app.js';
import {
  loadPersisted as loadJobs,
  registerSlackClient,
  setLogger as setSchedulerLogger,
  stopAll as stopAllJobs,
} from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const logger = pino({ level: config.logLevel });

const isSocketModeFinityError = (err: unknown): boolean => {
  const e = err as { message?: string; stack?: string };
  return Boolean(
    e?.message?.includes("Unhandled event 'server explicit disconnect'") ||
      e?.stack?.includes('finity/lib/core/StateMachine'),
  );
};

process.on('uncaughtException', (err) => {
  if (isSocketModeFinityError(err)) {
    logger.warn(
      { err: err.message },
      'swallowed @slack/socket-mode finity crash; bolt will reconnect',
    );
    return;
  }
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isSocketModeFinityError(reason)) {
    logger.warn(
      { reason: (reason as { message?: string })?.message },
      'swallowed @slack/socket-mode finity rejection',
    );
    return;
  }
  logger.error({ reason }, 'unhandledRejection');
});

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

const corsOrigin: boolean | string[] = config.cors.origin.includes('*')
  ? true
  : config.cors.origin;
app.use(cors({ origin: corsOrigin }));

app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.use(healthRouter);
app.use(authMiddleware, rateLimitMiddleware, chatRouter);
app.use(authMiddleware, rateLimitMiddleware, agentsRouter);
app.use(authMiddleware, rateLimitMiddleware, projectsRouter);
app.use(authMiddleware, rateLimitMiddleware, jobsRouter);
app.use(authMiddleware, rateLimitMiddleware, usageRouter);

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
      slackBots: config.slack.bots.length,
      claudeMaxConcurrency: config.claude.maxConcurrency,
    },
    'claude-workspace server listening',
  );
});

let slackApps: SlackAppHandle[] = [];
if (config.slack.enabled) {
  try {
    slackApps = createSlackApps(logger);
    await Promise.all(
      slackApps.map(async ({ app, cfg, init }) => {
        await app.start();
        await init();
        registerSlackClient(cfg.name, app.client);
        logger.info(
          { bot: cfg.name, agent: cfg.agent },
          'slack bot connected (socket mode)',
        );
      }),
    );
  } catch (err) {
    logger.error({ err }, 'failed to start slack bots');
  }
}

setSchedulerLogger(logger);
await loadJobs();

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  const t = setTimeout(() => {
    logger.warn('forcing exit after 10s');
    process.exit(1);
  }, 10_000);
  t.unref();
  stopAllJobs();
  const closeSlack = Promise.all(
    slackApps.map(({ app }) => app.stop().catch(() => {})),
  );
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
