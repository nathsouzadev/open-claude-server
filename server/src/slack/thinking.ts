import type { Logger } from 'pino';
import type { WebClient } from '@slack/web-api';

const FRAMES = [
  ':hourglass_flowing_sand: Pensando.',
  ':hourglass_flowing_sand: Pensando..',
  ':hourglass_flowing_sand: Pensando...',
  ':hourglass: Pensando...',
];
const FRAME_INTERVAL_MS = 1200;

export interface ThinkingResult {
  ts: string | null;
  channel: string;
  text: string;
}

interface WithThinkingArgs {
  client: WebClient;
  channel: string;
  thread_ts?: string;
  prefix?: string;
  fn: () => Promise<string>;
  logger?: Logger;
}

interface SlackErrorLike {
  data?: { error?: string };
  message?: string;
}

const errMsg = (e: unknown): string =>
  (e as SlackErrorLike)?.data?.error ?? (e as SlackErrorLike)?.message ?? String(e);

export const withThinking = async ({
  client,
  channel,
  thread_ts,
  prefix,
  fn,
  logger,
}: WithThinkingArgs): Promise<ThinkingResult> => {
  let placeholder: Awaited<ReturnType<WebClient['chat']['postMessage']>>;
  try {
    placeholder = await client.chat.postMessage({
      channel,
      thread_ts,
      text: `${prefix ? `${prefix} ` : ''}${FRAMES[0]}`,
      mrkdwn: true,
    });
  } catch (err) {
    logger?.warn(
      { err: errMsg(err) },
      'placeholder post failed; running without thinking indicator',
    );
    const reply = await fn();
    return { ts: null, channel, text: reply };
  }

  let i = 0;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    i = (i + 1) % FRAMES.length;
    try {
      await client.chat.update({
        channel: placeholder.channel ?? channel,
        ts: placeholder.ts ?? '',
        text: `${prefix ? `${prefix} ` : ''}${FRAMES[i]}`,
        mrkdwn: true,
      });
    } catch (err) {
      logger?.debug({ err: errMsg(err) }, 'thinking frame update failed');
    }
  };
  const handle = setInterval(tick, FRAME_INTERVAL_MS);
  handle.unref?.();

  try {
    const reply = await fn();
    stopped = true;
    clearInterval(handle);
    return {
      ts: placeholder.ts ?? null,
      channel: placeholder.channel ?? channel,
      text: reply,
    };
  } catch (err) {
    stopped = true;
    clearInterval(handle);
    throw err;
  }
};
