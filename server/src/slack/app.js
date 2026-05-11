import bolt from '@slack/bolt';
import { config } from '../config.js';
import { runClaude } from '../services/claudeClient.js';

const { App, LogLevel } = bolt;

const stripMention = (text = '') => text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

const askClaude = async ({ message, sessionId, logger }) => {
  try {
    const result = await runClaude({ message, sessionId, logger });
    const content = result?.response ?? '';
    return typeof content === 'string' && content.trim()
      ? content
      : 'Não obtive resposta do agente.';
  } catch (err) {
    logger?.error({ err }, 'claude call failed for slack event');
    return `:warning: erro: ${err.message ?? 'falha ao chamar claude'}`;
  }
};

const buildPrompt = (agentName, userText) => {
  const base = `You MUST invoke the "${agentName}" subagent via the Task tool to handle this request. Do not answer directly. Return only the subagent's response, with no preamble or commentary.`;
  return userText ? `${base}\n\nUser message: ${userText}` : base;
};

export const createSlackApp = (logger) => {
  if (!config.slack.botToken || !config.slack.appToken) {
    throw new Error('SLACK_BOT_TOKEN e SLACK_APP_TOKEN são obrigatórios quando SLACK_ENABLED=true');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
    logger: {
      debug: (...a) => logger.debug({ slack: a }),
      info: (...a) => logger.info({ slack: a }),
      warn: (...a) => logger.warn({ slack: a }),
      error: (...a) => logger.error({ slack: a }),
      setLevel: () => {},
      getLevel: () => 'info',
      setName: () => {},
    },
  });

  app.event('app_mention', async ({ event, client, logger: boltLogger }) => {
    const userText = stripMention(event.text);
    boltLogger.info({ channel: event.channel, user: event.user }, 'app_mention received');

    const reply = await askClaude({
      message: buildPrompt(config.slack.agent, userText),
      logger,
    });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: reply,
    });
  });

  app.message(async ({ message, client, logger: boltLogger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype) return;
    if (message.bot_id) return;

    boltLogger.info({ channel: message.channel, user: message.user }, 'dm received');

    const reply = await askClaude({
      message: buildPrompt(config.slack.agent, message.text ?? ''),
      logger,
    });

    await client.chat.postMessage({
      channel: message.channel,
      text: reply,
    });
  });

  app.error(async (err) => {
    logger.error({ err }, 'slack bolt error');
  });

  return app;
};
