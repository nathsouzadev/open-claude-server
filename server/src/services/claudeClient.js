import { spawn } from 'node:child_process';
import { config } from '../config.js';

export class ClaudeError extends Error {
  constructor(message, { kind, cause, exitCode, stderr } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    if (cause) this.cause = cause;
    if (exitCode !== undefined) this.exitCode = exitCode;
    if (stderr) this.stderr = stderr;
  }
}

let inFlight = 0;
const waiters = [];

const acquireSlot = (signal) =>
  new Promise((resolve, reject) => {
    const tryRun = () => {
      if (inFlight < config.claude.maxConcurrency) {
        inFlight += 1;
        resolve(release);
        return true;
      }
      return false;
    };

    const release = () => {
      inFlight -= 1;
      const next = waiters.shift();
      if (next) next();
    };

    if (tryRun()) return;

    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(onReady);
      if (i >= 0) waiters.splice(i, 1);
      clearTimeout(timer);
      reject(new ClaudeError('claude queue aborted', { kind: 'aborted' }));
    };
    const onReady = () => {
      if (settled) return;
      if (signal?.aborted) return onAbort();
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (!tryRun()) waiters.unshift(onReady);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(onReady);
      if (i >= 0) waiters.splice(i, 1);
      signal?.removeEventListener?.('abort', onAbort);
      reject(new ClaudeError('claude queue wait timeout', { kind: 'queue_timeout' }));
    }, config.claude.queueMaxWaitMs);

    signal?.addEventListener?.('abort', onAbort, { once: true });
    waiters.push(onReady);
  });

export const getClaudeStats = () => ({
  inFlight,
  queued: waiters.length,
  maxConcurrency: config.claude.maxConcurrency,
});

const DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'CronGet', 'CronUpdate'];

const buildArgs = ({ sessionId }) => {
  const args = ['--print', '--output-format', 'json'];
  args.push('--disallowed-tools', DISALLOWED_TOOLS.join(','));
  if (sessionId) args.push('--resume', sessionId);
  return args;
};

const spawnClaude = ({ message, sessionId, signal, logger } = {}) => {
  return new Promise((resolve, reject) => {
    const args = buildArgs({ sessionId });
    const startedAt = Date.now();

    let child;
    try {
      child = spawn(config.claude.bin, args, {
        cwd: config.claude.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(new ClaudeError('failed to spawn claude CLI', { kind: 'spawn', cause }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let aborted = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.claude.timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new ClaudeError('claude CLI process error', { kind: 'spawn', cause: err }));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        reject(new ClaudeError('claude CLI timed out', { kind: 'timeout', stderr }));
        return;
      }
      if (aborted) {
        reject(new ClaudeError('claude CLI aborted by client', { kind: 'aborted', stderr }));
        return;
      }
      if (code !== 0) {
        reject(
          new ClaudeError(`claude CLI exited with code ${code}`, {
            kind: 'exit',
            exitCode: code,
            stderr,
          }),
        );
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (cause) {
        reject(
          new ClaudeError('failed to parse claude JSON output', {
            kind: 'parse',
            cause,
            stderr: stdout.slice(0, 500),
          }),
        );
        return;
      }

      if (parsed.is_error) {
        reject(
          new ClaudeError(parsed.result || 'claude returned an error', {
            kind: 'cli_error',
            stderr,
          }),
        );
        return;
      }

      if (logger) {
        logger.debug(
          { duration_api_ms: parsed.duration_api_ms, num_turns: parsed.num_turns },
          'claude run ok',
        );
      }

      resolve({
        response: parsed.result,
        sessionId: parsed.session_id,
        durationMs,
        costUsd: parsed.total_cost_usd,
        usage: parsed.usage
          ? {
              inputTokens: parsed.usage.input_tokens,
              outputTokens: parsed.usage.output_tokens,
              cacheReadInputTokens: parsed.usage.cache_read_input_tokens,
              cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens,
            }
          : undefined,
      });
    });

    if (message) child.stdin.end(message);
    else child.stdin.end();
  });
};

export const runClaude = async (opts = {}) => {
  const release = await acquireSlot(opts.signal);
  try {
    return await spawnClaude(opts);
  } finally {
    release();
  }
};

let cachedHealth = { value: null, expiresAt: 0 };
export const isClaudeHealthy = async () => {
  const now = Date.now();
  if (cachedHealth.value !== null && cachedHealth.expiresAt > now) {
    return cachedHealth.value;
  }
  const ok = await new Promise((resolve) => {
    const child = spawn(config.claude.bin, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 2000);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  cachedHealth = { value: ok, expiresAt: now + 30_000 };
  return ok;
};
