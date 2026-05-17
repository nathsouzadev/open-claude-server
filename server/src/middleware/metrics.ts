import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../services/metrics.js';

const SKIP_PATHS = new Set(['/metrics']);

const routeOf = (req: Request): string => {
  const r = req.route?.path;
  if (r) return Array.isArray(r) ? r.join('|') : r;
  // Express fills baseUrl + route after routing. For requests that didn't
  // match a route (404) we fall back to the raw path to avoid label cardinality
  // blowup, capped at 80 chars.
  const url = req.originalUrl?.split('?')[0] ?? req.path ?? 'unknown';
  return url.length > 80 ? `${url.slice(0, 80)}…` : url;
};

export const metricsMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (SKIP_PATHS.has(req.path)) return next();
  const endTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeOf(req),
      status: String(res.statusCode),
    };
    endTimer(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
};
