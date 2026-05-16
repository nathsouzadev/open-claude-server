import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { config } from '../config.js';

const noop: RequestHandler = (_req, _res, next) => next();

export const rateLimitMiddleware: RequestHandler = config.rateLimit.enabled
  ? rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    })
  : noop;
