import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { runClaude } from '../services/claudeClient.js';
import { record } from '../services/usageRecorder.js';
import type { ClaudeErrorKind } from '../types.js';

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
    res.status(400).json({
      error: 'invalid_payload',
      issues: parse.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { message, sessionId } = parse.data;

  const ac = new AbortController();
  req.on('aborted', () => ac.abort());

  try {
    const result = await runClaude({
      message,
      sessionId,
      signal: ac.signal,
      logger: req.log,
      meta: { source: 'chat', agent: 'chat' },
    });
    await record({
      ts: new Date().toISOString(),
      requestId: result.requestId,
      agent: 'chat',
      source: 'chat',
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationTokens: result.usage?.cacheCreationInputTokens ?? 0,
      costUsd: result.costUsd ?? 0,
      durationMs: result.durationMs,
      success: true,
    }).catch((recordErr) => req.log.warn({ err: recordErr }, 'failed to record usage'));
    res.json(result);
  } catch (err) {
    const e = err as { kind?: ClaudeErrorKind; requestId?: string };
    // best-effort: requestId may not be available if the error happened before runClaude returned
    record({
      ts: new Date().toISOString(),
      requestId: e.requestId ?? crypto.randomUUID(),
      agent: 'chat',
      source: 'chat',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      success: false,
      errorCode: e.kind ?? 'unknown',
    }).catch(() => {
      /* ignore record failure in error path */
    });
    next(err);
  }
});

export default router;
