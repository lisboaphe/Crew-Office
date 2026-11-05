// The agent editor: a panel that slides in from the right with the office still visible.
//
// Every control here saves to something that changes what the agent does: the agent itself,
// its profile (lib/crew/profiles.cjs), or its rules (lib/crew/policies.cjs). Where something
// does not exist yet, the panel says so instead of offering a control that does nothing.
//
// The panel keeps its form while the office updates around it. Live events refresh only the
// header and the Activity tab, so nobody loses what they are typing to a heartbeat.

import { h, api, toast, avatar, ago, helpTip } from './common.js';
import { usageBar } from './connections.js';

const TABS = [['overview', 'Overview'], ['instructions', 'Instructions'], ['tools', 'Skills & Tools'], ['orchestration', 'Orchestration'], ['workspace', 'Workspace'], ['memory', 'Memory & Docs'], ['activity', 'Activity']];
const OWNER_ONLY = new Set(['instructions', 'tools', 'orchestration', 'memory']);
const WIDTH_KEY = 'crew.editorWidth';
const TOOL_GROUPS = [
  ['Team', ['messaging', 'memory', 'delegate']],
  ['Filesystem', ['files.read', 'files.write', 'git']],
  ['Execution', ['exec', 'web']],
];

const saved = (fn, ok = 'Saved') => async () => { try { await fn(); toast(ok); } catch (e) { toast(e.message, 6000); } };
const field = (label, el, hint) => h('div.cr-field', h('label', label), el, hint ? h('div.hint', hint) : null);
const check = (checked, label, hint) => { const c = h('input', { type: 'checkbox', checked: Boolean(checked) }); const row = h('label.cr-check', c, h('span', label, hint ? h('span.hint', ` ${hint}`) : null)); row.box = c; return row; };

export function createAgentEditor(ctx) {
  const { S, roomId, ui } = ctx;
  const R = `/api/crew/rooms/${roomId}`;
  let agentId = null;
  let tab = 'overview';
  let profile = null;
  let detail = null;
  let workspace = null;
  let expanded = false;
  let lastActivity = 0;

  const head = h('header.cr-editor-head');
  const nav = h('nav.cr-editor-tabs', { role: 'tablist' });
  const body = h('div.cr-editor-body');
  const handle = h('div.cr-editor-handle', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the panel', tabIndex: 0 });
  const el = h('section.cr.cr-editor', { 'aria-label': 'Agent editor', 'aria-hidden': 'true' }, handle, head, nav, body);
  try { const w = Number(localStorage.getItem(WIDTH_KEY)); if (w) el.style.setProperty('--cr-editor-width', `${w}px`); } catch {}

  const agent = () => S.agents.find((a) => a.id === agentId);
  const mine = () => agent()?.ownerId === S.me.id;
  const isOpen = () => el.classList.contains('open');

  function close() {
    el.classList.remove('open', 'expanded');
    el.setAttribute('aria-hidden', 'true');
    expanded = false;
    agentId = null;
  }

  async function open(id) {
    const same = id === agentId;
    agentId = id;
    if (!same) { tab = 'overview'; profile = null; detail = null; workspace = null; }
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    await load();
    draw();
  }

  async function load() {
    if (!agentId) return;
    const [d, w, p] = await Promise.all([
      api('GET', `${R}/agents/${agentId}`).catch(() => null),
      api('GET', `${R}/agents/${agentId}/workspace`).catch(() => ({ projects: [] })),
      mine() ? api('GET', `${R}/agents/${agentId}/profile`).catch(() => null) : null,
    ]);
    detail = d; workspace = w; profile = p;
  }

  function drawHead() {
    const a = agent();
    if (!a) return;
    head.replaceChildren(
      avatar(a.name, a.color, { ai: true, online: a.available }),
      h('div.grow', h('h2', a.name), h('div.hint', `${a.role} · ${a.ownerName}${mine() ? ' (you)' : '’s agent'}`)),
      ctx.statusPill(a.status),
      h('button.btn.small', { onclick: () => { expanded = !expanded; el.classList.toggle('expanded', expanded); }, title: 'Make the panel larger or smaller', 'aria-label': 'Expand the panel' }, expanded ? '⤡' : '⤢'),
      h('button.btn.small', { onclick: close, 'aria-label': 'Close the agent editor', title: 'Close (Esc)' }, '✕'));
  }

  function drawNav() {
    const allowed = TABS.filter(([k]) => mine() || !OWNER_ONLY.has(k));
    nav.replaceChildren(...allowed.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': k === tab ? 'true' : 'false', class: k === tab ? 'on' : '', onclick: () => { tab = k; draw(); } }, label)));
  }

  function draw() {
    const a = agent();
    if (!a) { close(); return; }
    if (!mine() && OWNER_ONLY.has(tab)) tab = 'overview';
    drawHead();
    drawNav();
    const view = ({ overview, instructions, tools, orchestration, workspace: workspaceTab, memory, activity })[tab](a);
    body.replaceChildren(h('div.cr-fade', view));
  }

  /** A patch to the agent row. */
  const saveAgent = (patch) => api('PATCH', `${R}/agents/${agentId}`, patch);
  const saveProfile = async (patch) => { await api('PUT', `${R}/agents/${agentId}/profile`, patch); profile = await api('GET', `${R}/agents/${agentId}/profile`); };
  /** Rules at this agent's level: what it already overrides, plus the change. */
  const saveRules = async (patch) => {
    const own = Object.fromEntries(Object.entries(profile.rules).filter(([, v]) => v.source === 'agent').map(([k, v]) => [k, v.value]));
    await api('PUT', `${R}/rules/agent/${agentId}`, { rules: { ...own, ...patch } });
    profile = await api('GET', `${R}/agents/${agentId}/profile`);
  };
  const ruleCheck = (key, label, hint) => {
    const row = check(profile.rules[key]?.value, label, hint);
    row.box.addEventListener('change', saved(() => saveRules({ [key]: row.box.checked })));
    return row;
  };

  // --- tabs --------------------------------------------------------------------------------

  function overview(a) {
    const task = S.tasks.find((t) => t.id === a.currentTaskId);
    const conn = S.providers_?.[a.ownerId]?.[a.provider];
    const facts = h('dl.cr-kv',
      h('dt', 'Owner'), h('dd', `${a.ownerName}${mine() ? ' (you)' : ''}`),
      h('dt', 'Status'), h('dd', a.available ? 'On the floor' : a.paused ? 'On holiday' : 'Unavailable: the owner’s worker is offline, or the owner is away'),
      h('dt', 'Current task'), h('dd', task ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.taskDetail(task); } }, task.title) : 'None'),
      h('dt', 'Connection'), h('dd', conn ? `${conn.state}: ${conn.reason}` : 'No report from the owner’s worker yet'));
    const actions = h('div.cr-actions', h('button.btn.primary', { onclick: () => ctx.assignTask(a) }, 'Assign a task'),
      mine() ? h('button.btn', { onclick: () => ctx.chatWith(a, detail?.dmChannelId) }, 'Chat') : null,
      mine() ? ctx.holidayButton(a) : null, mine() ? ctx.fireButton(a) : null);
    if (!mine()) return h('div', facts, h('p.hint', 'Only its owner can see or change how this agent is set up.'), actions);

    const name = h('input', { value: a.name, maxLength: 40 });
    const role = h('input', { value: a.role });
    const color = h('input', { type: 'color', value: a.color });
    const provider = h('select', ...Object.entries(S.providers).map(([k, p]) => h('option', { value: k, selected: k === a.provider }, p.label)));
    const model = h('input', { value: a.model });
    const models = h('div.hint');
    const known = h('datalist', { id: `models-${a.id}` });
    model.setAttribute('list', known.id);
    /** What may run for this role, from the owner's own worker. Each agent can use a different one. */
    const showModels = async () => {
      const p = S.providers[provider.value];
      known.replaceChildren();
      models.textContent = p.billing === 'paid' ? 'Billed per token. It will not run until you turn off “Never use paid API” on your worker.' : p.models.length ? `Models: ${p.models.join(', ')}` : provider.value === 'local' ? 'Use the model name your local server serves.' : 'Models are chosen under Connections. “default” means the one you chose there.';
      if (!['account', 'mixed'].includes(p.billing) && provider.value !== 'openrouter-free' && provider.value !== 'kiro') return;
      try {
        const res = await fetch(`http://127.0.0.1:${S.workerPort ?? 8790}/ai/models?provider=${encodeURIComponent(provider.value)}`);
        const r = await res.json();
        const free = (r.models ?? []).filter((m) => !m.blocked);
        known.replaceChildren(...free.map((m) => h('option', { value: m.id }, `${m.usageLabel}${m.tools === true ? ', uses tools' : ''}`)));
        if (free.length) models.textContent = `${free.length} models may run on this connection. Start typing to see them. Anything that would cost money is refused on your worker, whatever is typed here.`;
      } catch { /* the worker is not on this computer */ }
    };
    provider.addEventListener('change', () => { model.value = S.providers[provider.value].defaultModel; showModels(); });
    showModels();
    return h('div', facts, actions,
      h('div.row.cr-two', field('Name', name), field('Colour', color)),
      field('Role', role),
      h('div.row.cr-two', field('AI behind this agent', provider), field('Model', model)), known, models,
      backups(a),
      capacity(a),
      h('div.actions', h('button.btn.primary', { onclick: saved(() => saveAgent({ name: name.value, role: role.value, color: color.value, provider: provider.value, model: model.value })) }, 'Save')));
  }

  /** Other AIs this agent may move to at a limit. Paid APIs and the manual handoff are not offered. */
  function backups(a) {
    const options = Object.entries(S.providers).filter(([k, p]) => k !== a.provider && p.billing !== 'paid' && !['claude-handoff', 'scripted'].includes(k));
    const list = profile?.profile.fallbacks ?? [];
    const rows = options.map(([k, p]) => {
      const r = check(list.includes(k), p.label);
      r.box.addEventListener('change', saved(() => saveProfile({ fallbacks: [...options.map(([x]) => x)].filter((x) => (x === k ? r.box.checked : (profile.profile.fallbacks ?? []).includes(x))) })));
      return r;
    });
    return h('div.cr-field', h('label', 'Backup AIs', helpTip('Backup AIs', ['If this AI reports a limit, the task moves to the next one you tick, once each.', 'The whole task so far goes to that AI.', 'With none ticked, the work pauses at a limit instead.', 'A paid API can never be a backup.'])), ...rows);
  }

  function capacity(a) {
    const box = h('div.cr-field', h('label', 'Plan usage', helpTip('Plan usage', ['Shown only when the provider’s own tool reports it.', 'A token count is not a share of your plan, so one is never converted into the other.'])), h('p.hint', 'Checking your worker…'));
    ctx.usage().then((u) => {
      const reading = u?.reported?.[a.provider];
      box.lastChild.replaceWith(reading
        ? h('div', ...Object.entries(reading.windows).map(([n, w]) => h('div.cr-usage-window', h('div.row', h('span.grow', n), h('b', `${Math.round(w.usedPercent)}% used`)), usageBar(w.usedPercent))))
        : h('p.hint', u ? 'Usage unavailable' : 'Open this office from the Crew Office app to see your worker’s figures here.'));
    });
    return box;
  }

  function instructions(a) {
    const sys = h('textarea', { value: a.instructions ?? '', rows: 6, placeholder: 'How this agent should work. Only you can see this.' });
    const role = h('input', { value: a.role });
    const style = h('textarea', { value: profile.rules.styleGuide?.value ?? '', rows: 3, placeholder: 'Conventions it should follow' });
    const done = h('textarea', { value: profile.profile.definitionOfDone ?? '', rows: 3, placeholder: 'e.g. Tests pass, and the README explains how to run it.' });
    const plan = h('textarea', { value: profile.profile.planning ?? '', rows: 2, placeholder: 'e.g. List your steps before changing anything.' });
    const finish = h('textarea', { value: profile.profile.completion ?? '', rows: 2, placeholder: 'e.g. Say what you changed and what you did not test.' });
    return h('div',
      field('System instructions', sys, 'Goes to the agent with every job.'),
      field('Role', role),
      field('Custom working rules', style),
      field('Definition of Done', done, 'The office separately enforces tests and review, under Orchestration.'),
      ruleCheck('planFirst', 'Write a short plan before starting'),
      field('Planning requirements', plan),
      field('Task completion instructions', finish),
      h('div.actions', h('button.btn.primary', { onclick: saved(async () => {
        await saveAgent({ instructions: sys.value, role: role.value });
        await saveProfile({ definitionOfDone: done.value, planning: plan.value, completion: finish.value });
        await saveRules({ styleGuide: style.value });
      }) }, 'Save')));
  }

  function tools(a) {
    const skills = h('input', { value: a.skills.join(', '), placeholder: 'node, api, testing' });
    const boxes = new Map();
    const autonomy = h('select', h('option', { value: 'auto', selected: a.autonomy !== 'ask' }, 'Act within its permissions'), h('option', { value: 'ask', selected: a.autonomy === 'ask' }, 'Ask me before writing files, running code or fetching'));
    const groups = TOOL_GROUPS.map(([title, keys]) => h('div', h('h4', title), ...keys.filter((k) => S.permissions[k]).map((k) => {
      const row = check(a.tools.includes(k), k, S.permissions[k]);
      boxes.set(k, row.box);
      return row;
    })));
    return h('div',
      field('Skills', skills, 'Comma-separated. Used to match tasks to agents.'),
      h('h3', 'Tool permissions'), h('p.hint', 'A project can narrow these further, never widen them.'), ...groups,
      field('Autonomy', autonomy),
      h('h3', 'MCP servers'), h('p.hint', 'Not available yet. Agents act only through the office’s own tools, so there is nothing to connect here.'),
      h('div.actions', h('button.btn.primary', { onclick: saved(() => saveAgent({ skills: skills.value, autonomy: autonomy.value, tools: [...boxes].filter(([, b]) => b.checked).map(([k]) => k) })) }, 'Save')));
  }

  function orchestration(a) {
    const role = h('select', ...[['worker', 'Worker: does the tasks given to it'], ['lead', 'Lead: can manage projects and playbooks'], ['reviewer', 'Reviewer: preferred when a review is needed'], ['tester', 'Tester: runs and reports tests']].map(([v, l]) => h('option', { value: v, selected: profile.profile.orchestrationRole === v }, l)));
    const others = S.agents.filter((x) => x.id !== a.id);
    const list = profile.profile.delegationTargets ?? [];
    const targets = others.map((x) => { const r = check(list.includes(x.id), x.name, `${x.role}, ${x.ownerName}`); r.id = x.id; return r; });
    const coord = h('textarea', { value: profile.profile.coordination ?? '', rows: 3, placeholder: 'e.g. Tell the reviewer when a branch is ready.' });
    const approval = h('select', ...['manual', 'balanced', 'autonomous'].map((v) => h('option', { value: v, selected: profile.rules.approvalMode?.value === v }, { manual: 'Manual: ask for every risky step', balanced: 'Balanced: ask before merges', autonomous: 'Autonomous: ask only for deletes and rollbacks' }[v])));
    approval.addEventListener('change', saved(() => saveRules({ approvalMode: approval.value })));
    const tasks = S.tasks.filter((t) => t.assignedAgentId === a.id && !['completed', 'cancelled'].includes(t.status));
    const online = S.workers.filter((w) => w.online);
    return h('div',
      field('Orchestration role', role),
      h('div.cr-field', h('label', 'Assigned playbooks'), ...ctx.playbooksUsing(a.id).map((p) => h('div.hint', p.name)), ctx.playbooksUsing(a.id).length ? null : h('p.hint', 'None. Add this agent to a playbook in the Orchestrator.')),
      h('div.cr-field', h('label', 'May delegate to'), h('p.hint', 'None ticked means anyone on the project. This is enforced when the agent delegates.'), ...targets),
      field('Approval policy', approval),
      ruleCheck('requireReview', 'Require another agent’s review before merging', 'enforced'),
      ruleCheck('testsBeforeDone', 'Run suitable tests before marking done', 'enforced'),
      field('Team coordination rules', coord),
      h('div.cr-field', h('label', 'Worker'), h('p.hint', online.length ? `Runs on: ${online.map((w) => w.name).join(', ')}` : 'None of your workers is connected to this office.')),
      h('div.cr-field', h('label', 'Open tasks and what they wait for'), ...(tasks.length ? tasks.map((t) => h('div.hint', `${t.title}: ${t.status.replace(/_/g, ' ')}${t.deps.length ? `, after ${t.deps.map((d) => S.tasks.find((x) => x.id === d)?.title ?? 'another task').join(', ')}` : ''}`)) : [h('p.hint', 'None.')])),
      h('div.actions', h('button.btn.primary', { onclick: saved(async () => {
        await saveProfile({ orchestrationRole: role.value, coordination: coord.value, delegationTargets: targets.filter((t) => t.box.checked).map((t) => t.id) });
        if (role.value === 'lead' && !a.isManager) await saveAgent({ isManager: true });
      }) }, 'Save')));
  }

  function workspaceTab() {
    const projects = workspace?.projects ?? [];
    if (!projects.length) return h('p.hint', 'Not on any project yet. A project’s owner adds agents to it, and that is what gives this one a repository and a branch.');
    return h('div', h('p.hint', 'Each task gets its own clone and branch, on its owner’s worker. This shows where the work lands, not a setting.'),
      ...projects.map((p) => h('div.cr-item', h('div.row', h('b.grow', p.name), h('span.pill', p.status)),
        h('dl.cr-kv.tight',
          h('dt', 'Repository'), h('dd', p.repos.length ? p.repos.map((r) => r.name).join(', ') : 'None: it uses the project’s shared files'),
          h('dt', 'Branch'), h('dd', p.branch ? h('code', p.branch) : 'None open'),
          h('dt', 'Working copy'), h('dd', 'A separate clone per task on the worker'),
          h('dt', 'Access here'), h('dd', p.tools.join(', ') || 'None')))));
  }

  function memory() {
    const privateBox = h('div.cr-field', h('label', 'Private memory'), h('p.hint', 'Reading your worker…'));
    ctx.privateMemory(agentId).then((m) => {
      privateBox.lastChild.replaceWith(m === null ? h('p.hint', 'Kept on your worker, never on the host. Open this office from the Crew Office app to read it here.')
        : m.length ? h('div.cr-list', ...m.map((x) => h('div.cr-item', h('b', x.key), h('div.hint', x.value.slice(0, 300))))) : h('p.hint', 'Nothing yet. Kept on your worker, never on the host.'));
    });
    const notes = (workspace?.projects ?? []).flatMap((p) => p.notes.map((n) => ({ ...n, project: p.name })));
    return h('div', privateBox,
      h('div.cr-field', h('label', 'Shared project context'), ...(notes.length ? notes.map((n) => h('div.cr-item', h('b', n.title), h('span.hint', ` ${n.project}`), h('div.hint', n.body))) : [h('p.hint', 'No shared notes yet.')])),
      h('h3', 'Documentation'), h('p.hint', 'Optional, and enforced when on: the task cannot finish without them.'),
      ruleCheck('progressReports', 'Write a progress report after each task'),
      ruleCheck('handoffNotes', 'Write handoff notes when delegating'),
      ruleCheck('updateReadme', 'Update the README after an approved milestone'));
  }

  function activity(a) {
    if (!detail) return h('p.hint', 'Loading…');
    const artifacts = (workspace?.projects ?? []).flatMap((p) => p.artifacts.map((x) => ({ ...x, project: p.name, projectId: p.id })));
    return h('div',
      h('dl.cr-kv.tight',
        h('dt', 'Tokens processed'), h('dd', (a.tokensIn + a.tokensOut).toLocaleString()),
        h('dt', 'API cost'), h('dd', S.providers[a.provider]?.billing === 'paid' ? `$${a.spentUsd.toFixed(4)} of $${a.budgetUsd}` : 'None: not billed per token')),
      h('h3', 'Recent tasks'), h('div.cr-list', ...(detail.tasks.length ? detail.tasks.slice(0, 15).map((t) => h('div.cr-item.click', { onclick: () => ctx.taskDetail(t) }, h('div.row', h('b.grow', t.title), h('span.pill', t.status.replace(/_/g, ' '))), t.resultSummary ? h('div.hint', t.resultSummary.slice(0, 160)) : null)) : [h('p.hint', 'No tasks yet.')])),
      h('h3', 'Tool and execution logs'), h('div.cr-list', ...(detail.jobs.length ? detail.jobs.slice(0, 12).map((j) => h('div.cr-item.click.row', { onclick: () => ctx.jobLogs(j) }, h('span.grow', `${j.type}, ${j.status}`), h('span.hint', ago(j.updatedAt)), j.error ? h('span.pill.bad', 'error') : null)) : [h('p.hint', 'Nothing has run yet.')])),
      h('h3', 'Recent files'), h('div.cr-list', ...(artifacts.length ? artifacts.map((x) => h('div.cr-item.click.row', { onclick: () => ctx.viewFile(x.projectId, x.path) }, h('code.grow', x.path), h('span.hint', x.project))) : [h('p.hint', 'No files yet.')])),
      h('h3', 'Messages'), h('div.cr-list', ...(detail.messages.length ? detail.messages.slice().reverse().slice(0, 20).map(ctx.messageView) : [h('p.hint', 'No messages yet.')])));
  }

  // --- resizing and closing ------------------------------------------------------------------

  const setWidth = (w) => {
    const clamped = Math.max(360, Math.min(w, window.innerWidth - 80));
    el.style.setProperty('--cr-editor-width', `${clamped}px`);
    try { localStorage.setItem(WIDTH_KEY, String(clamped)); } catch {}
  };
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    el.classList.add('resizing');
    const move = (m) => setWidth(window.innerWidth - m.clientX);
    const up = () => { el.classList.remove('resizing'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', (e) => {
    const now = el.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setWidth(now + 24);
    if (e.key === 'ArrowRight') setWidth(now - 24);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !document.querySelector('.cr-modal-back')) close();
  });
  let swipeFrom = null;
  el.addEventListener('touchstart', (e) => { swipeFrom = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => { if (swipeFrom !== null && e.changedTouches[0].clientX - swipeFrom > 90) close(); swipeFrom = null; }, { passive: true });

  /** The office changed. Update what is safe to update, and leave any form alone. */
  function refresh() {
    if (!isOpen()) return;
    if (!agent()) { close(); return; }
    drawHead();
    if (tab === 'activity' && Date.now() - lastActivity > 3000) {
      lastActivity = Date.now();
      load().then(() => { if (tab === 'activity') draw(); });
    }
  }

  return { el, open, close, refresh, isOpen };
}
