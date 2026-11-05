// The Security Center. It shows what the host enforces and lets the people entitled to change it do
// so. Nothing is enforced here: every button calls a route that checks again who is asking.

import { h, api, toast, ago, helpTip } from './common.js';

const PROFILES = [
  ['manual', 'Supervised', 'Asks before new work across teams, merges, running code, and anything else with side effects.'],
  ['balanced', 'Balanced', 'Recommended. Routine work runs by itself; merges into a protected branch and destructive actions ask.'],
  ['autonomous', 'Autonomous', 'Authorised agents work without repeated prompts. Deleting shared files and rolling back main still ask.'],
];

const stat = (label, n, tone = '') => h('div.cr-stat-tile', { class: tone }, h('b', String(n)), h('span.hint', label));
const eventRow = (e) => h('div.cr-item.cr-audit', { class: e.outcome === 'denied' ? 'denied' : '' },
  h('div.row', h('b.grow', e.action), e.outcome === 'denied' ? h('span.pill.bad', 'blocked') : null, h('span.hint', ago(e.ts))),
  h('div.hint', e.actorName, e.resource ? ` · ${e.resource}` : '', e.detail?.why ? ` · ${e.detail.why}` : ''));

export function createSecurityCenter(ctx) {
  const { S, roomId, openAgent } = ctx;
  const R = `/api/crew/rooms/${roomId}`;
  const root = h('div.cr-security', h('p.hint', 'Loading…'));
  const logBox = h('div.cr-list');
  let query = '';
  let onlyBlocked = false;
  let data = null;
  let chain = null;
  let openPlayer = null;
  let timer = null;

  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); await load(); return r; } catch (e) { toast(e.message, 6000); return null; } };

  async function loadLog() {
    const r = await api('GET', `${R}/security/audit?q=${encodeURIComponent(query)}${onlyBlocked ? '&outcome=denied' : ''}`);
    chain = r.chain;
    logBox.replaceChildren(...(r.events.length ? r.events.slice(0, 80).map(eventRow) : [h('p.hint', 'Nothing matches.')]));
  }

  function emergencyPanel() {
    const stopped = data.emergency;
    if (stopped) {
      return h('div.cr-emergency.on', h('div.grow', h('b', 'All AI activity is stopped.'), h('div.hint', 'New work is refused, and this survives a restart. Stopped tasks can be retried after resuming.')),
        data.viewer.staff ? h('button.btn', { onclick: () => act(() => api('POST', `${R}/emergency-resume`), 'Resumed') }, 'Resume') : null);
    }
    return h('div.cr-emergency', h('div.grow', h('b', 'Emergency stop'), h('div.hint', 'Cancels queued work, kills running sandboxes on connected workers, and stops pushes.'), h('div.hint', 'A worker that cannot be reached stops by itself when it loses contact, within about two minutes.')),
      ctx.stopButton());
  }

  function profilePanel() {
    return h('section', h('h3', 'Approval profile', helpTip('What this controls', ['Only how often a person is asked.', 'Sandboxing, file limits, tool permissions, credential isolation and protected branches stay on in every profile.', 'Autonomous never means control of the computer.'])),
      h('div.cr-preset-grid', ...PROFILES.map(([id, name, text]) => h('button.cr-preset', {
        class: data.profile === id ? 'on' : '', disabled: !data.viewer.staff,
        onclick: () => act(() => api('PUT', `${R}/rules/office/${roomId}`, { rules: { approvalMode: id } }), `${name} is on`),
      }, h('b', name), h('span.hint', text)))),
      h('p.hint', 'These profiles control routine approvals, not security boundaries.'));
  }

  function playerRow(p) {
    const open = openPlayer === p.userId;
    const me = p.userId === S.me.id;
    return h('div.cr-item', h('div.row.cr-clicky', { onclick: () => { openPlayer = open ? null : p.userId; draw(); } }, h('span.dot', { style: { background: p.online ? 'var(--cr-ok)' : '#888' } }), h('b.grow', p.displayName), h('span.pill', p.role), h('span.hint', `${p.agents.length} agent${p.agents.length === 1 ? '' : 's'}`)),
      open ? h('div.cr-fade',
        h('dl.cr-kv.tight', h('dt', 'Projects'), h('dd', p.projects.map((x) => x.name).join(', ') || 'None'), h('dt', 'Agents'), h('dd', p.agents.map((x) => x.name).join(', ') || 'None'), h('dt', 'Workers'), h('dd', String(p.workers))),
        h('h4', 'Recent activity'), ...(p.recent.length ? p.recent.map(eventRow) : [h('p.hint', 'Nothing yet.')]),
        !me && p.role !== 'owner' ? h('div.cr-actions', h('button.btn.small.danger', { onclick: () => { if (confirm(`Remove ${p.displayName}? Their session and workers are cut off now, and every invitation to this office stops working, so they cannot come back on an old link.`)) act(() => api('DELETE', `${R}/members/${p.userId}`), `${p.displayName} removed`); } }, 'Revoke access and remove')) : null) : null);
  }

  const agentRow = (a) => h('div.cr-item', h('div.row', h('b.grow', a.name), h('span.hint', a.ownerName), h('span.pill', a.status.toLowerCase()), h('button.btn.small', { onclick: () => openAgent(a.id) }, 'Open')),
    h('dl.cr-kv.tight', h('dt', 'Tools'), h('dd', a.tools.join(', ') || 'None'), h('dt', 'Runs'), h('dd', a.execution),
      h('dt', 'Projects'), h('dd', a.projects.map((p) => `${p.name} (${p.tools.join(', ') || 'no tools'}${p.repos.length ? `; ${p.repos.join(', ')}` : ''})`).join('; ') || 'None')),
    a.recent.length ? h('details', h('summary', 'Recent tool calls'), ...a.recent.map((e) => h('div.hint', `${e.outcome === 'denied' ? 'BLOCKED ' : ''}${e.action}${e.resource ? ` ${e.resource}` : ''}, ${ago(e.ts)}`))) : null);

  function draw() {
    if (!data) return;
    const search = h('input', { type: 'search', placeholder: 'Search the record', value: query, 'aria-label': 'Search the audit record' });
    let wait = null;
    search.addEventListener('input', () => { query = search.value; clearTimeout(wait); wait = setTimeout(loadLog, 250); });
    const blockedOnly = h('input', { type: 'checkbox', checked: onlyBlocked, onchange: () => { onlyBlocked = blockedOnly.checked; loadLog(); } });
    const network = data.network;
    root.replaceChildren(...[
      emergencyPanel(),
      h('div.cr-stat-row', stat('Running now', data.counts.running, 'run'), stat('Queued', data.counts.queued), stat('Waiting for approval', data.counts.pendingApprovals, 'wait'), stat('Blocked today', data.counts.blocked24h, data.counts.blocked24h ? 'bad' : '')),
      h('dl.cr-kv.tight', h('dt', 'Connection'), h('dd', network.label ?? network.mode ?? 'Unknown'), h('dt', 'Shared workspaces'), h('dd', data.workspaces.map((w) => w.name).join(', ') || 'None')),
      profilePanel(),
      data.viewer.staff ? h('section', h('h3', 'Players'), h('div.cr-list', ...data.players.map(playerRow))) : null,
      h('section', h('h3', data.viewer.staff ? 'Agents' : 'Your agents'), h('div.cr-list', ...(data.agents.length ? data.agents.map(agentRow) : [h('p.hint', 'None yet.')]))),
      data.viewer.staff && data.invites.length ? h('section', h('h3', 'Open invitations'), h('div.cr-list', ...data.invites.map((i) => h('div.cr-item.row', h('code.grow', `${i.code.slice(0, 6)}…`), h('span.pill', i.role), h('span.hint', `${i.usesLeft} uses, by ${i.createdBy}`), h('button.btn.small.danger', { onclick: () => act(() => api('DELETE', `${R}/invites/${encodeURIComponent(i.code)}`), 'Revoked') }, 'Revoke'))))) : null,
      h('section', h('h3', 'Security record'),
        chain ? h('p.hint', chain.ok ? `The record checks out: ${chain.checked} entries, each chained to the last.` : `Warning: the record does not check out at entry ${chain.brokenAt}. ${chain.why}`) : h('p.hint', 'Your own activity in this office.'),
        h('div.row', h('div.grow', search), h('label.cr-inline', blockedOnly, ' Only blocked')), logBox),
    ].filter(Boolean));
  }

  async function load() {
    data = await api('GET', `${R}/security`);
    await loadLog();
    draw();
  }

  /** Called when the tab opens. It refreshes itself while it is on screen. */
  function show() {
    load().catch((e) => toast(e.message));
    clearInterval(timer);
    timer = setInterval(() => { if (root.isConnected && !root.contains(document.activeElement)) load().catch(() => {}); else if (!root.isConnected) clearInterval(timer); }, 5000);
    return root;
  }

  return { show };
}
