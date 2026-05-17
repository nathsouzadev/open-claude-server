import client from 'prom-client';
import { getClaudeStats } from './claudeClient.js';

export const registry = new client.Registry();

registry.setDefaultLabels({ service: 'claude-api' });

client.collectDefaultMetrics({ register: registry });

new client.Gauge({
  name: 'process_uptime_seconds',
  help: 'Process uptime in seconds',
  registers: [registry],
  collect() {
    this.set(process.uptime());
  },
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const claudeRunsTotal = new client.Counter({
  name: 'claude_api_claude_runs_total',
  help: 'Number of Claude CLI invocations made via the API',
  labelNames: ['agent', 'source', 'success', 'error'],
  registers: [registry],
});

export const claudeRunDuration = new client.Histogram({
  name: 'claude_api_claude_run_duration_seconds',
  help: 'Duration of Claude CLI invocations made via the API',
  labelNames: ['agent', 'source', 'success'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const claudeTokensTotal = new client.Counter({
  name: 'claude_api_claude_tokens_total',
  help: 'Token usage recorded for Claude runs made via the API',
  labelNames: ['agent', 'source', 'model', 'type'],
  registers: [registry],
});

export const claudeCostTotal = new client.Counter({
  name: 'claude_api_claude_cost_usd_total',
  help: 'Cost in USD recorded for Claude runs made via the API',
  labelNames: ['agent', 'source', 'model'],
  registers: [registry],
});

const claudeQueueInflight = new client.Gauge({
  name: 'claude_api_claude_queue_inflight',
  help: 'Claude runs currently in flight',
  registers: [registry],
  collect() {
    this.set(getClaudeStats().inFlight);
  },
});

const claudeQueueWaiting = new client.Gauge({
  name: 'claude_api_claude_queue_waiting',
  help: 'Claude runs waiting in queue',
  registers: [registry],
  collect() {
    this.set(getClaudeStats().queued);
  },
});

const claudeQueueMax = new client.Gauge({
  name: 'claude_api_claude_queue_max_concurrency',
  help: 'Claude queue maximum concurrency',
  registers: [registry],
  collect() {
    this.set(getClaudeStats().maxConcurrency);
  },
});

export const claudeHealthy = new client.Gauge({
  name: 'claude_api_claude_healthy',
  help: 'Claude CLI health (1 = healthy, 0 = unhealthy)',
  registers: [registry],
});

export interface ClaudeRunMetric {
  agent: string;
  source: string;
  model: string;
  success: boolean;
  errorKind?: string;
  durationSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export const recordClaudeRun = (m: ClaudeRunMetric): void => {
  const success = String(m.success);
  claudeRunsTotal.inc({
    agent: m.agent,
    source: m.source,
    success,
    error: m.errorKind ?? '',
  });
  claudeRunDuration.observe(
    { agent: m.agent, source: m.source, success },
    m.durationSeconds,
  );
  const tokens: Array<[string, number | undefined]> = [
    ['input', m.inputTokens],
    ['output', m.outputTokens],
    ['cache_read', m.cacheReadTokens],
    ['cache_creation', m.cacheCreationTokens],
  ];
  for (const [type, value] of tokens) {
    if (value && value > 0) {
      claudeTokensTotal.inc(
        { agent: m.agent, source: m.source, model: m.model, type },
        value,
      );
    }
  }
  if (m.costUsd && m.costUsd > 0) {
    claudeCostTotal.inc(
      { agent: m.agent, source: m.source, model: m.model },
      m.costUsd,
    );
  }
};

void claudeQueueInflight;
void claudeQueueWaiting;
void claudeQueueMax;
