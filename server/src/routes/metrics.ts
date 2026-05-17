import { Router } from 'express';
import { claudeHealthy, registry } from '../services/metrics.js';
import { isClaudeHealthy } from '../services/claudeClient.js';

const router = Router();

router.get('/metrics', async (_req, res, next) => {
  try {
    claudeHealthy.set((await isClaudeHealthy()) ? 1 : 0);
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    next(err);
  }
});

export default router;
