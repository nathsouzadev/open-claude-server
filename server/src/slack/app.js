import bolt from '@slack/bolt';
import { config } from '../config.js';
import { runClaude } from '../services/claudeClient.js';
import { toSlackMrkdwn } from './mrkdwn.js';
import { withThinking } from './thinking.js';

const { App, LogLevel } = bolt;

const THREAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const THREAD_CONTEXT_MAX = 10;

const stripMention = (text = '') => text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

const askClaude = async ({ message, logger }) => {
  try {
    const result = await runClaude({ message, logger });
    const content = result?.response ?? '';
    return typeof content === 'string' && content.trim()
      ? content
      : 'Não obtive resposta do agente.';
  } catch (err) {
    logger?.error({ err }, 'claude call failed for slack event');
    return `:warning: erro: ${err.message ?? 'falha ao chamar claude'}`;
  }
};

const FORMAT_HINT = `Format the response in standard Markdown so it can be converted to Slack mrkdwn afterwards:
- Use **bold** for section titles and emphasis (NOT plain uppercase or trailing colons).
- Use bullet lists with "- " for itemized data.
- Use Markdown tables with pipes for tabular data.
- Use \`backticks\` for code, identifiers, IDs.
- Avoid HTML, raw "*" for bullets, or trailing "—" as separators.`;

const buildPrompt = (agentName, userText, threadContext) => {
  const base = `You handle messages forwarded from Slack. Follow this routing:

1. **Scheduling requests** (cron, recurring report, "todo dia", "agenda", "às 7h", "schedule", "lembrar", periodic dispatch): use the \`persistent-cron\` skill directly. Do NOT delegate to a subagent. After creating the job, return a short confirmation with the job id.

2. **All other requests** (product status, code review, planning, analysis, debugging, etc.): you MUST invoke the "${agentName}" subagent via the Task tool to handle the request. Do not answer those directly. Return only the subagent's response, with no preamble or commentary.

${FORMAT_HINT}`;
  let body = base;
  if (threadContext) body += `\n\nPrior thread context (oldest first):\n${threadContext}`;
  if (userText) body += `\n\nUser message: ${userText}`;
  return body;
};

const respondWithThinking = async ({ client, channel, thread_ts, logger, produceReply }) => {
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

const buildApp = (botCfg, logger) => {
  const childLogger = logger.child({ bot: botCfg.name, agent: botCfg.agent });

  const app = new App({
    token: botCfg.botToken,
    appToken: botCfg.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
    logger: {
      debug: (...a) => childLogger.debug({ slack: a }),
      info: (...a) => childLogger.info({ slack: a }),
      warn: (...a) => childLogger.warn({ slack: a }),
      error: (...a) => childLogger.error({ slack: a }),
      setLevel: () => {},
      getLevel: () => 'info',
      setName: () => {},
    },
  });

  const activeThreads = new Map();
  const botUserIdRef = { id: null };

  const markThreadActive = (channel, threadTs) => {
    activeThreads.set(`${channel}:${threadTs}`, Date.now());
  };

  const pruneThreadCache = () => {
    const cutoff = Date.now() - THREAD_CACHE_TTL_MS;
    for (const [k, t] of activeThreads) if (t < cutoff) activeThreads.delete(k);
  };

  const isThreadActive = async ({ client, channel, threadTs }) => {
    pruneThreadCache();
    const key = `${channel}:${threadTs}`;
    if (activeThreads.has(key)) return true;
    if (!botUserIdRef.id) return false;
    try {
      const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
      const participated = (replies.messages ?? []).some(
        (m) => m.user === botUserIdRef.id || m.bot_id,
      );
      if (participated) {
        markThreadActive(channel, threadTs);
        return true;
      }
    } catch (err) {
      childLogger.warn({ err: err.data?.error ?? err.message }, 'conversations.replies failed');
    }
    return false;
  };

  const fetchThreadContext = async ({ client, channel, threadTs, excludeTs }) => {
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
          const who = m.user === botUserIdRef.id || m.bot_id ? 'assistant' : `user(${m.user ?? '?'})`;
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

    await respondWithThinking({
      client,
      channel: event.channel,
      thread_ts: threadTs,
      logger: childLogger,
      produceReply: async () => {
        const context = event.thread_ts
          ? await fetchThreadContext({ client, channel: event.channel, threadTs, excludeTs: event.ts })
          : null;
        return askClaude({
          message: buildPrompt(botCfg.agent, userText, context),
          logger: childLogger,
        });
      },
    });
  });

  app.message(async ({ message, client, logger: boltLogger }) => {
    if (message.subtype) return;
    if (message.bot_id) return;
    if (message.user && message.user === botUserIdRef.id) return;

    if (message.channel_type === 'im') {
      boltLogger.info({ channel: message.channel, user: message.user }, 'dm received');
      await respondWithThinking({
        client,
        channel: message.channel,
        thread_ts: undefined,
        logger: childLogger,
        produceReply: () =>
          askClaude({
            message: buildPrompt(botCfg.agent, message.text ?? ''),
            logger: childLogger,
          }),
      });
      return;
    }

    if (message.channel_type !== 'channel' && message.channel_type !== 'group') return;
    if (!message.thread_ts) return;

    const mentionsBot = botUserIdRef.id && (message.text ?? '').includes(`<@${botUserIdRef.id}>`);
    if (mentionsBot) return;

    const active = await isThreadActive({
      client,
      channel: message.channel,
      threadTs: message.thread_ts,
    });
    if (!active) return;

    boltLogger.info({ channel: message.channel, thread: message.thread_ts }, 'thread follow-up');

    await respondWithThinking({
      client,
      channel: message.channel,
      thread_ts: message.thread_ts,
      logger: childLogger,
      produceReply: async () => {
        const context = await fetchThreadContext({
          client,
          channel: message.channel,
          threadTs: message.thread_ts,
          excludeTs: message.ts,
        });
        return askClaude({
          message: buildPrompt(botCfg.agent, message.text ?? '', context),
          logger: childLogger,
        });
      },
    });
  });

  app.error(async (err) => {
    childLogger.error({ err }, 'slack bolt error');
  });

  const init = async () => {
    try {
      const auth = await app.client.auth.test();
      botUserIdRef.id = auth.user_id;
      childLogger.info({ botUserId: auth.user_id }, 'bot identity resolved');
    } catch (err) {
      childLogger.error({ err }, 'failed to resolve bot identity');
    }
  };

  return { app, cfg: botCfg, init };
};

export const createSlackApps = (logger) => {
  const bots = config.slack.bots ?? [];
  if (bots.length === 0) {
    throw new Error(
      'Nenhum bot configurado. Defina SLACK_BOTS (JSON) ou SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_AGENT.',
    );
  }
  return bots.map((cfg) => buildApp(cfg, logger));
};
