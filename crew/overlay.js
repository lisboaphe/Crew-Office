// The multiplayer layer over the 3D office: who is here, the dashboard, chat, the agent
// control panel, and speech bubbles pinned above the characters.
//
// It loads with every office page and does nothing unless this office is a crew room.
// State comes from one snapshot plus a stream of events; a reconnect that missed too much
// is told to resync and fetches the snapshot again, so no state lives only in the page.

import { h, api, toast, modal, avatar, ago, money, helpTip, icon, confirmDeleteOffice, updateNotice, BRAND, reportErrors, characterPicker } from './common.js';
import { openTutorial, tutorialOnFirstVisit } from './tutorial.js';
import { gitTab, filesTab, rulesTab } from './workspace.js';
import { createAgentEditor } from './agent-editor.js';
import { createOrchestrator } from './orchestrator.js';
import { addWorkerWizard } from './wizard.js';
import { createSecurityCenter } from './security.js';
import { workerLink, connectionsView, usageView, usageBar } from './connections.js';
import { createNav } from './nav.js';
import { recallPanel, rememberPanel } from '../src/ui/panel-state.js';
import { createKnowledge } from './knowledge.js';

// Set before boot() runs below, which reads it straight away.
const ROSTER = 'agent-panel';
const code = (location.pathname.match(/^\/office\/([^/]+)/) ?? [])[1];
const S = { room: null, me: null, members: [], agents: [], projects: [], tasks: [], channels: [], approvals: [], notifications: [], workers: [], feed: [], artifacts: [], permissions: {}, providers: {}, host: {} };
let roomId = null;
let es = null;
const ui = { dash: null, side: null, bar: null, tab: 'projects', sideMode: 'chat', channelId: null, agentId: null, projectId: null, messages: new Map() };

boot().catch((err) => console.error('[crew]', err));

/** The person's own choices from Preferences. Dark glass is the default. */
function applyAppearance() {
  const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const root = document.documentElement;
  if (stored('crew.theme') === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
  if (stored('crew.motion') === 'off') root.dataset.motion = 'off'; else delete root.dataset.motion;
}

/**
 * The office's roster of who is on the floor. In a crew office it starts put away, because it
 * covers part of the room and the menu already lists the agents; whoever opens it keeps it open.
 */
function showRoster(open) {
  const roster = document.getElementById(ROSTER);
  if (!roster) return;
  roster.classList.toggle('hidden', !open);
  rememberPanel(ROSTER, open);
}

async function boot() {
  if (!code) return;
  applyAppearance();
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
  ui.ownerOfComputer = (await api('GET', '/api/crew/this-computer').catch(() => ({}))).owner === true;
  buildChrome();
  connect();
  // Choosing who you are comes first, then the tour.
  const chosen = S.me && S.me.character == null ? chooseCharacter({ first: true }) : Promise.resolve();
  chosen.then(() => tutorialOnFirstVisit({ showMe: tourShowMe }));
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
  // The browser retries by itself. This only tells the person, and refetches what was missed.
  es.addEventListener('error', () => { if (!ui.reconnecting) { ui.reconnecting = true; render(); } });
  es.addEventListener('open', () => { if (ui.reconnecting) { ui.reconnecting = false; refresh().catch(() => {}); } });
  const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  on('resync', () => refresh());
  // The owner gets the agent twice — the public view, then their own with the brief — in that order.
  on('agent', (a) => { upsert(S.agents, a); render(); });
  on('playbooks', () => ui.orchestrator?.changed());
  on('knowledge', (what) => ui.knowledge?.changed(what));
  on('safety', () => refresh());
  on('agent.removed', ({ id }) => { S.agents = S.agents.filter((a) => a.id !== id); render(); });
  on('room.deleted', () => { location.href = '/crew'; });
  on('members', ({ members }) => { S.members = members; render(); });
  on('project', (p) => { upsert(S.projects, p); render(); });
  on('task', (t) => { upsert(S.tasks, t); render(); });
  on('approval', (a) => { upsert(S.approvals, a); render(); });
  on('notification', (n) => {
    S.notifications.unshift(n);
    // Quiet mode holds back news, never decisions or problems: those still appear, and everything stays in the list.
    if (!quietMode() || n.level !== 'info') toast(n.text, 5000);
    render();
  });
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
    // Unread: anything on another channel, or anything at all while the chat is closed. Not mine.
    const watching = !ui.side.classList.contains('hidden') && ui.channelId === m.channelId;
    if (!watching && m.senderId !== S.me.id && m.senderType !== 'system') (ui.unread ??= new Map()).set(m.channelId, (ui.unread.get(m.channelId) ?? 0) + 1);
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
  // After the office's own start-up, which opens the roster by default and would undo this.
  document.getElementById(ROSTER)?.classList.toggle('hidden', !recallPanel(ROSTER, false));
  ui.bar = h('div.cr', { id: 'crew-bar' });
  ui.dash = h('section.cr.cr-drawer.left.hidden', { 'aria-label': 'Dashboard' });
  ui.side = h('section.cr.cr-drawer.right.hidden', { 'aria-label': 'Chat and agents' });
  bubbleLayer = h('div', { id: 'crew-bubbles' });
  pillLayer = h('div', { id: 'crew-pills' });
  meetingLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  meetingLayer.id = 'crew-meetings';
  ui.orchestrator = createOrchestrator(editorContext());
  ui.editor = createAgentEditor(editorContext());
  ui.security = createSecurityCenter(editorContext());
  // The bookshelf in each room of the office opens this. It is the same Files page as the menu's.
  window.crewOpenFiles = () => openDash('files');
  // Who the office should show as here, and how to change your own character.
  window.crewPlayers = () => S.members
    .filter((m) => m.online || m.userId === S.me?.id)
    .map((m) => ({ id: m.userId, name: m.displayName, character: m.userId === S.me?.id ? S.me.character ?? m.character : m.character }));
  // Every agent in the office, including those whose worker is not running yet: they have a desk too.
  window.crewAgents = () => S.agents.map((a) => ({ id: a.id, name: a.name, color: a.color, ownerId: a.ownerId, ownerName: a.ownerName }));
  window.crewChooseCharacter = (userId) => {
    if (userId !== S.me?.id) return false;
    chooseCharacter();
    return true;
  };
  ui.knowledge = createKnowledge({ ...editorContext(), setTab: (tab) => { ui.tab = tab; render(); } });
  ui.nav = createNav({
    groups: NAV,
    current: () => (ui.dash.classList.contains('hidden') ? 'office3d' : navKeyFor(ui.tab)),
    badgeOf: (key) => (key === 'approvals' ? S.approvals.filter((a) => a.status === 'pending' && a.approverId === S.me.id).length : 0),
    onGo: goTo,
  });
  document.body.append(meetingLayer, pillLayer, bubbleLayer, ui.bar, ui.nav.el, ui.dash, ui.side, ui.editor.el);
  window.addEventListener('resize', fitTopBars);
  // The office's own bar fills in as its parts load, and changes as offices do.
  const titleBar = document.getElementById('title-bar');
  const refit = new ResizeObserver(() => requestAnimationFrame(fitTopBars));
  if (titleBar) refit.observe(titleBar);
  refit.observe(ui.bar); // as the update button arrives, for one
  render();
}

let renderQueued = false;
function render() {
  if (renderQueued || !ui.bar) return;
  renderQueued = true;
  const draw = () => {
    if (!renderQueued) return;
    renderQueued = false;
    renderBar();
    closeStrayTours();
    ui.nav.refresh();
    if (!ui.dash.classList.contains('hidden')) renderDash();
    if (!ui.side.classList.contains('hidden')) renderSide();
    ui.editor?.refresh();
  };
  // A frame when one is coming; the timer for a hidden or background window, which gets none.
  requestAnimationFrame(draw);
  setTimeout(draw, 250);
}

function renderBar() {
  const pending = S.approvals.filter((a) => a.status === 'pending' && a.approverId === S.me.id).length;
  const unread = S.notifications.filter((n) => !n.read).length;
  const players = h('div.players', { title: 'Players' }, ...S.members.map((m) => avatar(m.displayName, m.color, { online: m.online, title: `${m.displayName} (${m.role})${m.online ? ' — here' : ''}` })));
  ui.bar.replaceChildren(
    h('span.room-name', S.room.name, S.room.status !== 'open' ? ' · stopped' : ''),
    connectionPill(),
    players,
    updateNotice(),
    h('button.btn.cr-icon-btn', { class: dashShows('approvals') ? 'on' : '', 'aria-pressed': String(dashShows('approvals')), onclick: () => toggleDash('approvals'), title: 'Approvals', 'aria-label': pending ? `Approvals, ${pending} waiting` : 'Approvals' }, icon('check'), pending ? h('span.badge', pending) : null),
    h('button.btn.cr-icon-btn', { class: dashShows('notifications') ? 'on' : '', 'aria-pressed': String(dashShows('notifications')), onclick: () => toggleDash('notifications'), title: 'Notifications', 'aria-label': unread ? `Notifications, ${unread} unread` : 'Notifications' }, icon('bell'), unread ? h('span.badge', unread) : null),
    h('button.btn', { class: ui.side.classList.contains('hidden') ? '' : 'on', onclick: toggleChat, 'aria-pressed': ui.side.classList.contains('hidden') ? 'false' : 'true' }, icon('chat'), h('span.cr-says-less', 'Chat'), unreadTotal() ? h('span.cr-count', unreadTotal()) : null),
    stopButton(),
    h('button.btn.cr-icon-btn', { onclick: () => openTutorial({ showMe: tourShowMe }), title: 'How it works: a short tour', 'aria-label': 'How it works' }, '?'),
  );
  fitTopBars();
}

const TOP_GAP = 12;
const FIT_LEVELS = 3;

/**
 * Keeps the office's bar and ours side by side at any window width: each level says less, until they
 * share one row. If even the shortest will not fit, ours wraps onto more rows rather than overlapping.
 * Below the phone layout, the two have rows of their own and nothing needs fitting.
 */
function fitTopBars() {
  const title = document.getElementById('title-bar');
  const root = document.documentElement;
  if (!title || !ui.bar?.isConnected) return;
  if (window.matchMedia('(max-width: 760px)').matches) {
    delete root.dataset.topFit;
    ui.bar.style.maxWidth = '';
    return;
  }
  for (let level = 0; level <= FIT_LEVELS; level++) {
    root.dataset.topFit = level;
    ui.bar.style.maxWidth = `${Math.max(0, window.innerWidth - title.getBoundingClientRect().right - TOP_GAP * 2)}px`;
    // One row: nothing starts below where the first item ends, whatever their different heights.
    const items = [...ui.bar.children].filter((item) => item.offsetWidth > 0);
    const firstEnd = items[0]?.getBoundingClientRect().bottom ?? 0;
    if (items.every((item) => item.getBoundingClientRect().top < firstEnd)) return;
  }
}

// Where the launcher goes. Each destination is an existing tab of the dashboard, so nothing here
// is a second way of doing anything; `office3d` is the office itself, with everything put away.
const NAV = [
  { key: 'workspace', label: 'Workspace', icon: 'workspace', items: [
    { key: 'office3d', label: 'Office', icon: 'building', hint: 'Close the panels and watch the floor' },
    { key: 'roster', label: 'Agent roster', icon: 'agents', hint: 'Show or hide the list of everyone on the floor' },
    { key: 'projects', label: 'Projects', icon: 'folder' },
    { key: 'board', label: 'Task Board', icon: 'board' },
    { key: 'files', label: 'Files', icon: 'file' },
    { key: 'git', label: 'Git & Sync', icon: 'git' },
  ] },
  { key: 'ai', label: 'AI Management', icon: 'ai', items: [
    { key: 'agents', label: 'Agents', icon: 'agents' },
    { key: 'playbooks', label: 'Orchestrator', icon: 'orchestrator' },
    { key: 'connections', label: 'AI Connections', icon: 'connections' },
    { key: 'usage', label: 'Usage & Quotas', icon: 'usage' },
    { key: 'memory', label: 'Memory & Knowledge', icon: 'memory' },
  ] },
  { key: 'multiplayer', label: 'Multiplayer', icon: 'multiplayer', items: [
    { key: 'room', label: 'Host / Join', icon: 'door', hint: 'This office, its code, invitations and settings' },
    { key: 'friends', label: 'Friends', icon: 'multiplayer', hint: 'Who is in this office, and inviting more' },
    { key: 'teams', label: 'Shared Teams', icon: 'agents' },
    { key: 'security', label: 'Office Security', icon: 'security' },
  ] },
  { key: 'settings', label: 'Settings', icon: 'settings', items: [
    { key: 'plugins', label: 'Plugins', icon: 'plugin', hint: 'Mem0 and Graphify: what is installed, and what is on' },
    { key: 'rules', label: 'Working Rules', icon: 'rules' },
    { key: 'prefs', label: 'Preferences', icon: 'sliders' },
    { key: 'feed', label: 'Activity Logs', icon: 'logs' },
    { key: 'approvals', label: 'Approvals', icon: 'check' },
  ] },
];
const NAV_KEYS = new Set(NAV.flatMap((g) => g.items.map((i) => i.key)));
/** A tab with no entry of its own lights up the entry for the page it lives on. */
const NAV_PARENT = { crew: 'agents', runs: 'playbooks', costs: 'usage', deliverables: 'projects', graph: 'memory', notifications: 'approvals' };
const navKeyFor = (tab) => (NAV_KEYS.has(tab) ? tab : NAV_PARENT[tab] ?? null);

function goTo(key) {
  if (key === 'roster') { showRoster(document.getElementById(ROSTER)?.classList.contains('hidden')); return; }
  if (key === 'office3d') { ui.dash.classList.add('hidden'); ui.editor.close?.(); render(); return; }
  // On a tab within this destination, as much as on the destination itself.
  if (!ui.dash.classList.contains('hidden') && navKeyFor(ui.tab) === key) { ui.dash.classList.add('hidden'); render(); return; }
  toggleDash(key);
}

function toggleChat() {
  if (ui.side.classList.contains('hidden')) openSide('chat');
  else { ui.side.classList.add('hidden'); document.body.classList.remove('cr-chat-open'); render(); }
}

/** Messages that arrived while their channel was not on screen. */
const unreadTotal = () => [...(ui.unread?.values() ?? [])].reduce((a, b) => a + b, 0);

/** "Show me" from the tour: open the dashboard on the tab that step is about. */
function tourShowMe(tab) {
  ui.tab = tab;
  ui.dash.classList.remove('hidden');
  render();
}

const dashShows = (tab) => !ui.dash.classList.contains('hidden') && ui.tab === tab;

/** A second click on what is already open closes it, and a click on anything else goes there. */
function toggleDash(tab) {
  if (dashShows(tab)) {
    ui.dash.classList.add('hidden');
    render();
    return;
  }
  openDash(tab);
}

function openDash(tab) {
  ui.tab = tab;
  ui.dash.classList.remove('hidden');
  if (tab === 'notifications') api('POST', `/api/crew/rooms/${roomId}/notifications/read`).then(() => { S.notifications.forEach((n) => { n.read = true; }); render(); });
  render();
}

// --- dashboard --------------------------------------------------------------

// Six places to go, with what belongs together inside each. Each remembers which tab was open.
const SECTIONS = [
  { key: 'office', label: 'Office', tabs: [['room', 'Overview'], ['friends', 'Friends'], ['teams', 'Teams'], ['rules', 'Working rules']] },
  { key: 'activity', label: 'Activity', tabs: [['feed', 'Live feed'], ['approvals', 'Approvals'], ['notifications', 'Notifications']] },
  { key: 'prefs', label: 'Preferences', tabs: [['prefs', 'Preferences']] },
  { key: 'agents', label: 'Agents', tabs: [['agents', 'Directory'], ['crew', 'My Crew']] },
  { key: 'orchestrator', label: 'Orchestrator', tabs: [['playbooks', 'Playbooks'], ['runs', 'Runs']] },
  { key: 'projects', label: 'Projects', tabs: [['projects', 'Projects'], ['board', 'Task board'], ['git', 'Git / Sync'], ['files', 'Office files'], ['deliverables', 'Deliverables']] },
  { key: 'knowledge', label: 'Memory & Knowledge', tabs: [['memory', 'Memory'], ['graph', 'Code graph'], ['plugins', 'Plugins']] },
  { key: 'connections', label: 'Connections', tabs: [['connections', 'AI connections']] },
  { key: 'usage', label: 'Usage', tabs: [['usage', 'Plan usage'], ['costs', 'Task costs']] },
  { key: 'security', label: 'Security', tabs: [['security', 'Security Center']] },
];
const sectionOf = (tab) => SECTIONS.find((s) => s.tabs.some(([k]) => k === tab)) ?? SECTIONS[0];
const onThisComputer = () => ['localhost', '127.0.0.1'].includes(location.hostname);
const localWorker = () => workerLink(`http://127.0.0.1:${S.host?.workerPort ?? 8790}`);

/** A guided tour of a page must not outlive the page. */
function closeStrayTours() {
  const onOrchestrator = !ui.dash.classList.contains('hidden') && ['playbooks', 'runs'].includes(ui.tab);
  if (!onOrchestrator) ui.orchestrator?.closeTour();
}

function renderDash() {
  // These hold their own state and update themselves. A half-drawn playbook, its zoom and a
  // connection card's progress all survive the office's updates by simply not being redrawn.
  if (['playbooks', 'runs', 'connections', 'usage', 'security', 'memory', 'graph', 'plugins'].includes(ui.tab) && ui.dash.dataset.tab === ui.tab) return;
  const body = h('div.body');
  const wsCtx = { S, roomId, ui, render, taskDetail };
  const section = sectionOf(ui.tab);
  (ui.lastTab ??= {})[section.key] = ui.tab;
  ({ memory: (b) => b.append(ui.knowledge.showMemory()), graph: (b) => { b.classList.add('cr-fill'); b.append(ui.knowledge.showGraph()); }, plugins: (b) => b.append(ui.knowledge.showPlugins()), friends: dashFriends, prefs: dashPrefs, git: (b) => gitTab(b, wsCtx), files: (b) => filesTab(b, wsCtx), rules: (b) => rulesTab(b, wsCtx), projects: dashProjects, board: dashBoard, agents: dashAgents, teams: dashTeams, feed: dashFeed, deliverables: dashDeliverables, approvals: dashApprovals, costs: dashCosts, crew: dashCrew, notifications: dashNotifications, room: dashRoom, connections: dashConnections, usage: dashUsage, playbooks: (b) => b.append(ui.orchestrator.showEditor()), runs: (b) => b.append(ui.orchestrator.showRuns()), security: (b) => b.append(ui.security.show()) })[ui.tab](body);
  // Only a real change of place animates: the office repaints this on every event.
  if (ui.drawnTab !== ui.tab) { body.classList.add('cr-fade'); ui.drawnTab = ui.tab; }
  const scroll = ui.dash.querySelector('.body')?.scrollTop ?? 0;
  ui.dash.dataset.tab = ui.tab;
  ui.dash.replaceChildren(
    h('div.cr-dash-main',
      h('header', h('h2', section.label), h('button.btn.small', { onclick: () => { ui.dash.classList.add('hidden'); render(); }, 'aria-label': 'Close' }, '✕')),
      section.tabs.length > 1 ? h('nav.cr-tabs', { role: 'tablist' }, ...section.tabs.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': ui.tab === k ? 'true' : 'false', class: ui.tab === k ? 'on' : '', onclick: () => { ui.tab = k; render(); } }, label))) : null,
      body));
  if (ui.drawnScrollTab === ui.tab) body.scrollTop = scroll;
  ui.drawnScrollTab = ui.tab;
}

const agentById = (id) => S.agents.find((a) => a.id === id);
const userById = (id) => S.members.find((m) => m.userId === id);
const STATUS_COLOR = { IDLE: '#8d99ae', ASSIGNED: '#3d85c6', PLANNING: '#9b5de5', WORKING: '#2a8a4a', WAITING: '#c27c0e', REVIEW: '#00a3b4', COMPLETED: '#2a8a4a', FAILED: '#c0392b', PAUSED: '#8d99ae', BLOCKED: '#c0392b', OFFLINE: '#b9bfcb', CANCELLED: '#8d99ae' };
const statusPill = (s) => h('span.pill', { style: { color: STATUS_COLOR[s] ?? 'inherit' } }, h('span.dot', { style: { background: STATUS_COLOR[s] ?? '#999' } }), s === 'PAUSED' ? 'ON HOLIDAY' : s);

// The same two actions wherever an agent appears. Holiday keeps its tasks for when it is back;
// firing takes them off it. Changing a name needs neither: Configure Agent does that.
const holidayButton = (a, cls = 'button.btn') => h(cls, { onclick: (e) => { e.stopPropagation(); act(() => api('POST', `/api/crew/rooms/${roomId}/agents/${a.id}/${a.paused ? 'resume' : 'pause'}`), a.paused ? `${a.name} is back` : `${a.name} is on holiday`); } }, a.paused ? 'Back from holiday' : 'Send on holiday');
const fireButton = (a, cls = 'button.btn.danger') => h(cls, { onclick: (e) => { e.stopPropagation(); if (confirm(`Fire ${a.name}? They leave the office and their unfinished tasks are unassigned. Their past work and messages stay. This cannot be undone.\n\nOnly want a new name? Cancel and use Configure Agent.`)) act(() => api('DELETE', `/api/crew/rooms/${roomId}/agents/${a.id}`), `${a.name} has been fired`); } }, 'Fire');

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

/** The narrowest reported limit, for an agent card. Nothing at all when none was reported. */
function agentUsage(a) {
  if (a.ownerId !== S.me.id) return null;
  const windows = Object.values(ui.usageData?.reported?.[a.provider]?.windows ?? {});
  if (!windows.length) return null;
  const top = Math.max(...windows.map((w) => w.usedPercent));
  return h('div.cr-card-usage', { title: `${Math.round(top)}% of a limit used, as the provider reports it` }, usageBar(top, { small: true }));
}

function dashAgents(body) {
  const search = h('input', { type: 'search', placeholder: 'Search agents, roles or owners', 'aria-label': 'Search agents', value: ui.agentQuery ?? '' });
  const rows = S.agents.map((a) => {
    const row = h('div.cr-item.click.row', { onclick: () => openAgent(a.id), onkeydown: (e) => { if (e.key === 'Enter') openAgent(a.id); }, tabIndex: 0, role: 'button' },
      avatar(a.name, a.color, { ai: true, online: a.available }), h('div.grow', h('b', a.name), ' ', h('span.muted', a.role), h('div.hint', `${a.ownerName}${a.ownerId === S.me.id ? ' (you)' : ''} · ${S.providers[a.provider]?.label ?? a.provider}`), agentUsage(a)),
      statusPill(a.status));
    row.dataset.search = `${a.name} ${a.role} ${a.ownerName} ${a.skills.join(' ')}`.toLowerCase();
    return row;
  });
  const filter = () => { const q = search.value.trim().toLowerCase(); ui.agentQuery = search.value; for (const r of rows) r.hidden = Boolean(q) && !r.dataset.search.includes(q); };
  search.addEventListener('input', filter);
  filter();
  body.append(h('div.row', h('div.grow', search), S.room.myRole !== 'guest' ? h('button.btn.primary', { onclick: () => addWorkerWizard(editorContext()) }, 'Add an agent') : null));
  body.append(h('div.cr-list', { style: { marginTop: '12px' } }, ...rows));
  if (!S.agents.length) body.append(h('p.hint', 'No agents yet. Add an agent to put someone on the floor.'));
  if (ui.agentQueryFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  search.addEventListener('focus', () => { ui.agentQueryFocus = true; });
  search.addEventListener('blur', () => { ui.agentQueryFocus = false; });
}

const startMyWorker = (reload) => h('button.btn.primary', { onclick: async () => {
  try { await api('POST', `/api/crew/rooms/${roomId}/workers/start-here`, { name: 'This computer' }); await refresh(); reload(); } catch (e) { toast(e.message, 6000); }
} }, 'Start my worker');
const noWorker = (reload) => (ui.ownerOfComputer ? startMyWorker(reload)
  : h('p.hint', 'Open ', h('a', { href: 'http://127.0.0.1:8790', target: '_blank', rel: 'noopener' }, 'your worker’s page'), ' on your own computer. It has this same screen. This office cannot reach your worker, on purpose: its page comes from someone else’s computer.'));

function dashConnections(body) {
  ui.connectionsView ??= connectionsView(localWorker(), { offline: noWorker, onChange: () => refreshUsage() });
  body.append(ui.connectionsView);
  ui.connectionsView.reload();
}

function dashUsage(body) {
  ui.usageView = usageView(localWorker(), { offline: noWorker, agents: S.agents.filter((a) => a.ownerId === S.me.id) });
  body.append(ui.usageView);
}

async function refreshUsage() {
  if (!onThisComputer()) return null;
  try { ui.usageData = await localWorker().get('/usage'); } catch { ui.usageData = null; }
  return ui.usageData;
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
      h('div', { style: { textAlign: 'right' } }, h('b', S.providers[a.provider]?.billing === 'subscription' ? 'Plan' : `${money(a.spentUsd)} / ${money(a.budgetUsd)}`), h('div.hint', `${(a.tokensIn + a.tokensOut).toLocaleString()} tokens`)));
  })));
  body.append(h('p.hint', 'Costs are computed on each owner’s worker from the provider’s reported token usage and a price table; local and unpriced models count as $0.'));
}

function dashCrew(body) {
  body.append(h('div.row', h('h2.grow', 'My Crew'),
    h('button.btn.primary', { onclick: () => addWorkerWizard(editorContext()) }, 'Add an agent'),
    helpTip('How to add a worker', [
      'Press Add an agent and choose what they should do.',
      'Choose an AI. The app checks this computer for it.',
      'If it asks, sign in on the provider’s own page. The app never sees your password.',
      'Name them and press Create.',
      'They appear in the office once your worker is connected and you are here.',
    ])));
  body.append(h('p.hint', 'A worker is a small program on your computer that runs your agents with your own sign-ins and keys. The office host never receives them. Without a connected worker your agents are unavailable.'));

  body.append(h('h3', 'Workers'), h('div.cr-list', ...(S.workers.length ? S.workers.map((w) => h('div.cr-item.row', h('span.dot', { style: { background: w.online ? 'var(--cr-ok)' : '#bbb' } }), h('b.grow', w.name), h('span.muted', w.alwaysOn ? 'always-on' : 'attended (runs while you are here)'), h('span.muted', w.online ? 'online' : 'offline'),
    h('button.btn.small.danger', { onclick: () => act(() => api('DELETE', `/api/crew/rooms/${roomId}/workers/${w.id}`), 'Worker revoked') }, 'Revoke'))) : [h('p.hint', 'No workers yet. Add one to bring your agents online.')])));

  const mine = S.agents.filter((a) => a.ownerId === S.me.id);
  body.append(h('h3', 'My agents'), h('div.cr-list', ...(mine.length ? mine.map((a) => h('div.cr-item.click.row', { onclick: () => openAgent(a.id) }, avatar(a.name, a.color, { ai: true }),
    h('div.grow', h('b', a.name), h('div.hint', S.providers[a.provider]?.label ?? a.provider)), statusPill(a.status), holidayButton(a, 'button.btn.small'), fireButton(a, 'button.btn.small.danger'))) : [h('p.hint', 'No agents yet. Create them under Agents.')])));

  body.append(h('div.row', { style: { marginTop: '12px' } },
    h('a.btn', { href: 'http://127.0.0.1:8790', target: '_blank', rel: 'noopener' }, 'Open my worker’s settings'),
    h('button.btn', { onclick: connectWorker, title: 'Run your agents on a different computer from this one' }, 'Run on another computer'),
    h('button.btn.danger', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/agents-pause-all`, { paused: true }), 'All your agents are paused') }, 'Pause all my agents'),
    h('button.btn', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/agents-pause-all`, { paused: false }), 'Your agents are back') }, 'Resume all')));
  body.append(h('p.hint', 'Sign-ins, budgets and Test Connection are on your worker’s own page, on the computer running it. Paid API use is off unless you turn it on there.'));
}

function quietMode() { try { return localStorage.getItem('crew.quiet') === '1'; } catch { return false; } }

function dashNotifications(body) {
  body.append(h('label', { style: { fontWeight: 400 } }, h('input', { type: 'checkbox', checked: quietMode(), onchange: (e) => { try { localStorage.setItem('crew.quiet', e.target.checked ? '1' : '0'); } catch {} } }), ' Quiet mode: only pop up what needs me (approvals, blockers, failures)'));
  if (!S.notifications.length) body.append(h('p.hint', 'No notifications.'));
  body.append(h('div.cr-list', ...S.notifications.map((n) => h('div.cr-item', h('span.pill', { class: n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : '' }, n.level), ' ', n.text, h('div.hint', ago(n.createdAt))))));
}

function dashFriends(body) {
  const admin = ['owner', 'admin'].includes(S.room.myRole);
  body.append(h('div.row', h('h2.grow', 'Friends in this office'), admin ? h('button.btn.primary', { onclick: invite }, 'Invite a friend') : null));
  body.append(h('p.hint', 'Everyone here brings their own AI team, on their own computer, with their own sign-ins.'));
  body.append(h('div.cr-list', ...S.members.map((m) => {
    const agents = S.agents.filter((a) => a.ownerId === m.userId);
    return h('div.cr-item.row', avatar(m.displayName, m.color, { online: m.online }), h('div.grow', h('b', m.displayName, m.userId === S.me.id ? ' (you)' : ''), h('div.hint', `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${m.online ? 'here now' : 'away'} · worker ${m.workerOnline ? 'online' : 'offline'}`)), h('span.pill.human', m.role));
  })));
}

function dashPrefs(body) {
  const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const keep = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* this browser will not remember it */ } };
  body.append(h('h2', 'Preferences'), h('p.hint', 'These are kept in this browser only.'));
  body.append(h('label', 'Appearance'), h('select', { onchange: (e) => { keep('crew.theme', e.target.value === 'light' ? 'light' : ''); applyAppearance(); } },
    h('option', { value: '', selected: stored('crew.theme') !== 'light' }, 'Dark glass'), h('option', { value: 'light', selected: stored('crew.theme') === 'light' }, 'Light glass')));
  body.append(h('label.cr-check', h('input', { type: 'checkbox', checked: stored('crew.motion') === 'off', onchange: (e) => { keep('crew.motion', e.target.checked ? 'off' : ''); applyAppearance(); } }), ' Turn off interface animation (your system’s reduced motion setting always applies)'));
  body.append(h('label.cr-check', h('input', { type: 'checkbox', checked: quietMode(), onchange: (e) => keep('crew.quiet', e.target.checked ? '1' : '0') }), ' Quiet mode: only pop up what needs me (approvals, blockers, failures)'));
  body.append(h('h3', 'Tours'), h('div.row', h('button.btn', { onclick: () => openTutorial({ showMe: tourShowMe }) }, 'How the office works'), h('button.btn', { onclick: () => { goTo('playbooks'); setTimeout(() => ui.orchestrator.tour(), 250); } }, 'How the Orchestrator works')));
  body.append(h('h3', 'Profile'), h('div.row', h('button.btn', { onclick: () => chooseCharacter() }, 'Change character'), h('button.btn', { onclick: profile }, 'Change name or avatar colour'), h('a.btn', { href: '/crew' }, 'Back to lobby')));
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
      r.myRole === 'owner' ? h('button.btn.danger', { onclick: () => act(() => api('POST', `/api/crew/rooms/${roomId}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }), r.status === 'open' ? 'Office stopped' : 'Office started') }, r.status === 'open' ? 'Stop office' : 'Start office') : null,
      r.myRole === 'owner' ? h('button.btn.danger', { onclick: () => confirmDeleteOffice(r).then((gone) => { if (gone) location.href = '/crew'; }) }, 'Delete office') : null));
  }
  body.append(h('h3', 'Players'), h('div.cr-list', ...S.members.map((m) => h('div.cr-item.row', avatar(m.displayName, m.color, { online: m.online }), h('b.grow', m.displayName),
    admin && m.role !== 'owner' && m.userId !== S.me.id ? h('select', { onchange: (e) => act(() => api('POST', `/api/crew/rooms/${roomId}/members/${m.userId}/role`, { role: e.target.value }), 'Role changed') }, ...['guest', 'member', 'admin'].map((x) => h('option', { value: x, selected: m.role === x }, x))) : h('span.pill', m.role),
    admin && m.role !== 'owner' && m.userId !== S.me.id ? h('button.btn.small.danger', { onclick: () => confirm(`Remove ${m.displayName} and take their agents off the floor?`) && act(() => api('DELETE', `/api/crew/rooms/${roomId}/members/${m.userId}`), 'Player removed') }, 'Remove') : null))));
  body.append(h('h3', 'Your profile'), h('div.row', h('button.btn', { onclick: profile }, 'Change name or avatar colour'), h('a.btn', { href: '/crew' }, 'Back to lobby')));
  body.append(h('p.hint', { style: { marginTop: '16px' } }, `${BRAND} is by lisboaphe, free for non-commercial use with credit, and based on The Roving Office (Apache-2.0, © Atlassian). See LICENSING.md and NOTICE.`));
}

// --- side panel: chat and agents ----------------------------------------------

function openSide(mode) {
  ui.sideMode = mode;
  ui.side.classList.remove('hidden');
  document.body.classList.add('cr-chat-open');
  render();
}

/** How this window reaches the office, and only what is true right now. */
function connectionPill() {
  if (ui.reconnecting) return h('span.cr-link.wait', 'Reconnecting…');
  const internet = S.host?.internet;
  const here = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!here && !/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return h('span.cr-link.ok', 'Relay connection');
  if (!here) return h('span.cr-link.ok', 'Direct connection');
  const label = internet?.label ?? 'Hosting locally';
  return h('span.cr-link', { class: internet?.state === 'online' ? 'ok' : internet?.state === 'unavailable' ? 'bad' : '', title: label }, h('span.cr-says-less', label));
}

/** On the HUD and in the Security Center. The host decides what the press may do. */
function stopButton() {
  const staff = ['owner', 'admin'].includes(S.room.myRole);
  if (S.emergency) return h('span.cr-stopped', 'ALL AI STOPPED');
  return h('button.btn.cr-stop', {
    title: staff ? 'Stops every agent in this office' : 'Stops your own agents. Only the owner or an admin can stop everyone’s.',
    onclick: async () => {
      try {
        if (staff) { await api('POST', `/api/crew/rooms/${roomId}/emergency-stop`, { reason: 'Pressed the stop button' }); toast('All AI activity stopped'); await refresh(); } else { await api('POST', `/api/crew/rooms/${roomId}/agents-pause-all`, { paused: true }); toast('Your agents are stopped'); }
      } catch (e) { toast(e.message, 6000); }
    },
  }, h('span.cr-says-less', staff ? 'STOP ALL AI ACTIVITY' : 'STOP MY AI'), h('span.cr-says-more', 'STOP AI'));
}

function openAgent(id) { ui.editor.open(id).catch((e) => toast(e.message)); }

/** What the editor, the wizard and the Orchestrator need from the office. */
function editorContext() {
  return {
    stopButton, S, roomId, ui, ownerOfComputer: ui.ownerOfComputer, statusPill, taskDetail, jobLogs, assignTask, holidayButton, fireButton, messageView, viewFile, openAgent,
    refreshState: refresh,
    workerLink: localWorker,
    chatWith: (a, channelId) => { if (!channelId) return; ui.channelId = channelId; if (!S.channels.find((c) => c.id === channelId)) S.channels.push({ id: channelId, kind: 'dm', name: 'dm', dmAgentId: a.id }); openSide('chat'); },
    usage: () => refreshUsage(),
    privateMemory: (agentId) => (onThisComputer() ? localWorker().get(`/agent-memory?agent=${encodeURIComponent(agentId)}`).then((r) => r.memory).catch(() => null) : Promise.resolve(null)),
    playbooksUsing: (agentId) => ui.orchestrator?.playbooksUsing(agentId) ?? [],
    playbooks: () => ui.orchestrator?.playbooks() ?? [],
    addToPlaybook: (id, agent) => ui.orchestrator.addToPlaybook(id, agent),
    showRuns: (runId) => { ui.tab = 'runs'; ui.dash.classList.remove('hidden'); ui.dash.dataset.tab = ''; render(); ui.orchestrator.showRuns(runId); },
    firstTask: (a) => { if (S.projects.length) assignTask(a); else newProject(); },
  };
}

/** A channel as people read it. A project's is named project-<name>-<4 random characters>; only the name means anything. */
const channelLabel = (c) => (c.kind === 'dm' ? `@${agentById(c.dmAgentId)?.name ?? 'agent'}` : `#${c.kind === 'project' ? c.name.replace(/-[a-zA-Z0-9_-]{4}$/, '').replace(/^project-/, '') : c.name}`);

function renderSide() {
  const ch = S.channels.find((c) => c.id === ui.channelId) ?? S.channels[0];
  if (!ch) { ui.side.replaceChildren(h('header', h('h2', 'Chat'))); return; }
  ui.channelId = ch.id;
  let msgs = ui.messages.get(ch.id);
  if (!msgs) {
    msgs = [];
    ui.messages.set(ch.id, msgs);
    api('GET', `/api/crew/rooms/${roomId}/channels/${ch.id}/messages`).then((r) => { msgs.splice(0, msgs.length, ...r.messages); render(); });
  }
  ui.unread?.delete(ch.id);
  // The panel is redrawn on every event in the office, so what was being typed, where the cursor
  // was, and how far up someone had scrolled all have to survive that.
  const oldList = ui.side.querySelector('.cr-msgs');
  const wasReading = oldList && ui.drawnChannel === ch.id && oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight > 40;
  const oldScroll = oldList?.scrollTop ?? 0;
  const oldChannelScroll = ui.side.querySelector('.cr-channels')?.scrollTop ?? 0;
  const channelChanged = ui.drawnChannel !== ch.id;
  const oldInput = ui.side.querySelector('.cr-composer input');
  const hadFocus = oldInput && document.activeElement === oldInput;
  const caret = hadFocus ? oldInput.selectionStart : null;
  const list = h('div.cr-msgs', ...msgs.map(messageView));
  const input = h('input.grow', { 'aria-label': `Message ${channelLabel(ch)}`, placeholder: ch.kind === 'dm' ? 'Message your agent…' : `Message ${channelLabel(ch)}, @Name for an agent`, value: (ui.drafts ??= new Map()).get(ch.id) ?? '', oninput: (e) => ui.drafts.set(ch.id, e.target.value) });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ui.drafts.delete(ch.id);
    try {
      if (ch.kind === 'dm') await api('POST', `/api/crew/rooms/${roomId}/agents/${ch.dmAgentId}/chat`, { text });
      else await api('POST', `/api/crew/rooms/${roomId}/channels/${ch.id}/messages`, { body: text });
    } catch (e) { toast(e.message); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const label = channelLabel;
  ui.side.replaceChildren(
    h('header.cr-chat-head', h('h2', 'Chat', ' ', h('span.cr-chat-where', label(ch))), h('button.btn.small.cr-icon-btn', { onclick: searchMessages, title: 'Search messages', 'aria-label': 'Search messages' }, icon('search')), h('button.btn.small', { onclick: toggleChat, 'aria-label': 'Close chat' }, '✕')),
    h('div.cr-channels', { role: 'tablist', 'aria-label': 'Channels' }, ...S.channels.map((c) => {
      const n = ui.unread?.get(c.id) ?? 0;
      return h('button', { role: 'tab', 'aria-selected': c.id === ch.id ? 'true' : 'false', class: c.id === ch.id ? 'on' : '', title: label(c), 'aria-label': n ? `${label(c)}, ${n} unread` : label(c), onclick: () => { ui.channelId = c.id; render(); } }, h('span.cr-channel-name', label(c)), n ? h('span.cr-unread', n > 99 ? '99+' : n) : null);
    }),
      h('button', { onclick: newChannel, title: 'New channel', 'aria-label': 'New channel' }, '+')),
    list,
    h('div.cr-composer', input, h('button.btn.primary', { onclick: send, title: 'Send', 'aria-label': 'Send message' }, icon('send'))));
  list.scrollTop = wasReading ? oldScroll : list.scrollHeight;
  const channelRow = ui.side.querySelector('.cr-channels');
  channelRow.scrollTop = oldChannelScroll;
  if (channelChanged) channelRow.querySelector('button.on')?.scrollIntoView({ block: 'nearest' });
  ui.drawnChannel = ch.id;
  if (hadFocus) { input.focus(); if (caret !== null) input.setSelectionRange(caret, caret); }
}

function messageView(m) {
  const isAgent = m.senderType === 'agent';
  const mine = m.senderType === 'human' && m.senderId === S.me.id;
  return h('div.cr-msg', { class: m.senderType === 'system' ? 'system' : mine ? 'mine' : '' },
    m.senderType === 'system' ? null : avatar(m.senderName, m.senderColor, { ai: isAgent }),
    h('div.grow',
      h('div.meta', h('b', m.senderName), isAgent ? h('span.pill.ai', 'AI') : m.senderType === 'human' ? h('span.pill.human', 'human') : null,
        m.toAgentName ? h('span', `→ ${m.toAgentName}`) : null, m.kind !== 'chat' && m.kind !== 'system' ? h('span.pill', m.kind.replace('_', ' ')) : null,
        m.taskId ? h('span.hint', 'task-linked') : null, h('span', ago(m.createdAt))),
      h('div.text', m.body)));
}

// --- forms ----------------------------------------------------------------------

async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, 6000); return null; }
}

function field(label, el, hint) { return [h('label', label), el, hint ? h('div.hint', hint) : null]; }

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
  return modal('Add a worker', (close) => {
    const name = h('input', { value: `${S.me.displayName}'s computer` });
    const always = h('input', { type: 'checkbox' });
    const out = h('div');
    const go = async () => {
      const { worker } = await api('POST', `/api/crew/rooms/${roomId}/workers`, { name: name.value, alwaysOn: always.checked });
      // 169.254.x.x is an adapter with no network behind it. Open the office that way and
      // it is still only ever this computer, so give the worker the address that lasts.
      const host = location.hostname.startsWith('169.254.') ? `http://localhost:${location.port}` : location.origin;
      const cmd = `node bin/crew-worker.cjs --host ${host} --token ${worker.token}`;
      out.replaceChildren(
        h('p', 'On the computer that should run your agents, open a terminal in the app folder and run this. The token is shown once.'),
        h('pre', cmd), h('button.btn.small', { onclick: () => navigator.clipboard?.writeText(cmd).then(() => toast('Copied')) }, 'Copy command'),
        h('p.hint', 'Installed with the setup program? The app folder is %LOCALAPPDATA%\\Programs\\CrewOffice on Windows (in PowerShell: cd "$env:LOCALAPPDATA\\Programs\\CrewOffice"), ~/Applications/CrewOffice on macOS and ~/.local/share/crew-office on Linux.'),
        h('p.hint', 'Then open http://127.0.0.1:8790 on that computer to sign in or add your keys. They stay on that computer.'),
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
      // The internet address first, when there is one. Network addresses only work at home.
      const online = S.host.internet?.url;
      const bases = online ? [online] : [location.origin, ...(S.host.lanAddresses ?? []).map((a) => `http://${a}:${S.host.port}`)];
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

/** The selection screen. Everyone in the office sees who you choose. */
function chooseCharacter({ first = false } = {}) {
  return modal('Choose your character', (close) => {
    const picker = characterPicker(S.me?.character ?? 0);
    const save = async () => {
      try {
        const { user } = await api('PATCH', '/api/crew/me', { character: picker.value });
        S.me = user;
        close();
        render();
      } catch (e) { toast(e.message); }
    };
    return h('div',
      h('p.hint', first ? 'This is you in the office. You can change it any time by clicking your character.' : 'This is you in the office, and everyone here sees it.'),
      picker,
      h('div.actions', first ? null : h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, first ? 'Start' : 'Save')));
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

// Whose bot this is, for the office's columns. A player owns bots and has no desk of their own.
window.crewOwnerOf = (charId) => {
  const a = S.agents.find((x) => String(charId).endsWith(`#crew:${x.id}`));
  return a?.ownerId ? { id: a.ownerId, name: a.ownerName ?? '' } : null;
};

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
  if (view.office2d) return view.office2d.agentAt(ch.id);
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
