import type { Logger } from 'pino';

export type AgentScope = 'user' | `project:${string}`;

export interface BotConfig {
  name: string;
  botToken: string;
  appToken: string;
  agent: string;
}

export interface AppConfig {
  env: string;
  logLevel: string;
  host: string;
  port: number;
  auth: {
    enabled: boolean;
    token: string;
  };
  rateLimit: {
    enabled: boolean;
    windowMs: number;
    max: number;
  };
  cors: {
    origin: string[];
  };
  claude: {
    bin: string;
    cwd: string;
    timeoutMs: number;
    maxInputChars: number;
    maxConcurrency: number;
    queueMaxWaitMs: number;
  };
  paths: {
    userAgents: string;
    projectsRoot: string;
  };
  slack: {
    enabled: boolean;
    bots: BotConfig[];
  };
}

export type ClaudeErrorKind =
  | 'timeout'
  | 'aborted'
  | 'spawn'
  | 'exit'
  | 'parse'
  | 'cli_error'
  | 'queue_timeout';

export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ClaudeRunResult {
  response: string;
  sessionId?: string;
  durationMs: number;
  costUsd?: number;
  usage?: ClaudeUsage;
}

export interface RunClaudeOptions {
  message?: string;
  sessionId?: string;
  signal?: AbortSignal;
  logger?: Logger;
  extraEnv?: NodeJS.ProcessEnv;
  meta?: UsageMeta;
}

export type UsageSource = 'slack' | 'cron' | 'http' | 'chat';

export interface UsageMeta {
  source: UsageSource;
  agent: string;
  requestId?: string;
  slackUserId?: string;
  slackChannelId?: string;
  slackTeamId?: string;
}

export interface UsageEntry {
  ts: string;
  requestId: string;
  agent: string;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  slackUserId?: string;
  slackChannelId?: string;
  slackTeamId?: string;
}

export interface RunClaudeResult extends ClaudeRunResult {
  requestId: string;
  model: string;
}

export interface SlackDestination {
  type: 'slack';
  channel: string;
  bot?: string;
}

export interface JobLastRun {
  at: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
}

export interface PersistedJob {
  id: string;
  name: string | null;
  expr: string;
  agent: string;
  message: string;
  destination: SlackDestination | null;
  catchUp: boolean;
  catchUpWindowMs: number;
  createdAt: string;
  lastRun: JobLastRun | null;
}

export interface RuntimeJob extends PersistedJob {
  task?: ReturnType<typeof import('node-cron').schedule>;
  running?: boolean;
}

export interface SerializedJob extends PersistedJob {
  running: boolean;
}

export interface AddJobInput {
  expr: string;
  agent: string;
  message: string;
  name?: string;
  destination?: SlackDestination | null;
  catchUp?: boolean;
  catchUpWindowMs?: number;
}

export interface AgentRecord {
  scope: string;
  name: string;
  raw: string;
  frontmatter: Record<string, string>;
  body: string;
}

export interface AgentSummary {
  scope: string;
  name: string;
}

export interface ProjectSummary {
  slug: string;
  path: string;
  hasAgentsDir: boolean;
}
