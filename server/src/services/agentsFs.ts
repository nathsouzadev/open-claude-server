import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { config } from '../config.js';
import type { AgentRecord, AgentSummary, ProjectSummary } from '../types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class AgentFsError extends Error {
  public readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentFsError';
    this.status = status;
  }
}

const dirForScope = (scope: string): string => {
  if (scope === 'user') return resolve(config.paths.userAgents);

  const m = /^project:(.+)$/.exec(scope);
  if (!m) throw new AgentFsError(`invalid scope: ${scope}`);
  const slug = m[1];
  if (!PROJECT_SLUG_RE.test(slug)) throw new AgentFsError(`invalid project slug: ${slug}`);
  return resolve(join(config.paths.projectsRoot, slug, '.claude', 'agents'));
};

const fileForAgent = (scope: string, name: string): { dir: string; file: string } => {
  if (!NAME_RE.test(name)) throw new AgentFsError(`invalid agent name: ${name}`);
  const dir = dirForScope(scope);
  const file = resolve(join(dir, `${name}.md`));
  if (!file.startsWith(dir + sep) && file !== join(dir, `${name}.md`)) {
    throw new AgentFsError('path traversal blocked', 400);
  }
  return { dir, file };
};

const parseFrontmatter = (
  raw: string,
): { frontmatter: Record<string, string>; body: string } => {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] };
};

const safeReaddir = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
};

const isDir = async (p: string): Promise<boolean> => {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
};

export const listAllAgents = async (): Promise<AgentSummary[]> => {
  const items: AgentSummary[] = [];

  const userDir = resolve(config.paths.userAgents);
  for (const f of await safeReaddir(userDir)) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    if (!NAME_RE.test(name)) continue;
    items.push({ scope: 'user', name });
  }

  const projectsRoot = resolve(config.paths.projectsRoot);
  for (const entry of await safeReaddir(projectsRoot)) {
    if (!PROJECT_SLUG_RE.test(entry)) continue;
    const agentsDir = join(projectsRoot, entry, '.claude', 'agents');
    if (!(await isDir(agentsDir))) continue;
    for (const f of await safeReaddir(agentsDir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      if (!NAME_RE.test(name)) continue;
      items.push({ scope: `project:${entry}`, name });
    }
  }

  return items;
};

export const readAgent = async (scope: string, name: string): Promise<AgentRecord> => {
  const { file } = fileForAgent(scope, name);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentFsError('agent not found', 404);
    }
    throw err;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return { scope, name, raw, frontmatter, body };
};

export const writeAgent = async (
  scope: string,
  name: string,
  raw: string,
): Promise<AgentRecord> => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AgentFsError('content must be a non-empty string');
  }
  if (raw.length > 200_000) throw new AgentFsError('content too large');
  const { dir, file } = fileForAgent(scope, name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, raw, 'utf8');
  return readAgent(scope, name);
};

export const deleteAgent = async (scope: string, name: string): Promise<void> => {
  const { file } = fileForAgent(scope, name);
  try {
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentFsError('agent not found', 404);
    }
    throw err;
  }
};

export const listProjects = async (): Promise<ProjectSummary[]> => {
  const root = resolve(config.paths.projectsRoot);
  const entries = await safeReaddir(root);
  const out: ProjectSummary[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (!PROJECT_SLUG_RE.test(entry)) continue;
    const full = join(root, entry);
    if (!(await isDir(full))) continue;
    const hasAgentsDir = await isDir(join(full, '.claude', 'agents'));
    out.push({ slug: entry, path: full, hasAgentsDir });
  }
  return out;
};
