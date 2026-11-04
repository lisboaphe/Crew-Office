// The multiplayer layer over the 3D office: who is here, the dashboard, chat, the agent
// control panel, and speech bubbles pinned above the characters.
//
// It loads with every office page and does nothing unless this office is a crew room.
// State comes from one snapshot plus a stream of events; a reconnect that missed too much
// is told to resync and fetches the snapshot again, so no state lives only in the page.

import { h, api, toast, modal, avatar, ago, money, BRAND, reportErrors } from './common.js';
import { openTutorial, tutorialOnFirstVisit } from './tutorial.js';
import { gitTab, filesTab, rulesTab } from './workspace.js';

const code = (location.pathname.match(/^\/office\/([^/]+)/) ?? [])[1];
const S = { room: null, me: null, members: [], agents: [], projects: [], tasks: [], channels: [], approvals: [], notifications: [], workers: [], feed: [], artifacts: [], permissions: {}, providers: {}, host: {} };
let roomId = null;
let es = null;
const ui = { dash: null, side: null, bar: null, tab: 'projects', sideMode: 'chat', channelId: null, agentId: null, projectId: null, messages: new Map() };

boot().catch((err) => console.error('[crew]', err));

async function boot() {
  if (!code) return;
  let info;
  try { info = await api('GET', `/api/crew/rooms/by-code/${encodeURIComponent(code)}`); } catch { return; } // not a crew office
  reportErrors('office');
  const { user } = await api('GET', '/api/crew/me');
  if (!user || !info.room.myRole) { location.href = `/crew/join?code=${encodeURIComponent(code)}`; return; }
  roomId = info.room.id;
  const link = h('link', { rel: 'stylesheet', href: '/crew/crew.css' });
  document.head.append(link);
  document.title = `${info.room.name} — ${BRAND}`;
  const h1 = document.querySelector('#title-bar h1');
  if (h1) h1.lastChild.textContent = BRAND;
  await refresh();
  buildChrome();
  connect();
  tutorialOnFirstVisit({ showMe: tourShowMe });
  window.addEventListener('office:select', (e) => {
    const id = String(e.detail?.id ?? '');
    const m = id.match(/#crew:(agt_[A-Za-z0-9_-]+)$/);
    if (m) {
      openAgent(m[1]);
      document.getElementById('inspector')?.classList.add('hidden');
    }
  });
  requestAnimationFrame(tick);
}

async function refresh() {
  const snap = await api('GET', `/api/crew/rooms/${roomId}/state`);
  Object.assign(S, snap);
  S.providers_ = snap.providerStates ?? {};
  if (!ui.channelId) ui.channelId = S.channels.find((c) => c.name === 'office-general')?.id ?? S.channels[0]?.id;
  ui.messages.clear();
  render();
}

function connect() {
  es?.close();
  es = new EventSource(`/api/crew/rooms/${roomId}/events`);
  const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  on('resync', () => refresh());
  // The owner gets the agent twice — the public view, then their own with the brief — in that order.
  on('agent', (a) => { upsert(S.agents, a); render(); });
  on('agent.removed', ({ id }) => { S.agents = S.agents.filter((a) => a.id !== id); render(); });
  on('members', ({ members }) => { S.members = members; render(); });
  on('project', (p) => { upsert(S.projects, p); render(); });
  on('task', (t) => { upsert(S.tasks, t); render(); });
  on('approval', (a) => { upsert(S.approvals, a); render(); });
  on('notification', (n) => { S.notifications.unshift(n); toast(n.text, 5000); render(); });
  on('channel', (c) => { upsert(S.channels, c); render(); });
  on('room', (r) => { S.room = { ...S.room, ...r, myRole: S.room.myRole }; render(); });
  on('workers', () => api('GET', `/api/crew/rooms/${roomId}/state`).then((s) => { S.workers = s.workers; S.members = s.members; render(); }));
  on('artifact', (a) => {
    if (a.deleted) S.artifacts = S.artifacts.filter((x) => !(x.projectId === a.projectId && x.path === a.path));
    else upsert(S.artifacts, { ...a, projectName: S.projects.find((p) => p.id === a.projectId)?.name }, (x) => x.projectId === a.projectId && x.path === a.path);
    render();
  });
  on('message', (m) => {
    const list = ui.messages.get(m.channelId);
    if (list && !list.some((x) => x.id === m.id)) list.push(m);
    if (m.senderType === 'agent') { S.feed.push(m); if (S.feed.length > 200) S.feed.shift(); }
    render();
  });
  on('bubble', (b) => bubble(b.agentId, b.text, { to: S.agents.find((a) => a.id === b.toAgentId)?.name }));
  on('react', (r) => bubble(r.agentId, r.kind === 'assigned' ? `📥 ${r.text}` : `✅ ${r.text}`, { react: true, ms: 4500 }));
  on('git', () => { ui.reloadGit?.(); });
  on('merge', (m) => { upsert(S.merges ??= [], m); ui.reloadGit?.(); });
  on('file', () => { ui.reloadFiles?.(); });
  on('rules', () => { ui.rules = null; render(); });
  on('providers', ({ userId, providers }) => { (S.providers_ ??= {})[userId] = providers; render(); });
  on('activity', (a) => { activities.set(a.agentId, a); });
  on('meeting', (m) => { if (m.on) meetings.set(m.agents.join('|'), m.agents); else meetings.delete(m.agents.join('|')); });
  es.onerror = () => { /* EventSource reconnects by itself, with Last-Event-ID */ };
}

function upsert(list, item, match = (x) => x.id === item.id) {
  const i = list.findIndex(match);
  if (i >= 0) list[i] = { ...list[i], ...item }; else list.push(item);
}

// --- chrome ---------------------------------------------------------------

function buildChrome() {
  ui.bar = h('div.cr', { id: 'crew-bar' });
  ui.dash = h('section.cr.cr-drawer.left.hidden', { 'aria-label': 'Dashboard' });
  ui.side = h('section.cr.cr-drawer.right.hidden', { 'aria-label': 'Chat and agents' });
  bubbleLayer = h('div', { id: 'crew-bubbles' });
  pillLayer = h('div', { id: 'crew-pills' });
  meetingLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  meetingLayer.id = 'crew-meetings';
  document.body.append(meetingLayer, pillLayer, bubbleLayer, ui.bar, ui.dash, ui.side);
  render();
}

let renderQueued = false;
function render() {
  if (renderQueued || !ui.bar) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderBar(); if (!ui.dash.classList.contains('hidden')) renderDash(); if (!ui.side.classList.contains('hidden')) renderSide(); });
}

function renderBar() {
  const pending = S.approvals.filter((a) => a.status === 'pending' && a.approverId === S.me.id).length;
  const unread = S.notifications.filter((n) => !n.read).length;
  const players = h('div.players', { title: 'Players' }, ...S.members.map((m) => avatar(m.displayName, m.color, { online: m.online, title: `${m.displayName} (${m.role})${m.online ? ' — here' : ''}` })));
  ui.bar.replaceChildren(
    h('span.room-name', S.room.name, S.room.status !== 'open' ? ' · stopped' : ''),
    players,
    h('button.btn', { onclick: () => toggleDash() }, 'Dashboard'),
    h('button.btn', { onclick: () => openSide('chat') }, 'Chat'),
    h('button.btn', { onclick: () => toggleDash('approvals') }, 'Approvals', pending ? h('span.badge', pending) : null),
    h('button.btn', { onclick: () => toggleDash('notifications') }, '🔔', unread ? h('span.badge', unread) : null),
    h('button.btn', { onclick: () => openTutorial({ showMe: tourShowMe }), title: 'A short tour of how the office works' }, '📘 How it works'),
  );
}

/** "Show me" from the tour: open the dashboard on the tab that step is about. */
function tourShowMe(tab) {
  ui.tab = tab;
  ui.dash.classList.remove('hidden');
  render();
}

function toggleDash(tab) {
  if (tab) ui.tab = tab;
  if (!ui.dash.classList.contains('hidden') && !tab) ui.dash.classList.add('hidden');
  else ui.dash.classList.remove('hidden');
  if (tab === 'notifications') api('POST', `/api/crew/rooms/${roomId}/notifications/read`).then(() => { S.notifications.forEach((n) => { n.read = true; }); render(); });
  render();
}

// --- dashboard --------------------------------------------------------------

const TABS = [['projects', 'Projects'], ['board', 'Task board'], ['git', 'Git / Sync'], ['files', 'Office files'], ['agents', 'Agents'], ['teams', 'Teams'], ['feed', 'Live feed'], ['deliverables', 'Deliverables'], ['approvals', 'Approvals'], ['rules', 'Rules'], ['costs', 'Costs'], ['workers', 'My workers'], ['notifications', 'Notifications'], ['room', 'Office']];

function renderDash() {
  const body = h('div.body');
  const wsCtx = { S, roomId, ui, render, taskDetail };
  ({ git: (b) => gitTab(b, wsCtx), files: (b) => filesTab(b, wsCtx), rules: (b) => rulesTab(b, wsCtx), projects: dashProjects, board: dashBoard, agents: dashAgents, teams: dashTeams, feed: dashFeed, deliverables: dashDeliverables, approvals: dashApprovals, costs: dashCosts, workers: dashWorkers, notifications: dashNotifications, room: dashRoom })[ui.tab](body);
  ui.dash.replaceChildren(
    h('header', h('h2', 'Dashboard'), h('button.btn.small', { onclick: () => ui.dash.classList.add('hidden'), 'aria-label': 'Close' }, '✕')),
    h('nav.cr-tabs', ...TABS.map(([k, label]) => h('button', { class: ui.tab === k ? 'on' : '', onclick: () => { ui.tab = k; render(); } }, label))),
    body);
}

const agentById = (id) => S.agents.find((a) => a.id === id);
const userById = (id) => S.members.find((m) => m.userId === id);
const STATUS_COLOR = { IDLE: '#8d99ae', ASSIGNED: '#3d85c6', PLANNING: '#9b5de5', WORKING: '#2a8a4a', WAITING: '#c27c0e', REVIEW: '#00a3b4', COMPLETED: '#2a8a4a', FAILED: '#c0392b', PAUSED: '#8d99ae', BLOCKED: '#c0392b', OFFLINE: '#b9bfcb', CANCELLED: '#8d99ae' };
const statusPill = (s) => h('span.pill', { style: { color: STATUS_COLOR[s] ?? 'inherit' } }, h('span.dot', { style: { background: STATUS_COLOR[s] ?? '#999' } }), s);

function dashProjects(body) {
  body.append(h('div.row', h('h2.grow', 'Projects'), S.room.myRole !== 'guest' ? h('button.btn.primary', { onclick: newProject }, 'New project') : null));
  if (!S.projects.length) body.append(h('p.hint', 'No projects yet. A project has a goal and a manager agent who plans the work for the team.'));
  for (const p of S.projects) {
    const pct = p.progress.total ? Math.round((100 * p.progress.done) / p.progress.total) : 0;
    const member = p.members.includes(S.me.id);
    const mgr = agentById(p.managerAgentId);
    body.append(h('div.cr-item', { style: { marginBottom: '10px' } },
      h('div.row', h('b.grow', p.name), h('span.pill', p.status.replace(/_/g, ' ')), h('span.muted', `${p.progress.done}/${p.progress.total} tasks · ${money(p.cost?.c)}`)),
      h('p.muted', { style: { margin: '4px 0' } }, p.goal),
      h('div.cr-progress', h('div', { style: { width: `${pct}%` } })),
      h('p.hint', 'Manager: ', mgr?.name ?? '?', ' · Team: ', p.grants.map((g) => agentById(g.agentId)?.name).filter(Boolean).join(', ') || '—'),
      p.summary ? h('details', h('summary', 'Final summary'), h('pre', p.summary)) : null,
      h('div.row',
        member ? null : h('button.btn.small', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/projects/${p.id}/join`), 'Joined the project') }, 'Join project'),
        member ? h('button.btn.small', { onclick: () => grantAgents(p) }, 'Lend my agents') : null,
        member ? h('button.btn.small', { onclick: () => newTask(p) }, 'Add task') : null,
        p.status === 'draft' && p.createdBy === S.me.id ? h('button.btn.small.primary', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/projects/${p.id}/start`), 'Project started — the manager is planning') }, 'Start: let the manager plan') : null,
        h('button.btn.small', { onclick: () => { ui.tab = 'board'; ui.projectId = p.id; render(); } }, 'Task board'),
        h('button.btn.small', { onclick: () => { const ch = S.channels.find((c) => c.id === p.channelId); if (ch) { ui.channelId = ch.id; openSide('chat'); } } }, 'Channel'),
        h('button.btn.small', { onclick: () => { ui.tab = 'deliverables'; ui.projectId = p.id; render(); } }, 'Files'))));
  }
}

function dashBoard(body) {
  const p = S.projects.find((x) => x.id === ui.projectId) ?? S.projects[0];
  if (!p) { body.append(h('p.hint', 'No projects yet.')); return; }
  ui.projectId = p.id;
  body.append(h('div.row', h('select', { onchange: (e) => { ui.projectId = e.target.value; render(); } }, ...S.projects.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name))), h('span.grow')));
  const cols = [['To do', ['pending', 'awaiting_approval', 'queued']], ['In progress', ['in_progress']], ['Waiting', ['waiting', 'review', 'blocked']], ['Done', ['completed']], ['Failed / cancelled', ['failed', 'cancelled']]];
  const tasks = S.tasks.filter((t) => t.projectId === p.id);
  body.append(h('div.cr-kanban', ...cols.map(([title, states]) => h('div.col', h('h4', `${title} (${tasks.filter((t) => states.includes(t.status)).length})`),
    ...tasks.filter((t) => states.includes(t.status)).map((t) => h('div.tcard', { style: { borderLeftColor: t.agentColor ?? '#ccc' }, onclick: () => taskDetail(t) },
      h('div', h('b', t.title)), h('div.muted', `${t.kind} · ${t.assignedAgentName ?? 'unassigned'}`), h('div.hint', t.status.replace(/_/g, ' '), t.artifacts.length ? ` · ${t.artifacts.length} file(s)` : '')))))));
}

function dashAgents(body) {
  body.append(h('div.row', h('h2.grow', 'Agent directory'), S.room.myRole !== 'guest' ? h('button.btn.primary', { onclick: () => agentForm() }, 'New agent') : null));
  body.append(h('div.cr-list', ...S.agents.map((a) => h('div.cr-item.click.row', { onclick: () => openAgent(a.id) },
    avatar(a.name, a.color, { ai: true, online: a.available }), h('div.grow', h('b', a.name), ' ', h('span.muted', a.role), h('div.hint', `${a.ownerName}'s team · ${a.provider}/${a.model}`)),
    statusPill(a.status)))));
}

function dashTeams(body) {
  for (const m of S.members) {
    const agents = S.agents.filter((a) => a.ownerId === m.userId);
    body.append(h('div.cr-item', { style: { marginBottom: '8px' } },
      h('div.row', avatar(m.displayName, m.color, { online: m.online }), h('b.grow', `${m.displayName}'s team`), h('span.pill.human', m.role),
        h('span.pill', { class: m.workerOnline ? 'ok' : '' }, m.workerOnline ? 'worker online' : 'worker offline')),
      agents.length ? h('div.row', { style: { marginTop: '6px' } }, ...agents.map((a) => h('button.btn.small', { onclick: () => openAgent(a.id) }, h('span.dot', { style: { background: a.color } }), a.name, ' · ', a.status))) : h('p.hint', 'No agents yet.')));
  }
}

function dashFeed(body) {
  body.append(h('p.hint', 'Every message an agent sends, as it happens — each one is a real tool call by that agent.'));
  body.append(h('div.cr-list', ...S.feed.slice(-120).reverse().map(messageView)));
}

function dashDeliverables(body) {
  const projects = S.projects;
  if (!projects.length) { body.append(h('p.hint', 'No projects yet.')); return; }
  for (const p of projects) {
    const files = S.artifacts.filter((f) => f.projectId === p.id);
    body.append(h('h3', p.name), files.length ? h('div.cr-list', ...files.map((f) => h('div.cr-item.click.row', { onclick: () => viewFile(p.id, f.path) },
      h('code.grow', f.path), h('span.pill', f.kind), h('span.muted', `${f.agentName ?? 'human'} · ${Math.ceil(f.size / 1024)} KB`)))) : h('p.hint', 'No files yet.'));
  }
}

function dashApprovals(body) {
  const mine = S.approvals.filter((a) => a.approverId === S.me.id && a.status === 'pending');
  const others = S.approvals.filter((a) => a.approverId !== S.me.id && a.status === 'pending');
  body.append(h('h2', 'Waiting for you'));
  if (!mine.length) body.append(h('p.hint', 'Nothing needs your decision.'));
  for (const a of mine) body.append(approvalView(a, true));
  if (others.length) { body.append(h('h3', 'Waiting for others')); for (const a of others) body.append(approvalView(a, false)); }
  const done = S.approvals.filter((a) => a.status !== 'pending').slice(0, 20);
  if (done.length) { body.append(h('h3', 'Decided')); for (const a of done) body.append(approvalView(a, false)); }
}

function approvalView(a, canDecide) {
  const d = a.detail ?? {};
  const who = userById(a.approverId)?.displayName ?? '?';
  const what = a.kind === 'merge' ? `Merge ${d.repo}/${d.branch} into main (${d.agentName}; ${d.why ?? ''})` : a.kind === 'plan' ? `Approve the plan for “${d.project}”` : a.kind === 'assignment' ? `Let ${d.agentName} work on “${d.title}” (${d.project})` : a.kind === 'tool' ? `${d.agentName} wants to ${d.summary}` : `${d.agentName}: ${d.reason}`;
  const note = h('input', { placeholder: 'Optional note to the agent' });
  return h('div.cr-item', { style: { marginBottom: '8px' } },
    h('div.row', h('b.grow', what), h('span.pill', a.kind), h('span.pill', { class: a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : 'warn' }, a.status)),
    a.kind === 'plan' && d.tasks ? h('ol', ...d.tasks.map((t) => h('li', t.title, ' → ', h('b', t.assignee ?? 'unassigned')))) : null,
    d.summary && a.kind === 'merge' ? h('p.hint', d.summary) : null,
    d.reason ? h('p.hint', d.reason) : null,
    h('p.hint', `Decision belongs to ${who} · ${ago(a.createdAt)}`),
    canDecide ? h('div.row', h('div.grow', note),
      h('button.btn.small.primary', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/approvals/${a.id}`, { decision: 'approved', note: note.value }), 'Approved') }, 'Approve'),
      h('button.btn.small.danger', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/approvals/${a.id}`, { decision: 'rejected', note: note.value }), 'Rejected') }, 'Reject')) : null);
}

function dashCosts(body) {
  const total = S.agents.reduce((s, a) => s + a.spentUsd, 0);
  const tokens = S.agents.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0);
  const failed = S.tasks.filter((t) => t.status === 'failed').length;
  body.append(h('div.cr-stat', h('div.card', h('b', money(total)), 'spent by all agents'), h('div.card', h('b', tokens.toLocaleString()), 'tokens'), h('div.card', h('b', S.tasks.filter((t) => t.status === 'completed').length), 'tasks completed'), h('div.card', h('b', failed), 'tasks failed')));
  body.append(h('h3', 'Per agent'), h('div.cr-list', ...S.agents.map((a) => {
    const done = S.tasks.filter((t) => t.assignedAgentId === a.id && t.status === 'completed').length;
    const bad = S.tasks.filter((t) => t.assignedAgentId === a.id && t.status === 'failed').length;
    return h('div.cr-item.row', avatar(a.name, a.color, { ai: true }), h('div.grow', h('b', a.name), h('div.hint', `${a.ownerName} · ${done} done · ${bad} failed`)),
      h('div', { style: { textAlign: 'right' } }, h('b', `${money(a.spentUsd)} / ${money(a.budgetUsd)}`), h('div.hint', `${(a.tokensIn + a.tokensOut).toLocaleString()} tokens`)));
  })));
  body.append(h('p.hint', 'Costs are computed on each owner’s worker from the provider’s reported token usage and a price table; local and unpriced models count as $0.'));
}

function dashWorkers(body) {
  body.append(h('h2', 'Your workers'), h('p.hint', 'A worker is a small program on your computer that runs your agents with your own API keys. The office host never receives your keys. Without a connected worker your agents are unavailable.'));
  body.append(h('div.cr-list', ...(S.workers.length ? S.workers.map((w) => h('div.cr-item.row', h('span.dot', { style: { background: w.online ? 'var(--cr-ok)' : '#bbb' } }), h('b.grow', w.name), h('span.muted', w.alwaysOn ? 'always-on' : 'attended (runs while you are here)'), h('span.muted', w.online ? 'online' : 'offline'),
    h('button.btn.small.danger', { onclick: () => act(() => api('DELETE', `/api/crew/rooms/${roomId}/workers/${w.id}`), 'Worker revoked') }, 'Revoke'))) : [h('p.hint', 'No workers yet.')])));
  body.append(h('div.row', { style: { marginTop: '10px' } }, h('button.btn.primary', { onclick: connectWorker }, 'Connect a worker')));
}

function dashNotifications(body) {
  if (!S.notifications.length) body.append(h('p.hint', 'No notifications.'));
  body.append(h('div.cr-list', ...S.notifications.map((n) => h('div.cr-item', h('span.pill', { class: n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : '' }, n.level), ' ', n.text, h('div.hint', ago(n.createdAt))))));
}

function dashRoom(body) {
  const r = S.room;
  const admin = ['owner', 'admin'].includes(r.myRole);
  body.append(h('h2', r.name), h('p', 'Room code: ', h('code', r.code), ` · ${r.players}/${r.maxPlayers} players · ${r.privacy}${r.hasPassword ? ' · password set' : ''} · you are ${r.myRole}`));
  const links = (S.host.lanAddresses ?? []).map((a) => `http://${a}:${S.host.port}/crew/join?code=${r.code}`);
  body.append(h('p.hint', links.length ? 'Friends on your network: ' : 'This host listens on this computer only (start it with npm run host to accept your network).'), ...links.map((l) => h('p', h('code', l))));
  if (admin) {
    body.append(h('div.row', h('button.btn', { onclick: invite }, 'Create invitation link'), h('button.btn', { onclick: roomSettings }, 'Office settings'),
      h('a.btn', { href: `/api/crew/rooms/${roomId}/export`, download: `office-${r.code}.json` }, 'Export office (JSON)'),
      r.myRole === 'owner' ? h('button.btn.danger', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }), r.status === 'open' ? 'Office stopped' : 'Office started') }, r.status === 'open' ? 'Stop office' : 'Start office') : null));
  }
  body.append(h('h3', 'Players'), h('div.cr-list', ...S.members.map((m) => h('div.cr-item.row', avatar(m.displayName, m.color, { online: m.online }), h('b.grow', m.displayName), h('span.muted', `@${m.username}`),
    admin && m.role !== 'owner' && m.userId !== S.me.id ? h('select', { onchange: (e) => act(() => api('POST', `/api/crew/rooms/${roomId}/members/${m.userId}/role`, { role: e.target.value }), 'Role changed') }, ...['guest', 'member', 'admin'].map((x) => h('option', { value: x, selected: m.role === x }, x))) : h('span.pill', m.role),
    admin && m.role !== 'owner' && m.userId !== S.me.id ? h('button.btn.small.danger', { onclick: () => confirm(`Remove ${m.displayName} and take their agents off the floor?`) && act(() => api('DELETE', `/api/crew/rooms/${roomId}/members/${m.userId}`), 'Player removed') }, 'Remove') : null))));
  body.append(h('h3', 'Your profile'), h('div.row', h('button.btn', { onclick: profile }, 'Change name or avatar colour'), h('a.btn', { href: '/crew' }, 'Back to lobby')));
  body.append(h('p.hint', { style: { marginTop: '16px' } }, `${BRAND} is based on The Roving Office (Apache-2.0, © Atlassian). See NOTICE.`));
}

// --- side panel: chat and agents ----------------------------------------------

function openSide(mode) {
  ui.sideMode = mode;
  ui.side.classList.remove('hidden');
  render();
}

function openAgent(id) {
  ui.agentId = id;
  ui.agentDetail = null;
  openSide('agent');
  api('GET', `/api/crew/rooms/${roomId}/agents/${id}`).then((d) => { ui.agentDetail = d; render(); }).catch((e) => toast(e.message));
}

function renderSide() {
  if (ui.sideMode === 'agent') return renderAgent();
  const ch = S.channels.find((c) => c.id === ui.channelId) ?? S.channels[0];
  if (!ch) { ui.side.replaceChildren(h('header', h('h2', 'Chat'))); return; }
  ui.channelId = ch.id;
  let msgs = ui.messages.get(ch.id);
  if (!msgs) {
    msgs = [];
    ui.messages.set(ch.id, msgs);
    api('GET', `/api/crew/rooms/${roomId}/channels/${ch.id}/messages`).then((r) => { msgs.splice(0, msgs.length, ...r.messages); render(); });
  }
  const list = h('div.cr-msgs', ...msgs.map(messageView));
  const input = h('input.grow', { placeholder: ch.kind === 'dm' ? 'Message your agent…' : `Message #${ch.name} — @Name addresses an agent` });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      if (ch.kind === 'dm') await api('POST', `/api/crew/rooms/${roomId}/agents/${ch.dmAgentId}/chat`, { text });
      else await api('POST', `/api/crew/rooms/${roomId}/channels/${ch.id}/messages`, { body: text });
    } catch (e) { toast(e.message); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const label = (c) => (c.kind === 'dm' ? `@${agentById(c.dmAgentId)?.name ?? 'agent'}` : `#${c.name.replace(/-[a-z0-9]{4}$/, c.kind === 'project' ? '' : '$&')}`);
  ui.side.replaceChildren(
    h('header', h('h2', 'Chat'), h('button.btn.small', { onclick: searchMessages }, 'Search'), h('button.btn.small', { onclick: () => ui.side.classList.add('hidden'), 'aria-label': 'Close' }, '✕')),
    h('div.cr-channels', ...S.channels.map((c) => h('button', { class: c.id === ch.id ? 'on' : '', onclick: () => { ui.channelId = c.id; render(); } }, label(c))),
      h('button', { onclick: newChannel, title: 'New channel' }, '+')),
    list,
    h('div.cr-composer', input, h('button.btn.primary', { onclick: send }, 'Send')));
  list.scrollTop = list.scrollHeight;
}

function messageView(m) {
  const isAgent = m.senderType === 'agent';
  return h('div.cr-msg', { class: m.senderType === 'system' ? 'system' : '' },
    m.senderType === 'system' ? null : avatar(m.senderName, m.senderColor, { ai: isAgent }),
    h('div.grow',
      h('div.meta', h('b', m.senderName), isAgent ? h('span.pill.ai', 'AI') : m.senderType === 'human' ? h('span.pill.human', 'human') : null,
        m.toAgentName ? h('span', `→ ${m.toAgentName}`) : null, m.kind !== 'chat' && m.kind !== 'system' ? h('span.pill', m.kind.replace('_', ' ')) : null,
        m.taskId ? h('span.hint', 'task-linked') : null, h('span', ago(m.createdAt))),
      h('div.text', m.body)));
}

function renderAgent() {
  const a = agentById(ui.agentId);
  if (!a) { ui.side.replaceChildren(h('header', h('h2', 'Agent'), h('button.btn.small', { onclick: () => openSide('chat') }, 'Back'))); return; }
  const d = ui.agentDetail;
  const mine = a.ownerId === S.me.id;
  const task = S.tasks.find((t) => t.id === a.currentTaskId);
  const body = h('div.body',
    h('div.cr-agent-head', avatar(a.name, a.color, { ai: true, online: a.available }), h('div.grow', h('h2', { style: { margin: 0 } }, a.name), h('div.muted', a.role)), statusPill(a.status)),
    h('dl.cr-kv',
      h('dt', 'Owner'), h('dd', `${a.ownerName}${mine ? ' (you)' : ''}`),
      h('dt', 'Model'), h('dd', `${S.providers[a.provider]?.label ?? a.provider} · ${a.model}`),
      h('dt', 'Connection'), h('dd', S.providers_?.[a.ownerId]?.[a.provider] ? `${S.providers_[a.ownerId][a.provider].state}: ${S.providers_[a.ownerId][a.provider].reason}` : 'No report from the owner’s worker yet'),
      h('dt', 'Assigned task'), h('dd', task ? task.title : '—'),
      h('dt', 'Skills'), h('dd', a.skills.join(', ') || '—'),
      h('dt', 'Tools'), h('dd', a.tools.join(', ') || '—'),
      h('dt', 'Autonomy'), h('dd', a.autonomy === 'ask' ? 'asks before writing files, running code or fetching' : 'acts within its permissions'),
      h('dt', 'Usage'), h('dd', `${money(a.spentUsd)} of ${money(a.budgetUsd)} · ${(a.tokensIn + a.tokensOut).toLocaleString()} tokens`),
      h('dt', 'Availability'), h('dd', a.available ? 'on the floor' : a.paused ? 'paused' : 'unavailable — owner’s worker offline or owner away'),
      h('dt', 'Host'), h('dd', 'online (you are connected to it)')),
    h('div.cr-actions',
      h('button.btn.primary', { onclick: () => assignTask(a) }, 'Assign Task'),
      mine ? h('button.btn', { onclick: () => { ui.channelId = d?.dmChannelId; if (ui.channelId) { if (!S.channels.find((c) => c.id === ui.channelId)) S.channels.push({ id: ui.channelId, kind: 'dm', name: 'dm', dmAgentId: a.id }); openSide('chat'); } } }, 'Chat') : null,
      mine ? (a.paused ? h('button.btn', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/agents/${a.id}/resume`), `${a.name} resumed`) }, 'Resume') : h('button.btn', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/agents/${a.id}/pause`), `${a.name} paused`) }, 'Pause')) : null,
      h('button.btn', { onclick: () => { ui.agentTab = 'work'; render(); } }, 'View Work'),
      h('button.btn', { onclick: () => { ui.agentTab = 'messages'; render(); } }, 'View Messages'),
      mine ? h('button.btn', { onclick: () => agentForm(a) }, 'Configure Agent') : null,
      mine ? h('button.btn.danger', { onclick: () => confirm(`Remove ${a.name}? Its history stays; it leaves the office.`) && act(() => api('DELETE', `/api/crew/rooms/${roomId}/agents/${a.id}`), 'Agent removed') }, 'Remove') : null),
    mine && a.instructions ? h('details', h('summary', 'Instructions (only you see these)'), h('pre', a.instructions)) : null);
  if (!d) body.append(h('p.hint', 'Loading history…'));
  else if (ui.agentTab === 'messages') body.append(h('h3', 'Messages'), h('div.cr-list', ...(d.messages.length ? d.messages.slice().reverse().map(messageView) : [h('p.hint', 'No messages yet.')])));
  else {
    body.append(h('h3', 'Projects'), h('p', d.projects.map((p) => `${p.name} (${p.status})`).join(', ') || '—'));
    body.append(h('h3', 'Task history'), h('div.cr-list', ...(d.tasks.length ? d.tasks.map((t) => h('div.cr-item.click', { onclick: () => taskDetail(t) }, h('div.row', h('b.grow', t.title), h('span.pill', t.status)), t.resultSummary ? h('div.hint', t.resultSummary.slice(0, 200)) : null)) : [h('p.hint', 'No tasks yet.')])));
    body.append(h('h3', 'Executions'), h('div.cr-list', ...d.jobs.slice(0, 12).map((j) => h('div.cr-item.click.row', { onclick: () => jobLogs(j) }, h('span.grow', `${j.type} · ${j.status}`), h('span.hint', ago(j.updatedAt)), j.error ? h('span.pill.bad', 'error') : null))));
  }
  ui.side.replaceChildren(h('header', h('h2', 'AI employee'), h('button.btn.small', { onclick: () => openSide('chat') }, 'Chat'), h('button.btn.small', { onclick: () => ui.side.classList.add('hidden'), 'aria-label': 'Close' }, '✕')), body);
}

// --- forms ----------------------------------------------------------------------

async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, 6000); return null; }
}

function field(label, el, hint) { return [h('label', label), el, hint ? h('div.hint', hint) : null]; }

function agentForm(existing = null) {
  const a = existing ?? {};
  return modal(existing ? `Configure ${a.name}` : 'New AI employee', (close) => {
    const name = h('input', { value: a.name ?? '' });
    const role = h('input', { value: a.role ?? '', placeholder: 'e.g. Backend Developer' });
    const skills = h('input', { value: (a.skills ?? []).join(', '), placeholder: 'node, api, testing' });
    const instructions = h('textarea', { value: a.instructions ?? '', placeholder: 'Standing instructions: how this agent should work. Only you can see these.' });
    const provider = h('select', ...Object.entries(S.providers).map(([k, p]) => h('option', { value: k, selected: (a.provider ?? 'chatgpt-plan') === k }, p.label)));
    const model = h('input', { value: a.model ?? S.providers[a.provider ?? 'chatgpt-plan']?.defaultModel ?? '' });
    const models = h('div.hint');
    const note = h('div.cr-provider-note');
    const showModels = () => {
      const p = S.providers[provider.value];
      models.textContent = p.models.length ? `Models: ${p.models.join(', ')}` : 'Use the model name your local server serves.';
      note.textContent = p.subscription
        ? `Your own plan, on your own computer; no per-token bill, and your plan’s limits apply. ${p.setup}`
        : p.billing === 'paid' ? 'Billed per token to your API key. Agents on this will not run until you turn off “Never use paid API” on your own worker. It is on by default.'
          : provider.value === 'scripted' ? 'Not an AI model: fixed scripts, for demos and tests.' : 'A model running on your own computer.';
      if (!existing || provider.value !== a.provider) model.value = p.defaultModel;
    };
    provider.addEventListener('change', showModels);
    showModels();
    if (existing) model.value = a.model;
    const color = h('input', { type: 'color', value: a.color ?? '#3d85c6' });
    const budget = h('input', { type: 'number', min: 0, step: 0.5, value: a.budgetUsd ?? 5 });
    const autonomy = h('select', h('option', { value: 'auto', selected: a.autonomy !== 'ask' }, 'Act within its permissions'), h('option', { value: 'ask', selected: a.autonomy === 'ask' }, 'Ask me before writing files, running code or fetching'));
    const manager = h('input', { type: 'checkbox', checked: Boolean(a.isManager) });
    const tools = Object.entries(S.permissions).map(([k, label]) => { const c = h('input', { type: 'checkbox', value: k, checked: (a.tools ?? ['messaging', 'files.read', 'files.write', 'memory', 'git']).includes(k) }); return { k, c, el: h('label', c, h('span', h('b', k), ' — ', label)) }; });
    const presetSel = h('select', { onchange: (e) => {
      const pr = presets.find((x) => x.id === e.target.value);
      if (!pr) return;
      role.value = pr.role; skills.value = pr.skills.join(', '); instructions.value = pr.instructions;
      for (const t of tools) t.c.checked = pr.tools.includes(t.k);
      manager.checked = pr.name === 'Project Manager';
      if (!name.value) name.value = pr.name;
    } }, h('option', { value: '' }, 'Start from a preset…'));
    let presets = [];
    api('GET', `/api/crew/rooms/${roomId}/presets`).then((r) => { presets = r.presets; presetSel.append(...presets.map((x) => h('option', { value: x.id }, x.name))); }).catch(() => {});
    const err = h('p.error');
    const save = async () => {
      const body = { name: name.value, role: role.value, skills: skills.value, instructions: instructions.value, provider: provider.value, model: model.value, color: color.value, budgetUsd: Number(budget.value), autonomy: autonomy.value, isManager: manager.checked, tools: tools.filter((t) => t.c.checked).map((t) => t.k) };
      try {
        if (existing) await api('PATCH', `/api/crew/rooms/${roomId}/agents/${a.id}`, body);
        else await api('POST', `/api/crew/rooms/${roomId}/agents`, body);
        close(true);
        toast(existing ? 'Saved' : `${body.name} joins your team. It appears on the floor once your worker is connected.`);
      } catch (e) { err.textContent = e.message; }
    };
    return h('div', existing ? null : presetSel, ...field('Name', name), ...field('Role', role), ...field('Skills', skills, 'Comma-separated; used to match tasks.'), ...field('Instructions', instructions),
      h('div.row', h('div.grow', ...field('AI behind this agent', provider)), h('div.grow', ...field('Model', model))), models, note,
      h('div.row', h('div', ...field('Shirt colour', color)), h('div.grow', ...field('Budget (USD, total)', budget)), h('div.grow', ...field('Autonomy', autonomy))),
      h('label', manager, ' Can manage projects (plans and assigns work)'),
      h('label', 'Permissions (projects can narrow these further)'), h('div.cr-checks', ...tools.map((t) => t.el)),
      h('p.hint', 'API keys are not entered here. They live in your worker on your own computer.'),
      err, h('div.actions', h('button.btn', { onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onclick: save }, existing ? 'Save' : 'Create agent')));
  });
}

function newProject() {
  const mine = S.agents.filter((a) => a.ownerId === S.me.id);
  if (!mine.length) { toast('Create an agent first: every project needs one of your agents as its manager.'); return; }
  return modal('New project', (close) => {
    const name = h('input', { placeholder: 'Project Alpha' });
    const goal = h('textarea', { placeholder: 'Build a simple working task management web application.' });
    const mgr = h('select', ...mine.map((a) => h('option', { value: a.id, selected: a.isManager }, `${a.name} — ${a.role}`)));
    const err = h('p.error');
    const save = async () => {
      try {
        const { project } = await api('POST', `/api/crew/rooms/${roomId}/projects`, { name: name.value, goal: goal.value, managerAgentId: mgr.value });
        close(true);
        toast('Project created. Lend it agents, then start it.');
        grantAgents(project);
      } catch (e) { err.textContent = e.message; }
    };
    return h('div', ...field('Name', name), ...field('Goal', goal, 'The manager agent turns this into a plan of tasks for the team.'), ...field('Manager agent', mgr), err,
      h('div.actions', h('button.btn', { onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Create')));
  });
}

function grantAgents(p) {
  const mine = S.agents.filter((a) => a.ownerId === S.me.id);
  return modal(`Lend your agents to “${p.name}”`, (close) => {
    const rows = mine.map((a) => {
      const g = p.grants.find((x) => x.agentId === a.id);
      const on = h('input', { type: 'checkbox', checked: Boolean(g) });
      const budget = h('input', { type: 'number', min: 0, max: a.budgetUsd, step: 0.5, value: g?.budgetUsd ?? Math.min(2, a.budgetUsd), style: { width: '90px' } });
      const approval = h('input', { type: 'checkbox', checked: g ? g.requiresApproval : true });
      const tools = a.tools.map((t) => { const c = h('input', { type: 'checkbox', value: t, checked: g ? g.tools.includes(t) : true }); return { t, c, el: h('label', c, t) }; });
      return { a, g, on, budget, approval, tools, el: h('div.cr-item', h('label', on, h('b', ` ${a.name}`), ` — ${a.role}`),
        h('div.row', h('span.hint', 'Project budget $'), budget, h('label', { style: { margin: 0 } }, approval, ' work requested by others needs my approval')),
        h('div.cr-checks', ...tools.map((x) => x.el))) };
    });
    const err = h('p.error');
    const save = async () => {
      try {
        for (const r of rows) {
          if (r.on.checked) await api('POST', `/api/crew/rooms/${roomId}/projects/${p.id}/grants`, { agentId: r.a.id, budgetUsd: Number(r.budget.value), requiresApproval: r.approval.checked, tools: r.tools.filter((x) => x.c.checked).map((x) => x.t) });
          else if (r.g && r.a.id !== p.managerAgentId) await api('DELETE', `/api/crew/rooms/${roomId}/projects/${p.id}/grants/${r.a.id}`);
        }
        close(true);
        toast('Team updated');
      } catch (e) { err.textContent = e.message; }
    };
    return h('div', h('p.hint', 'You decide which of your agents join, what they may use here, how much they may spend, and whether work given to them by other players needs your approval.'),
      ...(rows.length ? rows.map((r) => r.el) : [h('p.hint', 'You have no agents yet.')]), err,
      h('div.actions', h('button.btn', { onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
  });
}

function newTask(p, agentId = null) {
  return modal(`Add a task to “${p.name}”`, (close) => {
    const title = h('input');
    const desc = h('textarea', { placeholder: 'What done looks like' });
    const kind = h('select', h('option', { value: 'work' }, 'Work'), h('option', { value: 'review' }, 'Review'));
    const team = p.grants.map((g) => agentById(g.agentId)).filter(Boolean);
    const who = h('select', h('option', { value: '' }, 'Best fit (by role and skills)'), ...team.map((a) => h('option', { value: a.id, selected: a.id === agentId }, `${a.name} — ${a.role} (${a.ownerName})`)));
    const deps = S.tasks.filter((t) => t.projectId === p.id && t.kind !== 'plan').map((t) => { const c = h('input', { type: 'checkbox', value: t.id }); return { c, el: h('label', c, t.title) }; });
    const err = h('p.error');
    const save = async () => {
      try {
        await api('POST', `/api/crew/rooms/${roomId}/projects/${p.id}/tasks`, { title: title.value, description: desc.value, kind: kind.value, agentId: who.value || undefined, deps: deps.filter((d) => d.c.checked).map((d) => d.c.value) });
        close(true);
        toast('Task added');
      } catch (e) { err.textContent = e.message; }
    };
    return h('div', ...field('Title', title), ...field('Description', desc), h('div.row', h('div.grow', ...field('Kind', kind)), h('div.grow', ...field('Assign to', who))),
      deps.length ? [h('label', 'Depends on'), h('div.cr-checks', ...deps.map((d) => d.el))] : null,
      h('p.hint', 'Assigning another player’s agent may need their approval before it starts.'), err,
      h('div.actions', h('button.btn', { onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Add task')));
  });
}

function assignTask(a) {
  const projects = S.projects.filter((p) => p.grants.some((g) => g.agentId === a.id) && p.members.includes(S.me.id));
  if (!projects.length) { toast(`${a.name} is not on any project you are in. Its owner lends it to a project first.`); return; }
  if (projects.length === 1) return newTask(projects[0], a.id);
  return modal(`Assign ${a.name} to…`, (close) => h('div.cr-list', ...projects.map((p) => h('button.btn', { onclick: () => { close(); newTask(p, a.id); } }, p.name))));
}

function taskDetail(t) {
  return modal(t.title, (close) => h('div',
    h('p', h('span.pill', t.kind), ' ', h('span.pill', t.status), ' ', t.assignedAgentName ? `→ ${t.assignedAgentName}` : 'unassigned'),
    t.description ? h('p', t.description) : null,
    t.deliverables.length ? h('p.hint', `Expected: ${t.deliverables.join(', ')}`) : null,
    t.resultSummary ? [h('h3', 'Result'), h('pre', t.resultSummary)] : null,
    t.artifacts.length ? [h('h3', 'Files'), ...t.artifacts.map((f) => h('div', h('button.btn.small', { onclick: () => { close(); viewFile(t.projectId, f.path); } }, f.path)))] : null,
    t.pausedReason ? h('p', h('b', 'Paused: '), t.pausedReason) : null,
    h('p.hint', `Attempts ${t.attempts}/${t.maxAttempts} · ${t.tokens.toLocaleString()} tokens · ${money(t.actualCost)}`),
    h('label', 'Estimated budget for this task'),
    h('div.row', h('input', { type: 'number', min: 1, max: 100, value: t.budgetPct ?? '', placeholder: 'none', style: { width: '90px' }, onchange: (e) => act(() => api('POST', `/api/crew/rooms/${roomId}/tasks/${t.id}/budget`, { pct: e.target.value || null }), 'Saved') }), h('span.hint', '% of the owner’s own estimate. Best effort: providers do not report remaining allowance, so this is not an exact ceiling.')),
    h('div.actions',
      ['failed', 'blocked', 'cancelled'].includes(t.status) ? h('button.btn', { onclick: () => { close(); act(() => api('POST', `/api/crew/rooms/${roomId}/tasks/${t.id}/retry`), 'Retrying'); } }, 'Retry') : null,
      !['completed', 'failed', 'cancelled'].includes(t.status) ? h('button.btn.danger', { onclick: () => { close(); act(() => api('POST', `/api/crew/rooms/${roomId}/tasks/${t.id}/cancel`), 'Cancelled'); } }, 'Cancel task') : null,
      h('button.btn', { onclick: () => close() }, 'Close'))));
}

async function viewFile(projectId, path) {
  const res = await fetch(`/api/crew/rooms/${roomId}/projects/${projectId}/files/${path.split('/').map(encodeURIComponent).join('/')}`);
  const text = await res.text();
  modal(path, (close) => h('div', h('pre', text), h('div.actions', h('button.btn', { onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy'), h('button.btn', { onclick: () => close() }, 'Close'))));
}

async function jobLogs(j) {
  const { logs } = await api('GET', `/api/crew/rooms/${roomId}/jobs/${j.id}/logs`);
  modal(`Execution log · ${j.type} · ${j.status}`, (close) => h('div', h('pre', logs.map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.text}`).join('\n') || 'No log lines.'), j.error ? h('p.error', j.error) : null, h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'))));
}

function connectWorker() {
  return modal('Connect a worker', (close) => {
    const name = h('input', { value: `${S.me.displayName}'s computer` });
    const always = h('input', { type: 'checkbox' });
    const out = h('div');
    const go = async () => {
      const { worker } = await api('POST', `/api/crew/rooms/${roomId}/workers`, { name: name.value, alwaysOn: always.checked });
      const host = location.origin;
      const cmd = `node bin/crew-worker.cjs --host ${host} --token ${worker.token}`;
      out.replaceChildren(
        h('p', 'Run this in the app folder on the computer whose API keys should pay for your agents. The token is shown once.'),
        h('pre', cmd), h('button.btn.small', { onclick: () => navigator.clipboard?.writeText(cmd).then(() => toast('Copied')) }, 'Copy command'),
        h('p.hint', 'Then open http://127.0.0.1:8790 on that computer to add your provider keys. They stay on that computer.'),
        host.includes('localhost') || host.includes('127.0.0.1') ? h('p.hint', 'From another computer, replace the address with this host’s network address.') : null);
      render();
    };
    return h('div', ...field('Worker name', name), h('label', always, ' Always-on (a server): keep my agents available when I leave the office'),
      h('p.hint', 'An attended worker (the default) only runs your agents while you have the office open.'), out,
      h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'), h('button.btn.primary', { onclick: go }, 'Create token')));
  });
}

function invite() {
  return modal('Invitation link', (close) => {
    const role = h('select', h('option', { value: 'member' }, 'Member — brings agents, joins projects'), h('option', { value: 'guest' }, 'Guest — watches and chats'), S.room.myRole === 'owner' ? h('option', { value: 'admin' }, 'Admin — manages players') : null);
    const uses = h('input', { type: 'number', value: 5, min: 1, max: 100 });
    const out = h('div');
    const go = async () => {
      const { invite: inv } = await api('POST', `/api/crew/rooms/${roomId}/invites`, { role: role.value, uses: Number(uses.value) });
      const bases = [location.origin, ...(S.host.lanAddresses ?? []).map((a) => `http://${a}:${S.host.port}`)];
      out.replaceChildren(h('p', 'Share one of these (valid for 72 hours):'), ...[...new Set(bases)].map((b) => h('pre', `${b}/crew/join?invite=${inv.code}`)));
    };
    return h('div', ...field('Role', role), ...field('Uses', uses), out, h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'), h('button.btn.primary', { onclick: go }, 'Create link')));
  });
}

function roomSettings() {
  return modal('Office settings', (close) => {
    const name = h('input', { value: S.room.name });
    const privacy = h('select', ...[['password', 'Password'], ['invite', 'Invite only'], ['lan', 'Open']].map(([v, l]) => h('option', { value: v, selected: S.room.privacy === v }, l)));
    const pass = h('input', { type: 'password', placeholder: S.room.hasPassword ? 'Leave empty to keep the current password' : 'New password' });
    const max = h('input', { type: 'number', value: S.room.maxPlayers, min: 1, max: 32 });
    const err = h('p.error');
    const save = async () => {
      try { await api('PATCH', `/api/crew/rooms/${roomId}/settings`, { name: name.value, privacy: privacy.value, maxPlayers: Number(max.value), ...(pass.value ? { password: pass.value } : {}) }); close(true); toast('Saved'); } catch (e) { err.textContent = e.message; }
    };
    return h('div', ...field('Name', name), ...field('Privacy', privacy), ...field('Password', pass), ...field('Max players', max), err, h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
  });
}

function profile() {
  return modal('Your profile', (close) => {
    const name = h('input', { value: S.me.displayName });
    const color = h('input', { type: 'color', value: S.me.color });
    const save = async () => { const { user } = await api('PATCH', '/api/crew/me', { displayName: name.value, color: color.value }); S.me = user; close(); toast('Saved'); render(); };
    return h('div', ...field('Display name', name), ...field('Avatar colour', color), h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
  });
}

function newChannel() {
  return modal('New channel', (close) => {
    const name = h('input', { placeholder: 'project-alpha' });
    const save = async () => { const r = await act(() => api('POST', `/api/crew/rooms/${roomId}/channels`, { name: name.value.trim() })); if (r) { upsert(S.channels, r.channel); ui.channelId = r.channel.id; close(); render(); } };
    return h('div', ...field('Name', name, 'Lowercase letters, digits and dashes.'), h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Create')));
  });
}

function searchMessages() {
  return modal('Search messages', () => {
    const q = h('input', { placeholder: 'Search every channel you can see' });
    const out = h('div.cr-list');
    q.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { const { messages } = await api('GET', `/api/crew/rooms/${roomId}/search?q=${encodeURIComponent(q.value)}`); out.replaceChildren(...(messages.length ? messages.map(messageView) : [h('p.hint', 'No matches.')])); } });
    return h('div', q, out);
  });
}

// --- bubbles and meetings over the 3D office --------------------------------------

let bubbleLayer = null;
let pillLayer = null;
/** agentId -> the latest { emoji, verb, target } the host reported for it. */
const activities = new Map();
const pills = new Map();

/** Before any live activity has arrived, the agent's status says what it is doing. */
const FROM_STATUS = {
  IDLE: ['💤', 'Idle'], ASSIGNED: ['📥', 'Assigned'], PLANNING: ['🗺️', 'Planning'], WORKING: ['🤔', 'Thinking'], WAITING: ['⏳', 'Waiting'],
  REVIEW: ['🔍', 'Reviewing'], COMPLETED: ['✅', 'Done'], FAILED: ['⚠️', 'Hit a problem'], PAUSED: ['⏸️', 'Paused'], BLOCKED: ['⛔', 'Out of budget'],
};

function pillText(a) {
  const live = activities.get(a.id);
  if (a.status === 'PAUSED' || a.status === 'BLOCKED' || (!live && FROM_STATUS[a.status])) {
    const [emoji, verb] = FROM_STATUS[a.status] ?? ['💤', 'Idle'];
    return { emoji, verb, target: null };
  }
  return live ?? { emoji: '💤', verb: 'Idle', target: null };
}
let meetingLayer = null;
const bubbles = [];
const meetings = new Map();

function charFor(agentId) {
  const world = window.officeView?.world;
  if (!world?.manager?.agents) return null;
  for (const { agent } of world.manager.agents.values()) if (String(agent.id).endsWith(`#crew:${agentId}`)) return agent;
  return null;
}

function screenOf(agentId, lift = 2.3) {
  const ch = charFor(agentId);
  const view = window.officeView;
  if (!ch || !view) return null;
  const cam = view.camera();
  const p = ch.root.getWorldPosition(new ch.root.position.constructor());
  p.y += lift;
  p.project(cam);
  if (p.z > 1) return null;
  const r = view.canvas.getBoundingClientRect();
  return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
}

function updatePills() {
  const here = new Set();
  for (const a of S.agents) {
    if (!a.available) continue;
    const at = screenOf(a.id, 2.2);
    if (!at) continue;
    here.add(a.id);
    let p = pills.get(a.id);
    if (!p) { p = { el: h('div.cr-status'), key: '' }; pills.set(a.id, p); pillLayer.append(p.el); }
    const t = pillText(a);
    const key = `${t.emoji}|${t.verb}|${t.target}|${a.color}`;
    if (key !== p.key) {
      p.key = key;
      p.el.style.setProperty('--who', a.color);
      p.el.replaceChildren(...[h('span.e', t.emoji), h('span', t.verb), t.target ? h('b', ` ${t.target}`) : null].filter(Boolean));
      p.el.classList.toggle('idle', t.verb === 'Idle');
    }
    p.el.style.left = `${Math.round(at.x)}px`;
    p.el.style.top = `${Math.round(at.y)}px`;
  }
  for (const [id, p] of pills) if (!here.has(id)) { p.el.remove(); pills.delete(id); }
}

function bubble(agentId, text, { to = null, react = false, ms = 7000 } = {}) {
  if (!bubbleLayer) return;
  const a = agentById(agentId);
  for (const b of bubbles.filter((x) => x.agentId === agentId)) b.until = 0;
  const el = h('div.cr-bubble', { class: react ? 'react' : '', style: { '--who': a?.color ?? '#3d6fd6' } }, to ? h('div.to', `to ${to}`) : null, text.length > 160 ? `${text.slice(0, 157)}…` : text);
  el.style.setProperty('--who', a?.color ?? '#3d6fd6');
  bubbleLayer.append(el);
  bubbles.push({ agentId, el, until: performance.now() + ms });
}

function tick(now) {
  requestAnimationFrame(tick);
  if (pillLayer) updatePills();
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const at = screenOf(b.agentId, 3.4);
    if (now > b.until || !at) {
      if (now > b.until + 400 || !at) { b.el.remove(); bubbles.splice(i, 1); } else b.el.classList.add('fade');
      continue;
    }
    b.el.style.left = `${at.x}px`;
    b.el.style.top = `${at.y}px`;
  }
  if (meetingLayer) {
    const lines = [];
    for (const [x, y] of meetings.values()) {
      const p = screenOf(x, 1.2);
      const q = screenOf(y, 1.2);
      if (p && q) lines.push(`<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#3d6fd6" stroke-width="3" stroke-dasharray="8 6" stroke-linecap="round" opacity="0.8"><animate attributeName="stroke-dashoffset" from="0" to="-28" dur="0.8s" repeatCount="indefinite"/></line>`);
    }
    const html = lines.join('');
    if (meetingLayer.__html !== html) { meetingLayer.innerHTML = html; meetingLayer.__html = html; }
  }
}
