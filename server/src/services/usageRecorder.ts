import fs from 'node:fs/promises';
import path from 'node:path';
import type { UsageEntry } from '../types.js';

// Resolves to <cwd>/data/usage/YYYY-MM.jsonl
// In the Docker container, cwd is the project root where the data/ volume is mounted.
const usageDir = (): string => path.join(process.cwd(), 'data', 'usage');

const filePath = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return path.join(usageDir(), `${year}-${month}.jsonl`);
};

export const record = async (entry: UsageEntry): Promise<void> => {
  const file = filePath(new Date(entry.ts));
  await fs.mkdir(usageDir(), { recursive: true });
  // fs.appendFile is atomic for single-line writes on POSIX — no mutex needed
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
};
