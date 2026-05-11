import { Router } from 'express';
import { isClaudeHealthy, getClaudeStats } from '../services/claudeClient.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const claude = await isClaudeHealthy();
  const mem = process.memoryUsage();
  res.json({
    status: claude ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    claude,
    queue: getClaudeStats(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
  });
});

export default router;
