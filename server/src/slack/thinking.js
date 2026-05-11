const FRAMES = [
  ':hourglass_flowing_sand: Pensando.',
  ':hourglass_flowing_sand: Pensando..',
  ':hourglass_flowing_sand: Pensando...',
  ':hourglass: Pensando...',
];
const FRAME_INTERVAL_MS = 1200;

export const withThinking = async ({
  client,
  channel,
  thread_ts,
  prefix,
  fn,
  logger,
}) => {
  let placeholder;
  try {
    placeholder = await client.chat.postMessage({
      channel,
      thread_ts,
      text: `${prefix ? `${prefix} ` : ''}${FRAMES[0]}`,
      mrkdwn: true,
    });
  } catch (err) {
    logger?.warn({ err: err.data?.error ?? err.message }, 'placeholder post failed; running without thinking indicator');
    const reply = await fn();
    return { ts: null, channel, text: reply };
  }

  let i = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    i = (i + 1) % FRAMES.length;
    try {
      await client.chat.update({
        channel: placeholder.channel,
        ts: placeholder.ts,
        text: `${prefix ? `${prefix} ` : ''}${FRAMES[i]}`,
        mrkdwn: true,
      });
    } catch (err) {
      logger?.debug({ err: err.data?.error ?? err.message }, 'thinking frame update failed');
    }
  };
  const handle = setInterval(tick, FRAME_INTERVAL_MS);
  handle.unref?.();

  try {
    const reply = await fn();
    stopped = true;
    clearInterval(handle);
    return { ts: placeholder.ts, channel: placeholder.channel, text: reply };
  } catch (err) {
    stopped = true;
    clearInterval(handle);
    throw err;
  }
};
