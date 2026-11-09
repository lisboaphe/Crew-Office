// The Screenshots tab: what the agents saw while they worked, kept on this computer.
//
// The images are in one folder on the host (lib/crew/shots.cjs). Claude's office hook puts the
// screenshots Claude takes there by itself; any other agent is told the folder and saves into it.
// Only the owner of this computer sees them, and each one can be kept or deleted.

import { h, api, toast, modal, ago } from './common.js';

const REFRESH_MS = 8000;
const src = (s) => `/api/crew/shots/${encodeURIComponent(s.name)}?v=${s.size}`;

export function shotsTab(body, ctx) {
  const { ui, render } = ctx;
  const load = () => api('GET', '/api/crew/shots')
    .then((d) => { ui.shots = d; ui.shotsAt = Date.now(); render(); })
    .catch((e) => toast(e.message));

  // The office repaints this on every event, so it fetches only when it has nothing or what it has
  // has gone stale, and a new screenshot turns up within a few seconds without a button.
  clearTimeout(ui.shotsTimer);
  ui.shotsTimer = setTimeout(() => { if (ui.tab === 'shots' && !ui.dash.classList.contains('hidden')) load(); }, REFRESH_MS);
  if (!ui.shots || Date.now() - (ui.shotsAt ?? 0) > REFRESH_MS) {
    if (!ui.shots) { body.append(h('p.hint', 'Loading…')); load(); return; }
    load();
  }

  const d = ui.shots;
  if (!d.owner) {
    body.append(h('p.hint', 'Screenshots stay on the computer hosting this office, and only its owner sees them. Open Crew Office on that computer to look at them.'));
    return;
  }

  const filter = ui.shotsFilter ?? 'all';
  const shown = d.shots.filter((s) => filter === 'all' || (filter === 'kept' ? s.kept : !s.kept));
  const unkept = d.shots.filter((s) => !s.kept).length;

  body.append(h('p.hint', 'What Claude, Codex and your other agents saw while they worked. They stay on this computer: nothing here is shared with the office or sent anywhere. Keep the ones worth keeping and delete the rest.'));
  body.append(h('div.row',
    h('select', { 'aria-label': 'Show', onchange: (e) => { ui.shotsFilter = e.target.value; render(); } },
      ...[['all', `All (${d.shots.length})`], ['new', `Not kept (${unkept})`], ['kept', `Kept (${d.shots.length - unkept})`]].map(([v, label]) => h('option', { value: v, selected: v === filter }, label))),
    h('span.grow'),
    h('button.btn', { onclick: load }, 'Refresh'),
    h('button.btn', { onclick: () => api('POST', '/api/crew/shots-folder/open').catch((e) => toast(e.message)) }, 'Open folder'),
    unkept ? h('button.btn', {
      onclick: async () => {
        if (!confirm(`Delete the ${unkept} screenshot${unkept === 1 ? '' : 's'} you have not kept? They are removed from this computer.`)) return;
        try { const r = await api('POST', '/api/crew/shots-clear'); toast(`Deleted ${r.deleted}.`); load(); } catch (e) { toast(e.message); }
      },
    }, 'Delete all not kept') : null));

  if (!shown.length) {
    body.append(h('p.hint', d.shots.length ? 'None here.' : 'No screenshots yet.'));
    body.append(howTo(d.folder));
    return;
  }

  body.append(h('div.cr-shots', ...shown.map((s) => h('figure.cr-shot', { class: s.kept ? 'kept' : '' },
    h('button.cr-shot-img', { type: 'button', title: 'Open it', onclick: () => view(s, ctx, load) },
      h('img', { src: src(s), alt: s.title ?? `Screenshot by ${s.by}`, loading: 'lazy' })),
    h('figcaption',
      h('div.row', h('b.grow', s.by), s.kept ? h('span.pill', 'Kept') : null),
      h('div.hint', [s.title, ago(s.createdAt)].filter(Boolean).join(' · ')),
      h('div.row', actions(s, load)))))));
  if (d.total > d.shots.length) body.append(h('p.hint', `Showing the newest ${d.shots.length} of ${d.total}.`));
  body.append(howTo(d.folder));
}

function actions(s, load) {
  return [
    h('button.btn.small', { onclick: () => api('POST', `/api/crew/shots/${encodeURIComponent(s.name)}/keep`, { kept: !s.kept }).then(load).catch((e) => toast(e.message)) }, s.kept ? 'Unkeep' : 'Keep'),
    h('button.btn.small', {
      onclick: async () => {
        if (!confirm('Delete this screenshot from this computer?')) return;
        try { await api('DELETE', `/api/crew/shots/${encodeURIComponent(s.name)}`); load(); } catch (e) { toast(e.message); }
      },
    }, 'Delete'),
  ];
}

function view(s, ctx, load) {
  modal(s.title ?? `Screenshot by ${s.by}`, (close) => h('div',
    h('img.cr-shot-full', { src: src(s), alt: s.title ?? `Screenshot by ${s.by}` }),
    h('p.hint', `${s.by} · ${new Date(s.createdAt).toLocaleString()}${s.project ? ` · ${s.project}` : ''}`),
    h('div.row', h('span.grow'), ...actions(s, () => { close(); load(); }), h('button.btn.small', { onclick: () => close() }, 'Close'))));
}

function howTo(folder) {
  return h('details.cr-shots-how',
    h('summary', 'How screenshots get here'),
    h('p.hint', 'Claude puts the screenshots it takes here by itself while the office is running. For Codex or any other agent, ask it to save its screenshots into this folder, or add that to the project’s instructions for agents:'),
    h('div.row', h('code.grow', folder), h('button.btn.small', { onclick: () => navigator.clipboard?.writeText(folder).then(() => toast('Copied')).catch(() => {}) }, 'Copy')),
    h('p.hint', 'Starting a file name with codex-, claude- or cursor- labels who took it.'));
}
