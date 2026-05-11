import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const safeEqual = (a, b) => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

export const authMiddleware = (req, res, next) => {
  if (!config.auth.enabled) return next();

  if (!config.auth.token) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'AUTH_ENABLED=true but API_TOKEN is empty' });
  }

  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: 'unauthorized' });

  const token = match[1].trim();
  if (!safeEqual(token, config.auth.token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
};
