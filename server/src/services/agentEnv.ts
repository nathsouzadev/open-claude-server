// Resolves per-agent environment overrides (e.g., GitHub tokens) from
// process.env using the convention:
//   GH_TOKEN_<AGENT_SLUG>=ghp_xxx       → overrides GH_TOKEN + GITHUB_TOKEN
//   GITHUB_TOKEN_<AGENT_SLUG>=ghp_xxx   → alias for the same

const slug = (name: string | undefined | null): string =>
  String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const resolveAgentEnv = (agentName: string): NodeJS.ProcessEnv => {
  const key = slug(agentName);
  if (!key) return {};
  const token =
    process.env[`GH_TOKEN_${key}`] || process.env[`GITHUB_TOKEN_${key}`];
  if (!token) return {};
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
};
