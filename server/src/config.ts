import type { AppConfig, BotConfig } from './types.js';

const num = (v: string | undefined, fallback: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
};

interface RawBot {
  name?: string;
  agent?: string;
  botToken?: string;
  appToken?: string;
  bot_token?: string;
  app_token?: string;
}

const normalizeBot = (cfg: RawBot | null | undefined): BotConfig | null => {
  if (!cfg) return null;
  const botToken = cfg.botToken ?? cfg.bot_token ?? '';
  const appToken = cfg.appToken ?? cfg.app_token ?? '';
  if (!botToken || !appToken) return null;
  return {
    name: cfg.name ?? 'bot',
    botToken,
    appToken,
    agent: cfg.agent ?? 'hello-agent',
  };
};

const parseSlackBots = (): BotConfig[] => {
  const raw = process.env.SLACK_BOTS;
  if (raw && raw.trim()) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) throw new Error('SLACK_BOTS must be a JSON array');
      return (arr as RawBot[])
        .map(normalizeBot)
        .filter((b): b is BotConfig => b !== null);
    } catch (err) {
      throw new Error(`invalid SLACK_BOTS JSON: ${(err as Error).message}`);
    }
  }

  const single = normalizeBot({
    name: process.env.SLACK_BOT_NAME ?? 'default',
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    agent: process.env.SLACK_AGENT ?? 'hello-agent',
  });
  return single ? [single] : [];
};

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  host: process.env.HOST ?? '0.0.0.0',
  port: num(process.env.PORT, 3010),

  auth: {
    enabled: bool(process.env.AUTH_ENABLED, false),
    token: process.env.API_TOKEN ?? '',
  },

  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, false),
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: num(process.env.RATE_LIMIT_MAX, 30),
  },

  cors: {
    origin: (process.env.CORS_ORIGIN ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  claude: {
    bin: process.env.CLAUDE_BIN ?? 'claude',
    cwd: process.env.CLAUDE_CWD ?? '/workspace/server',
    timeoutMs: num(process.env.CLAUDE_TIMEOUT_MS, 120_000),
    maxInputChars: num(process.env.CLAUDE_MAX_INPUT_CHARS, 50_000),
    maxConcurrency: num(process.env.CLAUDE_MAX_CONCURRENCY, 3),
    queueMaxWaitMs: num(process.env.CLAUDE_QUEUE_MAX_WAIT_MS, 30_000),
  },

  paths: {
    userAgents: process.env.USER_AGENTS_DIR ?? '/home/claude/.claude/agents',
    projectsRoot: process.env.PROJECTS_ROOT ?? '/workspace/projects',
  },

  slack: {
    enabled: bool(process.env.SLACK_ENABLED, false),
    bots: parseSlackBots(),
  },
};
