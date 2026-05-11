import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const noop = (_req, _res, next) => next();

export const rateLimitMiddleware = config.rateLimit.enabled
  ? rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    })
  : noop;
