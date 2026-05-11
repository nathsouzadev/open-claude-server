import { ClaudeError } from '../services/claudeClient.js';

export const errorHandler = (err, req, res, _next) => {
  req.log?.error({ err }, 'request failed');

  if (err instanceof ClaudeError) {
    if (err.kind === 'timeout') {
      return res.status(504).json({ error: 'claude_timeout', message: err.message });
    }
    if (err.kind === 'aborted') {
      return res.status(499).json({ error: 'client_aborted' });
    }
    if (err.kind === 'spawn') {
      return res.status(500).json({ error: 'claude_spawn_failed', message: err.message });
    }
    return res.status(502).json({
      error: 'claude_failed',
      message: err.message,
      stderr: err.stderr ? err.stderr.slice(0, 500) : undefined,
    });
  }

  res.status(500).json({ error: 'internal_error' });
};
