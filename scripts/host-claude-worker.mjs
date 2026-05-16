#!/usr/bin/env node
// host-claude-worker.mjs
// HTTP bridge que roda no HOST (fora de container) e expõe POST /spawn
// pra invocar o Claude CLI. Streams stdout/stderr em chunked transfer.
//
// Env:
//   CLAUDE_WORKER_PORT   default 3011
//   CLAUDE_WORKER_BIND   default 0.0.0.0
//   CLAUDE_WORKER_TOKEN  segredo obrigatório (Bearer)
//   CLAUDE_BIN           caminho absoluto pro claude (default: 'claude')
//   CLAUDE_WORKER_CWD    cwd default pros spawns
//   CLAUDE_WORKER_MAX_CONCURRENCY  default 4

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.CLAUDE_WORKER_PORT || 3011);
const BIND = process.env.CLAUDE_WORKER_BIND || '0.0.0.0';
const TOKEN = process.env.CLAUDE_WORKER_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_CWD = process.env.CLAUDE_WORKER_CWD || process.cwd();
const MAX_CONCURRENCY = Number(process.env.CLAUDE_WORKER_MAX_CONCURRENCY || 4);

if (!TOKEN) {
  console.error('[worker] CLAUDE_WORKER_TOKEN é obrigatório'); process.exit(1);
}

let inflight = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function badRequest(res, msg) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 5 * 1024 * 1024) {
        reject(new Error('payload too large (>5MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleSpawn(req, res) {
  if (inflight >= MAX_CONCURRENCY) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'busy', inflight }));
    return;
  }

  let body;
  try { body = await readJson(req); }
  catch (e) { return badRequest(res, e.message); }

  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const stdin = typeof body.stdin === 'string' ? body.stdin : '';
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : DEFAULT_CWD;
  const timeoutMs = Number.isFinite(body.timeoutMs) ? body.timeoutMs : 600_000;
  const env = { ...process.env, ...(body.env && typeof body.env === 'object' ? body.env : {}) };

  const jobId = randomUUID();
  log(`[${jobId}] spawn`, CLAUDE_BIN, args.join(' '));

  inflight++;
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'transfer-encoding': 'chunked',
    'x-job-id': jobId,
  });

  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let killedByTimeout = false;

  const timer = setTimeout(() => {
    killedByTimeout = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000);
  }, timeoutMs);

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  child.stdout.on('data', (d) => send({ t: 'stdout', d: d.toString('utf8') }));
  child.stderr.on('data', (d) => send({ t: 'stderr', d: d.toString('utf8') }));

  if (stdin) {
    child.stdin.end(stdin);
  } else {
    child.stdin.end();
  }

  // Abort: cliente desconectou
  req.on('close', () => {
    if (!child.killed && child.exitCode === null) {
      log(`[${jobId}] client closed — killing child`);
      try { child.kill('SIGTERM'); } catch {}
    }
  });

  child.on('error', (err) => {
    send({ t: 'error', d: String(err && err.message || err) });
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    inflight = Math.max(0, inflight - 1);
    send({ t: 'exit', code, signal, killedByTimeout });
    res.end();
    log(`[${jobId}] exit code=${code} signal=${signal} timeout=${killedByTimeout}`);
  });
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const ok = auth === `Bearer ${TOKEN}`;

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, inflight, max: MAX_CONCURRENCY }));
    return;
  }

  if (!ok) return unauthorized(res);

  if (req.url === '/spawn' && req.method === 'POST') {
    return handleSpawn(req, res);
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, BIND, () => {
  log(`worker listening on ${BIND}:${PORT} bin=${CLAUDE_BIN} cwd=${DEFAULT_CWD}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
