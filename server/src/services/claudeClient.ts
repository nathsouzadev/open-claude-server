import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type {
  ClaudeErrorKind,
  ClaudeRunResult,
  RunClaudeOptions,
  RunClaudeResult,
} from '../types.js';

const SERVER_PID = process.pid;

const parseStatPpid = (stat: string): number => {
  const idx = stat.lastIndexOf(')');
  if (idx < 0) return NaN;
  const parts = stat.slice(idx + 2).split(' ');
  return parseInt(parts[1], 10);
};

const isOrphanClaudeMemWorker = async (pid: number): Promise<boolean> => {
  if (pid === SERVER_PID) return false;
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const cmd = raw.replace(/\0/g, ' ');
    if (!/claude-mem|worker-service\.cjs/.test(cmd)) return false;
    if (/--daemon/.test(cmd)) return false;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const ppid = parseStatPpid(stat);
    return ppid === 1 || ppid === SERVER_PID;
  } catch {
    return false;
  }
};

const reapOrphanWorkers = async (logger?: Logger): Promise<number> => {
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return 0;
  }
  let killed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = parseInt(entry, 10);
      if (await isOrphanClaudeMemWorker(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          killed += 1;
        } catch {
          /* ignore */
        }
      }
    }),
  );
  if (killed > 0) logger?.info({ killed }, 'reaped orphan claude-mem workers');
  return killed;
};

interface ClaudeErrorOptions {
  kind: ClaudeErrorKind;
  cause?: unknown;
  exitCode?: number | null;
  stderr?: string;
}

export class ClaudeError extends Error {
  public readonly kind: ClaudeErrorKind;
  public readonly exitCode?: number | null;
  public readonly stderr?: string;
  public override cause?: unknown;

  constructor(message: string, opts: ClaudeErrorOptions) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = opts.kind;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.exitCode !== undefined) this.exitCode = opts.exitCode;
    if (opts.stderr !== undefined) this.stderr = opts.stderr;
  }
}

let inFlight = 0;
const waiters: Array<() => void> = [];

type Release = () => void;

const acquireSlot = (signal?: AbortSignal): Promise<Release> =>
  new Promise<Release>((resolve, reject) => {
    const release: Release = () => {
      inFlight -= 1;
      const next = waiters.shift();
      if (next) next();
    };

    const tryRun = (): boolean => {
      if (inFlight < config.claude.maxConcurrency) {
        inFlight += 1;
        resolve(release);
        return true;
      }
      return false;
    };

    if (tryRun()) return;

    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(onReady);
      if (i >= 0) waiters.splice(i, 1);
      clearTimeout(timer);
      reject(new ClaudeError('claude queue aborted', { kind: 'aborted' }));
    };
    const onReady = (): void => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!tryRun()) waiters.unshift(onReady);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(onReady);
      if (i >= 0) waiters.splice(i, 1);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new ClaudeError('claude queue wait timeout', { kind: 'queue_timeout' }),
      );
    }, config.claude.queueMaxWaitMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(onReady);
  });

export const getClaudeStats = (): {
  inFlight: number;
  queued: number;
  maxConcurrency: number;
} => ({
  inFlight,
  queued: waiters.length,
  maxConcurrency: config.claude.maxConcurrency,
});

const DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronGet',
  'CronUpdate',
];

const buildArgs = ({ sessionId }: { sessionId?: string }): string[] => {
  const args = ['--print', '--output-format', 'json'];
  args.push('--permission-mode', 'bypassPermissions');
  args.push('--disallowed-tools', DISALLOWED_TOOLS.join(','));
  if (sessionId) args.push('--resume', sessionId);
  return args;
};

interface ClaudeCliJson {
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

type SpawnClaudeResult = Omit<RunClaudeResult, 'requestId'>;

const spawnClaude = (opts: RunClaudeOptions = {}): Promise<SpawnClaudeResult> => {
  const { message, sessionId, signal, logger, extraEnv } = opts;
  return new Promise<SpawnClaudeResult>((resolve, reject) => {
    const args = buildArgs({ sessionId });
    const startedAt = Date.now();

    reapOrphanWorkers(logger).catch(() => {
      /* ignore */
    });

    let child: ChildProcess;
    try {
      child = spawn(config.claude.bin, args, {
        cwd: config.claude.cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(new ClaudeError('failed to spawn claude CLI', { kind: 'spawn', cause }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.claude.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

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

      let parsed: ClaudeCliJson;
      try {
        parsed = JSON.parse(stdout) as ClaudeCliJson;
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
          new ClaudeError(parsed.result ?? 'claude returned an error', {
            kind: 'cli_error',
            stderr,
          }),
        );
        return;
      }

      logger?.debug(
        { duration_api_ms: parsed.duration_api_ms, num_turns: parsed.num_turns },
        'claude run ok',
      );

      resolve({
        response: parsed.result ?? '',
        sessionId: parsed.session_id,
        durationMs,
        costUsd: parsed.total_cost_usd,
        model: parsed.model ?? 'unknown',
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

    if (message) child.stdin?.end(message);
    else child.stdin?.end();
  });
};

export const runClaude = async (
  opts: RunClaudeOptions = {},
): Promise<RunClaudeResult> => {
  const requestId = opts.meta?.requestId ?? randomUUID();
  const release = await acquireSlot(opts.signal);
  try {
    const result = await spawnClaude(opts);
    return { ...result, requestId };
  } finally {
    release();
  }
};

let cachedHealth: { value: boolean | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

export const isClaudeHealthy = async (): Promise<boolean> => {
  const now = Date.now();
  if (cachedHealth.value !== null && cachedHealth.expiresAt > now) {
    return cachedHealth.value;
  }
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(config.claude.bin, ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
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
