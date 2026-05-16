import bolt from '@slack/bolt';
import type { Logger } from 'pino';
import type { App as BoltApp, GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { runClaude } from '../services/claudeClient.js';
import { resolveAgentEnv } from '../services/agentEnv.js';
import { record } from '../services/usageRecorder.js';
import { toSlackMrkdwn } from './mrkdwn.js';
import { withThinking } from './thinking.js';
import type { BotConfig } from '../types.js';

const { App, LogLevel } = bolt;

const THREAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const THREAD_CONTEXT_MAX = 10;

const stripMention = (text = ''): string =>
  text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

const CANCEL_RE = /(^|\s)#cancel(\s|$)/i;
const isCancelCommand = (text = ''): boolean => CANCEL_RE.test(text);

const CANCELLED_REPLY = ':exclamation: requisição cancelada';

interface AskClaudeArgs {
  message: string;
  agentName: string;
  logger?: Logger;
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  slackUserId?: string;
  slackChannelId?: string;
  slackTeamId?: string;
}

const askClaude = async ({
  message,
  agentName,
  logger,
  extraEnv,
  signal,
  slackUserId,
  slackChannelId,
  slackTeamId,
}: AskClaudeArgs): Promise<string> => {
  const slackFields = {
    ...(slackUserId !== undefined && { slackUserId }),
    ...(slackChannelId !== undefined && { slackChannelId }),
    ...(slackTeamId !== undefined && { slackTeamId }),
  };
  try {
    const result = await runClaude({
      message,
      logger,
      extraEnv,
      signal,
      meta: { source: 'slack', agent: agentName },
    });
    await record({
      ts: new Date().toISOString(),
      requestId: result.requestId,
      agent: agentName,
      source: 'slack',
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationTokens: result.usage?.cacheCreationInputTokens ?? 0,
      costUsd: result.costUsd ?? 0,
      durationMs: result.durationMs,
      success: true,
      ...slackFields,
    }).catch((recordErr) => logger?.warn({ err: recordErr }, 'failed to record usage'));
    const content = result?.response ?? '';
    return typeof content === 'string' && content.trim()
      ? content
      : 'Não obtive resposta do agente.';
  } catch (err) {
    const e = err as { kind?: string; message?: string };
    if (e?.kind === 'aborted') {
      record({
        ts: new Date().toISOString(),
        requestId: crypto.randomUUID(),
        agent: agentName,
        source: 'slack',
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
        success: false,
        errorCode: 'aborted',
        ...slackFields,
      }).catch(() => {
        /* ignore */
      });
      return CANCELLED_REPLY;
    }
    record({
      ts: new Date().toISOString(),
      requestId: crypto.randomUUID(),
      agent: agentName,
      source: 'slack',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      success: false,
      errorCode: e.kind ?? 'unknown',
      ...slackFields,
    }).catch(() => {
      /* ignore */
    });
    logger?.error({ err }, 'claude call failed for slack event');
    return `:warning: erro: ${e?.message ?? 'falha ao chamar claude'}`;
  }
};

const buildSlackEnv = (
  botCfg: BotConfig,
  channel: string,
  threadTs?: string,
): NodeJS.ProcessEnv => ({
  SLACK_BOT_TOKEN: botCfg.botToken,
  SLACK_CHANNEL: channel,
  ...resolveAgentEnv(botCfg.agent),
  ...(threadTs ? { SLACK_THREAD_TS: threadTs } : {}),
});

const FORMAT_HINT = `Format the response in standard Markdown so it can be converted to Slack mrkdwn afterwards:
- Use **bold** for section titles and emphasis (NOT plain uppercase or trailing colons).
- Use bullet lists with "- " for itemized data.
- Use Markdown tables with pipes for tabular data.
- Use \`backticks\` for code, identifiers, IDs.
- Avoid HTML, raw "*" for bullets, or trailing "—" as separators.`;

const buildPrompt = (
  agentName: string,
  userText: string,
  threadContext?: string | null,
): string => {
  const base = `You handle messages forwarded from Slack. Follow this routing:

1. **Scheduling requests** (cron, recurring report, "todo dia", "agenda", "às 7h", "schedule", "lembrar", periodic dispatch): use the \`persistent-cron\` skill directly. Do NOT delegate to a subagent. After creating the job, return a short confirmation with the job id.

2. **All other requests** (product status, code review, planning, analysis, debugging, etc.): you MUST invoke the "${agentName}" subagent via the Task tool to handle the request. Do not answer those directly. Return only the subagent's response, with no preamble or commentary.

${FORMAT_HINT}`;
  let body = base;
  if (threadContext) body += `\n\nPrior thread context (oldest first):\n${threadContext}`;
  if (userText) body += `\n\nUser message: ${userText}`;
  return body;
};

interface RespondWithThinkingArgs {
  client: WebClient;
  channel: string;
  thread_ts?: string;
  logger: Logger;
  produceReply: () => Promise<string>;
}

const respondWithThinking = async ({
  client,
  channel,
  thread_ts,
  logger,
  produceReply,
}: RespondWithThinkingArgs): Promise<void> => {
  const r = await withThinking({
    client,
    channel,
    thread_ts,
    logger,
    fn: produceReply,
  });

  const finalText = toSlackMrkdwn(r.text);
  if (r.ts) {
    await client.chat.update({
      channel: r.channel,
      ts: r.ts,
      text: finalText,
      mrkdwn: true,
    });
  } else {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: finalText,
      mrkdwn: true,
    });
  }
};

export interface SlackAppHandle {
  app: BoltApp;
  cfg: BotConfig;
  init: () => Promise<void>;
}

const buildApp = (botCfg: BotConfig, logger: Logger): SlackAppHandle => {
  const childLogger = logger.child({ bot: botCfg.name, agent: botCfg.agent });

  const app = new App({
    token: botCfg.botToken,
    appToken: botCfg.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
    logger: {
      debug: (...a: unknown[]) => childLogger.debug({ slack: a }),
      info: (...a: unknown[]) => childLogger.info({ slack: a }),
      warn: (...a: unknown[]) => childLogger.warn({ slack: a }),
      error: (...a: unknown[]) => childLogger.error({ slack: a }),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  });

  const activeThreads = new Map<string, number>();
  const activeRequests = new Map<string, AbortController>();
  const botUserIdRef: { id: string | null } = { id: null };
  const botBotIdRef: { id: string | null } = { id: null };

  const requestKey = (channel: string, threadTs: string | null): string =>
    threadTs ? `${channel}:${threadTs}` : `${channel}:dm`;

  const registerRequest = (key: string): AbortController => {
    const prev = activeRequests.get(key);
    if (prev) prev.abort();
    const controller = new AbortController();
    activeRequests.set(key, controller);
    return controller;
  };

  const releaseRequest = (key: string, controller: AbortController): void => {
    if (activeRequests.get(key) === controller) activeRequests.delete(key);
  };

  const cancelRequest = (key: string): boolean => {
    const controller = activeRequests.get(key);
    if (!controller) return false;
    controller.abort();
    activeRequests.delete(key);
    return true;
  };

  const markThreadActive = (channel: string, threadTs: string): void => {
    activeThreads.set(`${channel}:${threadTs}`, Date.now());
  };

  const pruneThreadCache = (): void => {
    const cutoff = Date.now() - THREAD_CACHE_TTL_MS;
    for (const [k, t] of activeThreads) if (t < cutoff) activeThreads.delete(k);
  };

  interface ThreadActiveArgs {
    client: WebClient;
    channel: string;
    threadTs: string;
  }

  const isThreadActive = async ({
    client,
    channel,
    threadTs,
  }: ThreadActiveArgs): Promise<boolean> => {
    pruneThreadCache();
    const key = `${channel}:${threadTs}`;
    if (activeThreads.has(key)) return true;
    if (!botUserIdRef.id) return false;
    try {
      const replies = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 50,
      });
      const participated = (replies.messages ?? []).some(
        (m) => m.user === botUserIdRef.id || (m.bot_id && m.bot_id === botBotIdRef.id),
      );
      if (participated) {
        markThreadActive(channel, threadTs);
        return true;
      }
    } catch (err) {
      const e = err as { data?: { error?: string }; message?: string };
      childLogger.warn(
        { err: e?.data?.error ?? e?.message },
        'conversations.replies failed',
      );
    }
    return false;
  };

  interface FetchThreadContextArgs {
    client: WebClient;
    channel: string;
    threadTs: string;
    excludeTs?: string;
  }

  const fetchThreadContext = async ({
    client,
    channel,
    threadTs,
    excludeTs,
  }: FetchThreadContextArgs): Promise<string | null> => {
    try {
      const replies = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: THREAD_CONTEXT_MAX + 5,
      });
      const msgs = (replies.messages ?? [])
        .filter((m) => m.ts !== excludeTs)
        .slice(-THREAD_CONTEXT_MAX);
      return msgs
        .map((m) => {
          const isSelf =
            m.user === botUserIdRef.id || (m.bot_id && m.bot_id === botBotIdRef.id);
          const who = isSelf ? 'assistant' : `user(${m.user ?? '?'})`;
          return `${who}: ${stripMention(m.text ?? '')}`;
        })
        .join('\n');
    } catch {
      return null;
    }
  };

  app.event('app_mention', async ({ event, client, logger: boltLogger }) => {
    const userText = stripMention(event.text);
    const threadTs = event.thread_ts ?? event.ts;
    boltLogger.info({ channel: event.channel, user: event.user }, 'app_mention received');
    markThreadActive(event.channel, threadTs);

    if (isCancelCommand(userText)) {
      const key = requestKey(event.channel, threadTs);
      const cancelled = cancelRequest(key);
      if (!cancelled) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: ':information_source: nenhuma requisição ativa para cancelar',
          mrkdwn: true,
        });
      }
      return;
    }

    const key = requestKey(event.channel, threadTs);
    const controller = registerRequest(key);

    try {
      await respondWithThinking({
        client,
        channel: event.channel,
        thread_ts: threadTs,
        logger: childLogger,
        produceReply: async () => {
          const context = event.thread_ts
            ? await fetchThreadContext({
                client,
                channel: event.channel,
                threadTs,
                excludeTs: event.ts,
              })
            : null;
          return askClaude({
            message: buildPrompt(botCfg.agent, userText, context),
            agentName: botCfg.agent,
            logger: childLogger,
            extraEnv: buildSlackEnv(botCfg, event.channel, threadTs),
            signal: controller.signal,
            slackUserId: event.user,
            slackChannelId: event.channel,
            slackTeamId: event.team,
          });
        },
      });
    } finally {
      releaseRequest(key, controller);
    }
  });

  app.message(async ({ message, client, logger: boltLogger }) => {
    if ((message as { subtype?: string }).subtype) return;
    const m = message as GenericMessageEvent;
    if (m.bot_id) return;
    if (m.user && m.user === botUserIdRef.id) return;

    if (m.channel_type === 'im') {
      boltLogger.info({ channel: m.channel, user: m.user }, 'dm received');

      if (isCancelCommand(m.text ?? '')) {
        const key = requestKey(m.channel, null);
        const cancelled = cancelRequest(key);
        if (!cancelled) {
          await client.chat.postMessage({
            channel: m.channel,
            text: ':information_source: nenhuma requisição ativa para cancelar',
            mrkdwn: true,
          });
        }
        return;
      }

      const key = requestKey(m.channel, null);
      const controller = registerRequest(key);

      try {
        await respondWithThinking({
          client,
          channel: m.channel,
          thread_ts: undefined,
          logger: childLogger,
          produceReply: () =>
            askClaude({
              message: buildPrompt(botCfg.agent, m.text ?? ''),
              agentName: botCfg.agent,
              logger: childLogger,
              extraEnv: buildSlackEnv(botCfg, m.channel, m.ts),
              signal: controller.signal,
              slackUserId: m.user,
              slackChannelId: m.channel,
              slackTeamId: m.team,
            }),
        });
      } finally {
        releaseRequest(key, controller);
      }
      return;
    }

    if (m.channel_type !== 'channel' && m.channel_type !== 'group') return;
    if (!m.thread_ts) return;

    if (/<@[A-Z0-9]+>/.test(m.text ?? '')) return;

    const active = await isThreadActive({
      client,
      channel: m.channel,
      threadTs: m.thread_ts,
    });
    if (!active) return;

    boltLogger.info({ channel: m.channel, thread: m.thread_ts }, 'thread follow-up');

    const key = requestKey(m.channel, m.thread_ts);
    const controller = registerRequest(key);

    try {
      await respondWithThinking({
        client,
        channel: m.channel,
        thread_ts: m.thread_ts,
        logger: childLogger,
        produceReply: async () => {
          const context = await fetchThreadContext({
            client,
            channel: m.channel,
            threadTs: m.thread_ts as string,
            excludeTs: m.ts,
          });
          return askClaude({
            message: buildPrompt(botCfg.agent, m.text ?? '', context),
            agentName: botCfg.agent,
            logger: childLogger,
            extraEnv: buildSlackEnv(botCfg, m.channel, m.thread_ts),
            signal: controller.signal,
            slackUserId: m.user,
            slackChannelId: m.channel,
            slackTeamId: m.team,
          });
        },
      });
    } finally {
      releaseRequest(key, controller);
    }
  });

  app.error(async (err) => {
    childLogger.error({ err }, 'slack bolt error');
  });

  const init = async (): Promise<void> => {
    try {
      const auth = await app.client.auth.test();
      botUserIdRef.id = (auth.user_id as string) ?? null;
      botBotIdRef.id = (auth.bot_id as string) ?? null;
      childLogger.info(
        { botUserId: auth.user_id, botId: auth.bot_id },
        'bot identity resolved',
      );
    } catch (err) {
      childLogger.error({ err }, 'failed to resolve bot identity');
    }
  };

  return { app, cfg: botCfg, init };
};

export const createSlackApps = (logger: Logger): SlackAppHandle[] => {
  const bots = config.slack.bots ?? [];
  if (bots.length === 0) {
    throw new Error(
      'Nenhum bot configurado. Defina SLACK_BOTS (JSON) ou SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_AGENT.',
    );
  }
  return bots.map((cfg) => buildApp(cfg, logger));
};
