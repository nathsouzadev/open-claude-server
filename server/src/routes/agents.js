import { Router } from 'express';
import { z } from 'zod';
import {
  listAllAgents,
  readAgent,
  writeAgent,
  deleteAgent,
  AgentFsError,
} from '../services/agentsFs.js';
import { runClaude } from '../services/claudeClient.js';

const router = Router();

const scopeSchema = z.string().regex(/^(user|project:[a-zA-Z0-9][a-zA-Z0-9._-]*)$/, 'invalid scope');
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'invalid name');

const handleFsError = (res, err) => {
  if (err instanceof AgentFsError) {
    return res.status(err.status).json({ error: 'agent_fs_error', message: err.message });
  }
  throw err;
};

router.get('/api/agents', async (_req, res, next) => {
  try {
    const items = await listAllAgents();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/api/agents/:scope/:name', async (req, res, next) => {
  try {
    const scope = scopeSchema.parse(req.params.scope);
    const name = nameSchema.parse(req.params.name);
    const agent = await readAgent(scope, name);
    res.json(agent);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_params', issues: err.issues });
    }
    try {
      return handleFsError(res, err);
    } catch (rethrow) {
      next(rethrow);
    }
  }
});

const putSchema = z.object({ content: z.string().min(1).max(200_000) });

router.put('/api/agents/:scope/:name', async (req, res, next) => {
  try {
    const scope = scopeSchema.parse(req.params.scope);
    const name = nameSchema.parse(req.params.name);
    const { content } = putSchema.parse(req.body);
    const agent = await writeAgent(scope, name, content);
    res.json(agent);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_payload', issues: err.issues });
    }
    try {
      return handleFsError(res, err);
    } catch (rethrow) {
      next(rethrow);
    }
  }
});

router.delete('/api/agents/:scope/:name', async (req, res, next) => {
  try {
    const scope = scopeSchema.parse(req.params.scope);
    const name = nameSchema.parse(req.params.name);
    await deleteAgent(scope, name);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_params', issues: err.issues });
    }
    try {
      return handleFsError(res, err);
    } catch (rethrow) {
      next(rethrow);
    }
  }
});

const runSchema = z.object({ message: z.string().min(1).max(10_000).optional() });

router.post('/api/agents/:scope/:name/run', async (req, res, next) => {
  try {
    const scope = scopeSchema.parse(req.params.scope);
    const name = nameSchema.parse(req.params.name);
    const { message } = runSchema.parse(req.body ?? {});
    await readAgent(scope, name);

    const prompt = message
      ? `Use the ${name} agent to handle the following request: ${message}`
      : `Use the ${name} agent. Run its default behavior and return only its response.`;

    const ac = new AbortController();
    req.on('aborted', () => ac.abort());
    const result = await runClaude({ message: prompt, signal: ac.signal, logger: req.log });
    res.json({ agent: { scope, name }, result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_params', issues: err.issues });
    }
    if (err instanceof AgentFsError) {
      return res.status(err.status).json({ error: 'agent_fs_error', message: err.message });
    }
    next(err);
  }
});

export default router;
