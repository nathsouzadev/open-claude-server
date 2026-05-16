import fs from 'node:fs/promises';
import path from 'node:path';
import type { UsageEntry, UsageSource } from '../types.js';

const usageDir = (): string => path.join(process.cwd(), 'data', 'usage');

// Returns every YYYY-MM.jsonl filename that falls within [from, to] (month granularity).
const monthFilesInRange = (from: Date, to: Date): string[] => {
  const files: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    files.push(path.join(usageDir(), `${year}-${month}.jsonl`));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return files;
};

const readEntries = async (filePath: string): Promise<UsageEntry[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as UsageEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
};

export interface UsageAggregate {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  successCount: number;
  errorCount: number;
}

const emptyAggregate = (): UsageAggregate => ({
  requestCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  successCount: 0,
  errorCount: 0,
});

const accumulate = (agg: UsageAggregate, entry: UsageEntry): void => {
  agg.requestCount += 1;
  agg.inputTokens += entry.inputTokens;
  agg.outputTokens += entry.outputTokens;
  agg.cacheReadTokens += entry.cacheReadTokens;
  agg.cacheCreationTokens += entry.cacheCreationTokens;
  agg.costUsd += entry.costUsd;
  agg.durationMs += entry.durationMs;
  if (entry.success) agg.successCount += 1;
  else agg.errorCount += 1;
};

export type GroupBy = 'agent' | 'source' | 'slackUserId' | 'slackChannelId' | 'none';

export interface UsageQueryParams {
  agent?: string;
  source?: UsageSource;
  from?: Date;
  to?: Date;
  groupBy?: GroupBy;
  slackUserId?: string;
  slackChannelId?: string;
}

export interface UsageQueryResult {
  totals: UsageAggregate;
  byAgent?: Record<string, UsageAggregate>;
  bySource?: Record<string, UsageAggregate>;
  bySlackUserId?: Record<string, UsageAggregate>;
  bySlackChannelId?: Record<string, UsageAggregate>;
}

export const query = async (params: UsageQueryParams = {}): Promise<UsageQueryResult> => {
  const now = new Date();
  const from = params.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = params.to ?? now;
  const groupBy = params.groupBy ?? 'none';

  const files = monthFilesInRange(from, to);
  const allEntries = (await Promise.all(files.map(readEntries))).flat();

  // Filter by time window and optional dimensions
  const filtered = allEntries.filter((e) => {
    const ts = new Date(e.ts);
    if (ts < from || ts > to) return false;
    if (params.agent && e.agent !== params.agent) return false;
    if (params.source && e.source !== params.source) return false;
    if (params.slackUserId && e.slackUserId !== params.slackUserId) return false;
    if (params.slackChannelId && e.slackChannelId !== params.slackChannelId) return false;
    return true;
  });

  const totals = emptyAggregate();
  const byAgent: Record<string, UsageAggregate> = {};
  const bySource: Record<string, UsageAggregate> = {};
  const bySlackUserId: Record<string, UsageAggregate> = {};
  const bySlackChannelId: Record<string, UsageAggregate> = {};

  for (const entry of filtered) {
    accumulate(totals, entry);
    if (groupBy === 'agent' || groupBy === 'none') {
      if (!byAgent[entry.agent]) byAgent[entry.agent] = emptyAggregate();
      accumulate(byAgent[entry.agent]!, entry);
    }
    if (groupBy === 'source' || groupBy === 'none') {
      if (!bySource[entry.source]) bySource[entry.source] = emptyAggregate();
      accumulate(bySource[entry.source]!, entry);
    }
    if (groupBy === 'slackUserId' && entry.slackUserId) {
      if (!bySlackUserId[entry.slackUserId]) bySlackUserId[entry.slackUserId] = emptyAggregate();
      accumulate(bySlackUserId[entry.slackUserId]!, entry);
    }
    if (groupBy === 'slackChannelId' && entry.slackChannelId) {
      if (!bySlackChannelId[entry.slackChannelId])
        bySlackChannelId[entry.slackChannelId] = emptyAggregate();
      accumulate(bySlackChannelId[entry.slackChannelId]!, entry);
    }
  }

  const result: UsageQueryResult = { totals };
  if (groupBy === 'agent' || groupBy === 'none') result.byAgent = byAgent;
  if (groupBy === 'source' || groupBy === 'none') result.bySource = bySource;
  if (groupBy === 'slackUserId') result.bySlackUserId = bySlackUserId;
  if (groupBy === 'slackChannelId') result.bySlackChannelId = bySlackChannelId;
  return result;
};
