const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

const state = {
  agents: [],
  projects: [],
  jobs: [],
  current: null,
};

const TEMPLATE = (name) => `---
name: ${name}
description: descreva quando esse agente deve ser usado
tools: Read
---

Você é um agente útil. Descreva aqui o comportamento.
`;

const api = async (method, url, body) => {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(`http ${r.status}`), { status: r.status, data });
  return data;
};

const refreshHealth = async () => {
  const badge = $('#health');
  try {
    const h = await api('GET', '/health');
    badge.textContent = h.status === 'ok' ? 'ok' : 'degraded';
    badge.className = 'badge ' + (h.status === 'ok' ? 'ok' : 'bad');
  } catch {
    badge.textContent = 'down';
    badge.className = 'badge bad';
  }
};

const refreshAgents = async () => {
  const { items } = await api('GET', '/api/agents');
  state.agents = items;
  renderAgents();
};

const refreshProjects = async () => {
  const { items } = await api('GET', '/api/projects');
  state.projects = items;
  renderProjects();
  renderNewDialogOptions();
};

const refreshJobs = async () => {
  try {
    const { jobs } = await api('GET', '/api/jobs');
    state.jobs = jobs ?? [];
  } catch {
    state.jobs = [];
  }
  renderJobs();
};

const renderAgents = () => {
  const list = $('#agents-list');
  list.innerHTML = '';

  const grouped = new Map();
  for (const a of state.agents) {
    const key = a.scope === 'user' ? 'user' : a.scope;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(a);
  }

  const groupOrder = ['user', ...[...grouped.keys()].filter((k) => k !== 'user').sort()];

  for (const key of groupOrder) {
    const agents = grouped.get(key);
    if (!agents) continue;
    list.appendChild(el('li', { class: 'group' }, key === 'user' ? 'user' : key.replace('project:', '')));
    for (const a of agents.sort((x, y) => x.name.localeCompare(y.name))) {
      const isActive = state.current && state.current.scope === a.scope && state.current.name === a.name;
      const li = el(
        'li',
        {
          class: isActive ? 'active' : '',
          onclick: () => openAgent(a.scope, a.name),
        },
        a.name,
      );
      list.appendChild(li);
    }
  }

  if (state.agents.length === 0) {
    list.appendChild(el('li', { class: 'group' }, '(vazio)'));
  }
};

const renderProjects = () => {
  const list = $('#projects-list');
  list.innerHTML = '';
  if (state.projects.length === 0) {
    list.appendChild(el('li', { class: 'group' }, '(nenhum projeto)'));
    return;
  }
  for (const p of state.projects) {
    list.appendChild(el('li', {}, p.slug));
  }
};

const renderJobs = () => {
  const list = $('#jobs-list');
  list.innerHTML = '';
  if (state.jobs.length === 0) {
    list.appendChild(el('li', { class: 'group' }, '(nenhum job)'));
    return;
  }
  for (const j of [...state.jobs].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))) {
    const label = j.name || `${j.agent} · ${j.expr}`;
    const status = j.lastRun ? (j.lastRun.ok ? 'ok' : 'bad') : '';
    const li = el(
      'li',
      { onclick: () => openJob(j.id) },
      label,
      el('span', { class: 'spacer' }),
      status ? el('span', { class: 'badge ' + status }, status) : null,
    );
    list.appendChild(li);
  }
};

const openJob = (id) => {
  const j = state.jobs.find((x) => x.id === id);
  if (!j) return;
  const body =
    `id:          ${j.id}\n` +
    `nome:        ${j.name ?? '—'}\n` +
    `cron:        ${j.expr}\n` +
    `agente:      ${j.agent}\n` +
    `destino:     ${j.destination ? `${j.destination.type}:${j.destination.channel}` : '—'}\n` +
    `catch-up:    ${j.catchUp ? `sim (janela ${Math.round((j.catchUpWindowMs ?? 0) / 3600000)}h)` : 'não'}\n` +
    `criado em:   ${j.createdAt}\n` +
    `última exec: ${j.lastRun ? `${j.lastRun.at} (${j.lastRun.ok ? 'ok' : 'erro'})${j.lastRun.error ? ` — ${j.lastRun.error}` : ''}` : '—'}\n\n` +
    `mensagem:\n${j.message}`;
  $('#job-dialog-title').textContent = j.name || j.agent;
  $('#job-dialog-body').textContent = body;
  $('#job-delete-btn').dataset.jobId = j.id;
  $('#job-dialog').showModal();
};

const deleteJob = async (id) => {
  if (!confirm(`deletar job ${id}?`)) return;
  try {
    await api('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
    $('#job-dialog').close();
    await refreshJobs();
  } catch (err) {
    alert(`falha ao deletar: ${err.message}`);
  }
};

const renderNewJobAgents = () => {
  const sel = $('#new-job-agent');
  sel.innerHTML = '';
  for (const a of [...state.agents].sort((x, y) => x.name.localeCompare(y.name))) {
    sel.appendChild(el('option', { value: a.name }, `${a.name} (${a.scope})`));
  }
};

const renderNewDialogOptions = () => {
  const sel = $('#new-scope');
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: 'user' }, 'user (global)'));
  for (const p of state.projects) {
    sel.appendChild(el('option', { value: `project:${p.slug}` }, `project: ${p.slug}`));
  }
};

const openAgent = async (scope, name) => {
  try {
    const a = await api('GET', `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`);
    state.current = { scope, name };
    $('#empty').hidden = true;
    $('#editor').hidden = false;
    $('#editor-title').textContent = name;
    $('#editor-scope').textContent = scope;
    $('#editor-textarea').value = a.raw;
    $('#run-output').hidden = true;
    $('#run-output-pre').textContent = '';
    renderAgents();
  } catch (err) {
    alert(`falha ao abrir: ${err.message}`);
  }
};

const save = async () => {
  if (!state.current) return;
  const { scope, name } = state.current;
  const content = $('#editor-textarea').value;
  try {
    await api('PUT', `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`, { content });
    await refreshAgents();
    flash('salvo');
  } catch (err) {
    alert(`falha ao salvar: ${err.message}\n${JSON.stringify(err.data ?? {}, null, 2)}`);
  }
};

const remove = async () => {
  if (!state.current) return;
  const { scope, name } = state.current;
  if (!confirm(`deletar ${name} (${scope})?`)) return;
  try {
    await api('DELETE', `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`);
    state.current = null;
    $('#editor').hidden = true;
    $('#empty').hidden = false;
    await refreshAgents();
  } catch (err) {
    alert(`falha ao deletar: ${err.message}`);
  }
};

const run = async () => {
  if (!state.current) return;
  const { scope, name } = state.current;
  const btn = $('#run-btn');
  const out = $('#run-output');
  const pre = $('#run-output-pre');
  btn.disabled = true;
  btn.textContent = 'rodando…';
  out.hidden = false;
  out.open = true;
  pre.textContent = '⏳ aguardando claude…';
  try {
    const r = await api('POST', `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/run`, {});
    pre.textContent = formatRunOutput(r);
  } catch (err) {
    pre.textContent = `erro: ${err.message}\n${JSON.stringify(err.data ?? {}, null, 2)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'testar';
  }
};

const formatRunOutput = (r) => {
  const text = r?.result?.response;
  if (typeof text === 'string' && text.trim()) return text;
  return JSON.stringify(r.result ?? r, null, 2);
};

let flashTimer;
const flash = (text) => {
  const title = $('#editor-title');
  const original = state.current?.name ?? '';
  title.textContent = `${original} · ${text}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (title.textContent = original), 1500);
};

const openNewDialog = () => {
  renderNewDialogOptions();
  $('#new-name').value = '';
  $('#new-dialog').showModal();
};

const openNewJobDialog = () => {
  renderNewJobAgents();
  $('#new-job-name').value = '';
  $('#new-job-expr').value = '';
  $('#new-job-message').value = '';
  $('#new-job-channel').value = '';
  $('#new-job-catchup').checked = false;
  $('#new-job-dialog').showModal();
};

$('#save-btn').addEventListener('click', save);
$('#delete-btn').addEventListener('click', remove);
$('#run-btn').addEventListener('click', run);
$('#new-agent').addEventListener('click', openNewDialog);
$('#new-job').addEventListener('click', openNewJobDialog);
$('#job-delete-btn').addEventListener('click', () => {
  const id = $('#job-delete-btn').dataset.jobId;
  if (id) deleteJob(id);
});

$('#new-job-dialog').addEventListener('close', async () => {
  if ($('#new-job-dialog').returnValue !== 'default') return;
  const name = $('#new-job-name').value.trim();
  const expr = $('#new-job-expr').value.trim();
  const agent = $('#new-job-agent').value;
  const message = $('#new-job-message').value.trim();
  const channel = $('#new-job-channel').value.trim();
  const catchUp = $('#new-job-catchup').checked;
  if (!expr || !agent || !message) {
    alert('cron, agente e mensagem são obrigatórios');
    return;
  }
  const body = { expr, agent, message };
  if (name) body.name = name;
  if (channel) body.destination = { type: 'slack', channel };
  if (catchUp) body.catchUp = true;
  try {
    await api('POST', '/api/jobs', body);
    await refreshJobs();
  } catch (err) {
    alert(`falha ao criar job: ${err.message}\n${JSON.stringify(err.data ?? {}, null, 2)}`);
  }
});

$('#new-dialog').addEventListener('close', async () => {
  if ($('#new-dialog').returnValue !== 'default') return;
  const scope = $('#new-scope').value;
  const name = $('#new-name').value.trim();
  if (!name) return;
  try {
    await api('PUT', `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`, {
      content: TEMPLATE(name),
    });
    await refreshAgents();
    openAgent(scope, name);
  } catch (err) {
    alert(`falha ao criar: ${err.message}\n${JSON.stringify(err.data ?? {}, null, 2)}`);
  }
});

(async () => {
  await Promise.all([refreshHealth(), refreshProjects(), refreshAgents(), refreshJobs()]);
})();
