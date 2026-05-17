#!/usr/bin/env node
// claude-bridge.mjs
// Substituto do binário `claude` DENTRO do container: encaminha argv/stdin
// via HTTP pro worker no host, e replica stdout/stderr/exit code localmente.
//
// Configure no container:
//   CLAUDE_BIN=/workspace/server/scripts/claude-bridge.mjs
//   CLAUDE_WORKER_URL=http://host.docker.internal:3011
//   CLAUDE_WORKER_TOKEN=<mesmo segredo do host>

import { stdin, stdout, stderr, argv, env, exit, cwd } from 'node:process';

const URL_BASE = env.CLAUDE_WORKER_URL || 'http://host.docker.internal:3011';
const TOKEN = env.CLAUDE_WORKER_TOKEN;
const TIMEOUT_MS = Number(env.CLAUDE_TIMEOUT_MS || 600_000);

if (!TOKEN) {
  stderr.write('[claude-bridge] CLAUDE_WORKER_TOKEN ausente\n');
  exit(2);
}

async function readStdin() {
  if (stdin.isTTY) return '';
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Forward a small allowlist of env vars from the bridge's own process env to
// the host claude. The server already resolves per-agent overrides (e.g.
// GH_TOKEN_DOROTHY -> GH_TOKEN) before spawning the bridge, so by the time we
// run here, GH_TOKEN already holds the right value for this specific agent.
// Without forwarding, the host worker would re-use its own (global) env and
// the per-agent override would be lost.
const ENV_PASSTHROUGH = ['GH_TOKEN', 'GITHUB_TOKEN'];

const buildForwardEnv = () => {
  const out = {};
  for (const k of ENV_PASSTHROUGH) {
    if (env[k]) out[k] = env[k];
  }
  return out;
};

(async () => {
  const args = argv.slice(2);
  const body = JSON.stringify({
    args,
    stdin: await readStdin(),
    cwd: cwd(),
    timeoutMs: TIMEOUT_MS,
    env: buildForwardEnv(),
  });

  let resp;
  try {
    resp = await fetch(`${URL_BASE}/spawn`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body,
    });
  } catch (e) {
    stderr.write(`[claude-bridge] erro de rede: ${e.message}\n`);
    exit(3);
  }

  if (!resp.ok || !resp.body) {
    stderr.write(`[claude-bridge] HTTP ${resp.status}\n`);
    const txt = await resp.text().catch(() => '');
    if (txt) stderr.write(txt + '\n');
    exit(4);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buf = '';
  let exitCode = 0;
  let exited = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.t === 'stdout') stdout.write(evt.d);
        else if (evt.t === 'stderr') stderr.write(evt.d);
        else if (evt.t === 'error') stderr.write(`[worker error] ${evt.d}\n`);
        else if (evt.t === 'exit') {
          exited = true;
          if (evt.killedByTimeout) {
            stderr.write('[claude-bridge] killed by worker timeout\n');
            exitCode = 124;
          } else if (typeof evt.code === 'number') {
            exitCode = evt.code;
          } else {
            exitCode = 1;
          }
        }
      } catch {
        stderr.write(line + '\n');
      }
    }
  }

  exit(exited ? exitCode : 1);
})();
