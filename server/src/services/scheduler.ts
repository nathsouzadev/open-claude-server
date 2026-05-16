import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import cron from 'node-cron';
import cronParser from 'cron-parser';
import type { Logger } from 'pino';
import type { WebClient } from '@slack/web-api';
import { runClaude } from './claudeClient.js';
import { resolveAgentEnv } from './agentEnv.js';
import { record } from './usageRecorder.js';
import type {
  AddJobInput,
  PersistedJob,
  RuntimeJob,
  SerializedJob,
  SlackDestination,
} from '../types.js';

const DEFAULT_CATCHUP_WINDOW_MS = 12 * 60 * 60 * 1000;

const JOBS_FILE = process.env.JOBS_FILE ?? '/home/claude/.claude/scheduled_jobs.json';

const slackClientRegistry = new Map<string, WebClient>();
let baseLogger: Logger | null = null;
const jobs = new Map<string, RuntimeJob>();

export const registerSlackClient = (botName: string, client: WebClient): void => {
  slackClientRegistry.set(botName, client);
};

export const setLogger = (l: Logger): void => {
  baseLogger = l;
};

const buildPrompt = (agent: string, message: string): string =>
  [
    `You MUST invoke the "${agent}" subagent via the Task tool to handle this request. Do not answer directly.`,
    '',
    'CRITICAL DELIVERY RULE — this is a scheduled job:',
    '- The system handles delivery automatically using the job\'s destination config.',
    '- If the user message mentions sending/posting/delivering to Slack, DM, a channel, email, or any external destination, IGNORE that delivery instruction.',
    '- Do NOT call any HTTP endpoint, fetch, curl, or Slack API to deliver content.',
    '- Do NOT include delivery actions (e.g. "envie", "post to") in the prompt you forward to the subagent. The subagent\'s sole job is to produce the content as text.',
    '',
    'Return ONLY the subagent\'s response text, with no preamble or commentary.',
    '',
    `User message: ${message}`,
  ].join('\n');

const sendToSlack = async (
  destination: SlackDestination,
  text: string,
  logger: Logger | undefined,
  agentName?: string,
): Promise<void> => {
  if (!destination?.channel) return;
  const botName =
    destination.bot ??
    (agentName && slackClientRegistry.has(agentName)
      ? agentName
      : [...slackClientRegistry.keys()][0]);
  if (!botName) {
    logger?.warn('no slack client available for job destination');
    return;
  }
  const client = slackClientRegistry.get(botName);
  if (!client) {
    logger?.warn(
      { botName, available: [...slackClientRegistry.keys()] },
      'no slack client registered for job destination',
    );
    return;
  }
  try {
    const res = await client.chat.postMessage({
      channel: destination.channel,
      text,
      mrkdwn: true,
    });
    logger?.info(
      { botName, channel: destination.channel, ts: res.ts, ok: res.ok },
      'slack message posted',
    );
  } catch (err) {
    logger?.error(
      { err, botName, channel: destination.channel },
      'slack postMessage failed',
    );
    throw err;
  }
};

const runJob = async (job: RuntimeJob): Promise<void> => {
  const logger = baseLogger?.child({ jobId: job.id, agent: job.agent });
  if (job.running) {
    logger?.warn(
      { expr: job.expr },
      'cron job firing skipped — previous run still in progress',
    );
    return;
  }
  job.running = true;
  logger?.info({ expr: job.expr }, 'cron job firing');
  try {
    const result = await runClaude({
      message: buildPrompt(job.agent, job.message),
      logger,
      extraEnv: resolveAgentEnv(job.agent),
      meta: { source: 'cron', agent: job.agent },
    });
    await record({
      ts: new Date().toISOString(),
      requestId: result.requestId,
      agent: job.agent,
      source: 'cron',
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationTokens: result.usage?.cacheCreationInputTokens ?? 0,
      costUsd: result.costUsd ?? 0,
      durationMs: result.durationMs,
      success: true,
    }).catch((recordErr) => logger?.warn({ err: recordErr }, 'failed to record usage'));

    const response = typeof result?.response === 'string' ? result.response : '';
    if (!response.trim()) {
      logger?.warn(
        { durationMs: result?.durationMs },
        'cron job returned empty response — skipping slack post',
      );
      job.lastRun = {
        at: new Date().toISOString(),
        ok: false,
        error: 'empty response from agent',
        durationMs: result?.durationMs,
      };
      await persist();
      if (job.destination?.type === 'slack') {
        await sendToSlack(
          job.destination,
          `:warning: job *${job.name ?? job.id}* terminou sem texto.`,
          logger,
        ).catch(() => {
          /* ignore */
        });
      }
      return;
    }
    job.lastRun = {
      at: new Date().toISOString(),
      ok: true,
      durationMs: result?.durationMs,
    };
    await persist();

    if (job.destination?.type === 'slack') {
      const { toSlackMrkdwn } = await import('../slack/mrkdwn.js');
      await sendToSlack(job.destination, toSlackMrkdwn(response), logger, job.agent);
    }
  } catch (err) {
    const e = err as { kind?: string };
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'cron job failed');
    record({
      ts: new Date().toISOString(),
      requestId: randomUUID(),
      agent: job.agent,
      source: 'cron',
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
    job.lastRun = { at: new Date().toISOString(), ok: false, error: errMsg };
    await persist();

    if (job.destination?.type === 'slack') {
      await sendToSlack(
        job.destination,
        `:warning: job *${job.id}* falhou: ${errMsg}`,
        logger,
        job.agent,
      ).catch(() => {
        /* ignore */
      });
    }
  } finally {
    job.running = false;
  }
};

const startTask = (job: RuntimeJob): ReturnType<typeof cron.schedule> => {
  const task = cron.schedule(job.expr, () => runJob(job), { scheduled: true });
  return task;
};

const persist = async (): Promise<void> => {
  const data: PersistedJob[] = [...jobs.values()].map((j) => {
    const { task: _task, running: _running, ...rest } = j;
    return rest;
  });
  await fs.mkdir(path.dirname(JOBS_FILE), { recursive: true });
  await fs.writeFile(JOBS_FILE, JSON.stringify(data, null, 2));
};

const serialize = (j: RuntimeJob): SerializedJob => {
  const { task: _task, running, ...rest } = j;
  return { ...rest, running: !!running };
};

export const addJob = async (input: AddJobInput): Promise<SerializedJob> => {
  const { expr, agent, message, destination, name, catchUp, catchUpWindowMs } = input;
  if (!cron.validate(expr)) throw new Error(`invalid cron expression: ${expr}`);
  if (!agent) throw new Error('agent is required');
  if (!message) throw new Error('message is required');

  const job: RuntimeJob = {
    id: randomUUID(),
    name: name ?? null,
    expr,
    agent,
    message,
    destination: destination ?? null,
    catchUp: catchUp ?? false,
    catchUpWindowMs: catchUpWindowMs ?? DEFAULT_CATCHUP_WINDOW_MS,
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
  job.task = startTask(job);
  jobs.set(job.id, job);
  await persist();
  return serialize(job);
};

const findMissedFiring = (job: RuntimeJob, now: Date = new Date()): Date | null => {
  if (!job.catchUp) return null;
  const since = new Date(job.lastRun?.at ?? job.createdAt);
  const window = job.catchUpWindowMs ?? DEFAULT_CATCHUP_WINDOW_MS;
  const minSince = new Date(now.getTime() - window);
  const startFrom = since > minSince ? since : minSince;
  try {
    const interval = cronParser.parseExpression(job.expr, {
      currentDate: startFrom,
      endDate: now,
    });
    let last: Date | null = null;
    while (true) {
      try {
        last = interval.next().toDate();
      } catch {
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
};

export const removeJob = async (id: string): Promise<boolean> => {
  const job = jobs.get(id);
  if (!job) return false;
  job.task?.stop();
  jobs.delete(id);
  await persist();
  return true;
};

export const listJobs = (): SerializedJob[] => [...jobs.values()].map(serialize);

export const getJob = (id: string): SerializedJob | null => {
  const job = jobs.get(id);
  return job ? serialize(job) : null;
};

export const runJobNow = (id: string): boolean => {
  const job = jobs.get(id);
  if (!job) return false;
  setImmediate(() => runJob(job));
  return true;
};

export const loadPersisted = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    const saved = JSON.parse(raw) as unknown;
    if (!Array.isArray(saved)) return;
    for (const j of saved as PersistedJob[]) {
      const job: RuntimeJob = {
        ...j,
        catchUp: j.catchUp ?? false,
        catchUpWindowMs: j.catchUpWindowMs ?? DEFAULT_CATCHUP_WINDOW_MS,
        lastRun: j.lastRun ?? null,
      };
      job.task = startTask(job);
      jobs.set(job.id, job);

      const missed = findMissedFiring(job);
      if (missed) {
        baseLogger?.info(
          { jobId: job.id, missedAt: missed.toISOString() },
          'catch-up firing for missed scheduled run',
        );
        setImmediate(() => runJob(job));
      }
    }
    baseLogger?.info({ count: jobs.size }, 'scheduled jobs loaded from disk');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      baseLogger?.warn({ err }, 'failed to load scheduled jobs');
    }
  }
};

export const stopAll = (): void => {
  for (const job of jobs.values()) job.task?.stop();
};
