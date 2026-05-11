import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { runClaude } from '../services/claudeClient.js';

const router = Router();

const bodySchema = z.object({
  message: z
    .string()
    .min(1, 'message must be a non-empty string')
    .max(config.claude.maxInputChars, `message exceeds ${config.claude.maxInputChars} chars`),
  sessionId: z.string().uuid().optional(),
});

router.post('/chat', async (req, res, next) => {
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      issues: parse.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const { message, sessionId } = parse.data;

  const ac = new AbortController();
  req.on('aborted', () => ac.abort());

  try {
    const result = await runClaude({ message, sessionId, signal: ac.signal, logger: req.log });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
