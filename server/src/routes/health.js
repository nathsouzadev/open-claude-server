import { Router } from 'express';
import { isClaudeHealthy } from '../services/claudeClient.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const claude = await isClaudeHealthy();
  res.json({
    status: claude ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    claude,
  });
});

export default router;
