import { Router } from 'express';
import { z } from 'zod';
import { query, type GroupBy } from '../services/usageQuery.js';
import type { UsageSource } from '../types.js';

const router = Router();

const SOURCE_VALUES = ['slack', 'cron', 'http', 'chat'] as const;
const GROUP_BY_VALUES = ['agent', 'source', 'slackUserId', 'slackChannelId', 'none'] as const;

const querySchema = z.object({
  agent: z.string().min(1).optional(),
  source: z.enum(SOURCE_VALUES).optional(),
  from: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  to: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  groupBy: z.enum(GROUP_BY_VALUES).optional(),
  slackUserId: z.string().min(1).optional(),
  slackChannelId: z.string().min(1).optional(),
});

router.get('/usage', async (req, res, next) => {
  const parse = querySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({
      error: 'invalid_params',
      issues: parse.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { agent, source, from, to, groupBy, slackUserId, slackChannelId } = parse.data;

  if (from && to && from > to) {
    res.status(400).json({
      error: 'invalid_params',
      issues: [{ path: 'from', message: '"from" must be before "to"' }],
    });
    return;
  }

  try {
    const result = await query({
      agent,
      source: source as UsageSource | undefined,
      from,
      to,
      groupBy: groupBy as GroupBy | undefined,
      slackUserId,
      slackChannelId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
