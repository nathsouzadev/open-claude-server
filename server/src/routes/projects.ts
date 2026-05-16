import { Router } from 'express';
import { listProjects } from '../services/agentsFs.js';

const router = Router();

router.get('/api/projects', async (_req, res, next) => {
  try {
    const items = await listProjects();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

export default router;
