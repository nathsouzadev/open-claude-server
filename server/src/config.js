const num = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
};

export const config = {
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
  },

  paths: {
    userAgents: process.env.USER_AGENTS_DIR ?? '/home/claude/.claude/agents',
    projectsRoot: process.env.PROJECTS_ROOT ?? '/workspace/projects',
  },

  slack: {
    enabled: bool(process.env.SLACK_ENABLED, false),
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
    appToken: process.env.SLACK_APP_TOKEN ?? '',
    agent: process.env.SLACK_AGENT ?? 'hello-agent',
  },
};
