import { Router } from 'express';
import { z } from 'zod';
import { addJob, listJobs, getJob, removeJob, runJobNow } from '../services/scheduler.js';

const router = Router();

const destinationSchema = z
  .object({
    type: z.literal('slack'),
    channel: z.string().min(1),
    bot: z.string().optional(),
  })
  .nullable()
  .optional();

const createSchema = z.object({
  expr: z.string().min(1).max(120),
  agent: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
  name: z.string().min(1).max(120).optional(),
  destination: destinationSchema,
  catchUp: z.boolean().optional(),
  catchUpWindowMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
});

router.post('/api/jobs', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body ?? {});
    const job = await addJob(body);
    res.status(201).json(job);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_params', issues: err.issues });
    }
    if (err.message?.startsWith('invalid cron expression')) {
      return res.status(400).json({ error: 'invalid_cron', message: err.message });
    }
    next(err);
  }
});

router.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

router.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json(job);
});

router.delete('/api/jobs/:id', async (req, res) => {
  const ok = await removeJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

router.post('/api/jobs/:id/run', (req, res) => {
  const ok = runJobNow(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.status(202).json({ status: 'scheduled' });
});

export default router;
