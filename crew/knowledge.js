// Memory & Knowledge: what the team has learned, and an interactive map of the code.
//
// Holds its own state and updates itself, like the Orchestrator, so a half-written memory or a graph
// someone has arranged survives the office's constant updates. Everything shown is from the host,
// which has already checked this person may see it; nothing here decides anything.

import { h, api, toast, modal, ago } from './common.js';

const SCOPE = {
  user: { label: 'Only me', hint: 'You, and your own agents when they work for you. Hidden from other players and their agents.' },
  team: { label: 'My team', hint: 'You and all your agents. Hidden from other players and their agents.' },
  project: { label: 'The project', hint: 'Everyone on the project, and agents lent to it with the memory permission.' },
};
const short = (sha) => (sha ? sha.slice(0, 8) : '');

export function createKnowledge(ctx) {
  const { S, roomId } = ctx;
  const R = `/api/crew/rooms/${roomId}`;
  const roots = { memory: h('div.cr-know'), graph: h('div.cr-know'), plugins: h('div.cr-know') };
  let data = null;
  let filter = { scope: '', project: '', q: '' };
  let picked = { project: null, repo: null };
  let graphView = null;
  let searchTimer = null;

  const load = async () => { data = await api('GET', `${R}/knowledge`); return data; };
  const fail = (e) => toast(e.message, 6000);
  const projectName = (id) => data?.projects.find((p) => p.id === id)?.name ?? S.projects.find((p) => p.id === id)?.name ?? 'a project';

  // --- engines --------------------------------------------------------------------------

  const chip = (tone, text) => h('span.cr-status-chip', { class: tone }, h('span.dot'), text);
  const mem0Chip = (e) => (e.checking ? chip('muted', 'Checking…') : e.ready ? chip('ok', `Ready · ${e.model}`) : e.installed ? chip('warn', e.modelChosen ? 'Problem' : 'Choose a model') : chip('muted', 'Not installed'));
  const graphifyChip = (e) => (e.checking ? chip('muted', 'Checking…') : e.installed ? chip('ok', `Ready · ${e.version}`) : chip('muted', 'Not installed'));

  function drawPlugins() {
    const { engines, canConfigure } = data;
    const box = roots.plugins;
    const provider = h('select', { 'aria-label': 'Embedding provider' }, ...engines.providers.map((p) => h('option', { value: p, selected: (engines.mem0.provider ?? 'fastembed') === p }, p)));
    const model = h('input', { value: engines.mem0.model ?? '', placeholder: 'e.g. BAAI/bge-small-en-v1.5', 'aria-label': 'Embedding model' });
    const saveModel = async () => {
      if (engines.mem0.model && model.value.trim() !== engines.mem0.model && !confirm('Changing the model rebuilds the search index from your memories. Nothing is lost. Continue?')) return;
      try { await api('PUT', '/api/crew/knowledge/mem0-model', { provider: provider.value, model: model.value.trim() }); toast('Saved. The first use may download the model.'); await refresh(); } catch (e) { fail(e); }
    };
    box.replaceChildren(
      h('div.row', h('h2.grow', 'Plugins'), canConfigure ? h('button.btn.small', { onclick: async () => { try { await api('POST', `${R}/knowledge/check`); await refresh(); toast('Checked this computer'); } catch (e) { fail(e); } } }, 'Check again') : null),
      h('p.hint', 'Both are optional, run on the computer hosting this office, and use no paid service. Each is switched on per project, on the Memory page.'),
      h('div.cr-conn-grid',
        h('div.cr-conn-card',
          h('div.cr-conn-head', h('b', 'Mem0'), mem0Chip(engines.mem0)),
          h('p.muted', 'Finds memories by meaning, not just by the words in them.'),
          engines.mem0.reason && !engines.mem0.checking ? h('p.hint', engines.mem0.reason) : null,
          h('p.hint', 'Without it, memory still works, and search matches words. Open source (Apache-2.0), stored in a folder on the host.'),
          engines.mem0.installed
            ? (canConfigure
              ? h('div', h('label', 'Local embedding model'), h('div.row', provider, h('div.grow', model)), h('p.hint', 'You choose it, because the first use downloads it. It stays on this computer.'), h('div.row', h('button.btn.primary.small', { onclick: saveModel }, 'Use this model')))
              : h('p.hint', 'The person hosting this office chooses its model.'))
            : (canConfigure ? setupSteps(['Install Python 3.10 or newer.', 'Run: python -m pip install mem0ai fastembed (on Windows: py -m pip install mem0ai fastembed)', 'Press Check again, then choose a model.']) : h('p.hint', 'The person hosting this office can install it.'))),
        h('div.cr-conn-card',
          h('div.cr-conn-head', h('b', 'Graphify'), graphifyChip(engines.graphify)),
          h('p.muted', 'Maps functions, classes, files and how they connect, from merged code only.'),
          h('p.hint', 'Runs on code only with no AI model, so nothing leaves the host. Open source (Apache-2.0). Files that hold secrets are removed before it looks.'),
          !engines.graphify.installed && !engines.graphify.checking
            ? (canConfigure ? setupSteps(['Install Python 3.10 or newer.', 'Run: python -m pip install graphifyy (on Windows: py -m pip install graphifyy)', 'Press Check again.']) : h('p.hint', 'The person hosting this office can install it.'))
            : null)),
    );
  }

  const setupSteps = (steps) => h('div', h('b', 'To set it up'), h('ol.cr-setup', ...steps.map((s) => h('li', s))));

  // --- memory ---------------------------------------------------------------------------

  const projectSelect = (value, onchange, allLabel) => h('select', { 'aria-label': 'Project', onchange: (e) => onchange(e.target.value) },
    allLabel ? h('option', { value: '', selected: !value }, allLabel) : null,
    ...data.projects.map((p) => h('option', { value: p.id, selected: value === p.id }, p.name)));

  function switches() {
    if (!data.projects.length) return h('p.hint', 'Start a project and it can be switched on here, separately for each.');
    return h('div.cr-know-projects', ...data.projects.map((p) => {
      const toggle = (key, label, tip) => h('label.cr-switch-row', { title: p.canManage ? tip : 'Only the project’s creator, the office’s owner or an admin can change this.' },
        h('input', { type: 'checkbox', checked: p[key], disabled: !p.canManage, onchange: async (e) => { try { await api('PATCH', `${R}/projects/${p.id}/knowledge`, { [key]: e.target.checked }); await refresh(); } catch (err) { e.target.checked = !e.target.checked; fail(err); } } }), label);
      return h('div.cr-item.row', h('b.grow', p.name),
        toggle('mem0', 'Memory for agents', 'Agents on this project get relevant memories before they start, and Mem0 search if it is installed.'),
        toggle('graphify', 'Code graph', 'Keep a map of this project’s merged code, for people and agents.'));
    }));
  }

  function editor(memory = null) {
    return modal(memory ? 'Edit memory' : 'New memory', (close) => {
      const scope = h('select', { 'aria-label': 'Who can see this', disabled: Boolean(memory) }, ...Object.entries(SCOPE).map(([k, v]) => h('option', { value: k, selected: (memory?.scope ?? 'project') === k }, v.label)));
      const hint = h('p.hint');
      const project = projectSelect(memory?.projectId ?? filter.project ?? '', () => {}, 'No particular project');
      if (memory) project.disabled = true;
      const say = () => { hint.textContent = SCOPE[scope.value].hint; };
      scope.addEventListener('change', say);
      say();
      const title = h('input', { value: memory?.title ?? '', placeholder: 'Short title (optional)' });
      const body = h('textarea', { rows: 6, value: memory?.body ?? '', placeholder: 'What should be remembered? For example: the API returns dates in UTC.' });
      const err = h('p.error');
      const save = async () => {
        err.textContent = '';
        try {
          const payload = { title: title.value, body: body.value };
          const r = memory ? await api('PATCH', `${R}/memories/${memory.id}`, payload) : await api('POST', `${R}/memories`, { ...payload, scope: scope.value, projectId: project.value || null });
          close();
          toast(r.memory.removedSecrets ? `Saved. ${r.memory.removedSecrets} thing${r.memory.removedSecrets === 1 ? '' : 's'} that looked like a secret or a home folder were removed.` : 'Saved');
          drawList();
        } catch (e) { err.textContent = e.message; }
      };
      return h('div',
        h('div.row.cr-two', h('div', h('label', 'Who can see this'), scope), h('div', h('label', 'Project'), project)), hint,
        h('label', 'Title'), title, h('label', 'Memory'), body,
        h('p.hint', 'Do not save passwords or keys here. Things that look like them are removed, but a pattern can miss one. Everything here is stored on the computer hosting this office, whose owner could read that file.'),
        err, h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
    });
  }

  function memoryCard(m) {
    return h('article.cr-memory',
      h('div.row', h('b.grow', m.title), h('span.pill', { class: m.scope === 'project' ? 'ai' : 'human' }, m.scope === 'project' ? projectName(m.projectId) : SCOPE[m.scope].label),
        m.canChange ? h('button.btn.small', { onclick: () => editor(m) }, 'Edit') : null,
        m.canChange ? h('button.btn.small.danger', { onclick: async () => { if (!confirm('Remove this memory for good?')) return; try { await api('DELETE', `${R}/memories/${m.id}`); drawList(); } catch (e) { fail(e); } } }, 'Remove') : null),
      h('p.cr-memory-body', m.body),
      h('div.hint', `${m.authorType === 'agent' ? '🤖 ' : ''}${m.authorName} · ${ago(m.updatedAt)}`,
        m.commit ? h('span', ' · written at ', h('code', short(m.commit))) : null,
        m.codeMovedOn ? h('span.cr-moved', ' · the code has changed since') : null));
  }

  let listBox = null;
  let engineNote = null;
  async function drawList() {
    if (!listBox) return;
    const q = new URLSearchParams();
    if (filter.q) q.set('q', filter.q);
    if (filter.scope) q.set('scope', filter.scope);
    if (filter.project) q.set('project', filter.project);
    try {
      const r = await api('GET', `${R}/memories?${q}`);
      engineNote.textContent = filter.q ? (r.engine === 'mem0' ? 'Searched by meaning, with Mem0.' : r.note ? `Searched by words. ${r.note}` : 'Searched by words.') : '';
      listBox.replaceChildren(...(r.memories.length ? r.memories.map(memoryCard) : [h('div.cr-empty', h('p.muted', filter.q ? 'Nothing matches that.' : 'No memories yet.'), filter.q ? null : h('p.hint', 'Save decisions, conventions and things you never want to explain twice. Agents can add to this too.'))]));
    } catch (e) { fail(e); }
  }

  function drawMemory() {
    const search = h('input', { type: 'search', placeholder: 'Search memories…', 'aria-label': 'Search memories', value: filter.q, oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filter.q = e.target.value.trim(); drawList(); }, 280); } });
    const scopeSel = h('select', { 'aria-label': 'Filter by who can see it', onchange: (e) => { filter.scope = e.target.value; drawList(); } }, h('option', { value: '', selected: !filter.scope }, 'Everyone I can see'), ...Object.entries(SCOPE).map(([k, v]) => h('option', { value: k, selected: filter.scope === k }, v.label)));
    listBox = h('div.cr-list');
    engineNote = h('p.hint');
    roots.memory.replaceChildren(
      h('div.row', h('span.grow'), h('button.btn.small', { onclick: () => ctx.setTab('plugins') }, data.engines.mem0.ready ? 'Mem0 is ready' : 'Set up Mem0'), h('button.btn.primary', { onclick: () => editor() }, 'New memory')),
      h('details.cr-know-switches', { open: !data.projects.some((p) => p.mem0 || p.graphify) }, h('summary', 'What is on, per project'), switches(),
        h('p.hint', 'An agent’s own private memory stays on its owner’s computer, and is shown in that agent’s editor. Anything an agent reads from here is treated as information: it cannot change what the agent may do.')),
      h('div.row.cr-know-filter', h('div.grow', search), scopeSel, projectSelect(filter.project, (v) => { filter.project = v; drawList(); }, 'All projects')),
      engineNote, listBox);
    drawList();
  }

  // --- the graph ------------------------------------------------------------------------

  function drawGraph() {
    const box = roots.graph;
    const withGraph = data.projects.filter((p) => p.graphify);
    graphView?.stop();
    graphView = null;
    if (!withGraph.length) {
      box.replaceChildren(h('h2', 'Code graph'), h('div.cr-empty', h('p.muted', 'The code graph is off for every project.'), h('p.hint', 'Switch it on for a project on the Memory page, once Graphify is installed.'), h('button.btn', { onclick: () => ctx.setTab('memory') }, 'Go to Memory')));
      return;
    }
    if (!withGraph.some((p) => p.id === picked.project)) picked.project = withGraph[0].id;
    const project = withGraph.find((p) => p.id === picked.project);
    if (!project.graphs.some((g) => g.repoId === picked.repo)) picked.repo = project.graphs[0]?.repoId ?? null;
    const info = project.graphs.find((g) => g.repoId === picked.repo);
    const head = h('div.row',
      h('h2.grow', 'Code graph'),
      withGraph.length > 1 ? h('select', { 'aria-label': 'Project', onchange: (e) => { picked.project = e.target.value; picked.repo = null; drawGraph(); } }, ...withGraph.map((p) => h('option', { value: p.id, selected: p.id === picked.project }, p.name))) : null,
      project.graphs.length > 1 ? h('select', { 'aria-label': 'Repository', onchange: (e) => { picked.repo = e.target.value; drawGraph(); } }, ...project.graphs.map((g) => h('option', { value: g.repoId, selected: g.repoId === picked.repo }, g.repoName))) : null,
      info ? h('button.btn.small', { disabled: info.state === 'building' || !data.engines.graphify.installed, onclick: async () => { try { await api('POST', `${R}/projects/${project.id}/repos/${info.repoId}/graph/rebuild`); await refresh(); } catch (e) { fail(e); } } }, info.state === 'building' ? 'Building…' : 'Rebuild') : null);
    if (!info) { box.replaceChildren(head, h('div.cr-empty', h('p.muted', 'This project has no Git repository yet.'), h('p.hint', 'Create one in Git & Sync. The graph is built from what is merged into its main branch.'))); return; }
    const facts = h('p.hint', info.commit ? ['Built from ', h('code', short(info.commit)), ` · ${info.nodes} things, ${info.edges} connections · ${ago(info.builtAt)}`, info.stale ? h('span.cr-moved', ' · main has moved on') : null] : '');
    if (info.state === 'failed') facts.append(h('span.error', ` The last build failed: ${info.error}`));
    if (!info.commit) {
      box.replaceChildren(head, facts, h('div.cr-empty', info.state === 'building' ? h('p.muted', 'Building the first map of this code…') : data.engines.graphify.installed ? h('p.muted', 'No map yet. Press Rebuild.') : h('div', h('p.muted', 'Graphify is not installed on the computer hosting this office.'), h('button.btn', { onclick: () => ctx.setTab('plugins') }, 'How to set it up'))));
      return;
    }
    const stage = h('div.cr-graph-stage');
    box.replaceChildren(head, facts, stage);
    api('GET', `${R}/projects/${project.id}/repos/${info.repoId}/graph`).then((r) => {
      if (!stage.isConnected || !r.graph) return;
      graphView = createGraphView(stage, r.graph, { source: (file) => api('GET', `${R}/projects/${project.id}/repos/${info.repoId}/graph/source?file=${encodeURIComponent(file)}`) });
    }).catch(fail);
  }

  // --- refreshing --------------------------------------------------------------------------

  async function refresh() {
    try {
      await load();
      if (roots.plugins.isConnected) drawPlugins();
      if (roots.memory.isConnected) drawMemory();
      if (roots.graph.isConnected) drawGraph();
    } catch (e) { fail(e); }
  }

  const show = (root, draw) => { load().then(() => { if (root.isConnected) draw(); }).catch(fail); return root; };

  /** The host says something changed. A form being filled in is left alone. */
  function changed(what) {
    if (document.querySelector('.cr-modal')) return;
    if (what?.kind === 'memory' && roots.memory.isConnected) { drawList(); return; }
    load().then(() => {
      if (roots.plugins.isConnected) drawPlugins();
      if (roots.graph.isConnected && what?.kind === 'graph') drawGraph();
    }).catch(() => {});
  }

  return {
    showMemory: () => show(roots.memory, drawMemory),
    showGraph: () => show(roots.graph, drawGraph),
    showPlugins: () => show(roots.plugins, drawPlugins),
    changed,
  };
}

// --- an interactive map of nodes and connections -----------------------------------------------

const COLOURS = ['#6a8dff', '#a07bff', '#4fd3b8', '#f0b44a', '#ff8fa3', '#66c7f4', '#c4e36a', '#e29cf2', '#ffb27a', '#8ee6a8'];
const MAX_DRAWN = 1500;

/**
 * Drawn on a canvas, which stays smooth with thousands of nodes. Starts with the most connected
 * things so a large codebase opens as a map rather than a hairball, and grows from whatever is
 * selected. Scroll zooms, dragging the background moves, dragging a node moves it.
 */
function createGraphView(stage, graph, { source }) {
  const degree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const neighbours = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) { neighbours.get(e.from)?.push({ edge: e, other: e.to, out: true }); neighbours.get(e.to)?.push({ edge: e, other: e.from, out: false }); }

  const canvas = h('canvas.cr-graph', { tabIndex: 0, 'aria-label': `Code graph with ${graph.nodes.length} things. Use the search box to find one, then arrow keys to move between its connections.` });
  const search = h('input', { type: 'search', placeholder: 'Find a function, class or file…', 'aria-label': 'Find in the graph' });
  const results = h('div.cr-graph-results');
  const details = h('aside.cr-graph-details');
  const count = h('span.hint');
  const limit = h('select', { 'aria-label': 'How much to show' }, ...[150, 400, MAX_DRAWN].map((n) => h('option', { value: n }, `${n} most connected`)));
  stage.replaceChildren(
    h('div.row.cr-graph-tools', h('div.grow', search), limit, count, h('button.btn.small', { onclick: () => fit() }, 'Fit')),
    results,
    h('div.cr-graph-main', h('div.cr-graph-wrap', canvas), details));

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
  const ctx2d = canvas.getContext('2d');
  let visible = new Map();
  let links = [];
  let selected = null;
  let view = { x: 0, y: 0, k: 1 };
  let heat = 1;
  let frame = null;
  let stopped = false;
  let w = 0; let hgt = 0;

  function choose() {
    const top = [...graph.nodes].sort((a, b) => degree.get(b.id) - degree.get(a.id)).slice(0, Number(limit.value));
    const keep = new Map();
    const place = (n, near) => {
      if (keep.has(n.id)) return;
      const was = visible.get(n.id);
      const angle = Math.random() * Math.PI * 2;
      keep.set(n.id, was ?? { n, x: (near?.x ?? 0) + Math.cos(angle) * (near ? 40 : 200 + Math.random() * 200), y: (near?.y ?? 0) + Math.sin(angle) * (near ? 40 : 200 + Math.random() * 200), vx: 0, vy: 0 });
    };
    for (const n of top) place(n);
    if (selected) {
      place(byId.get(selected));
      for (const { other } of neighbours.get(selected) ?? []) place(byId.get(other), keep.get(selected));
    }
    visible = keep;
    links = graph.edges.filter((e) => visible.has(e.from) && visible.has(e.to)).map((e) => ({ e, a: visible.get(e.from), b: visible.get(e.to) }));
    count.textContent = `Showing ${visible.size} of ${graph.nodes.length}`;
  }

  function step() {
    const nodes = [...visible.values()];
    const cell = 90;
    const grid = new Map();
    for (const p of nodes) { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
    for (const p of nodes) {
      const cx = Math.floor(p.x / cell); const cy = Math.floor(p.y / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${cx + i},${cy + j}`) ?? []) {
        if (p === q) continue;
        let dx = p.x - q.x; let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random(); dy = Math.random(); d2 = 1; }
        const f = (1800 / d2) * heat;
        p.vx += dx * f * 0.02; p.vy += dy * f * 0.02;
      }
      p.vx -= p.x * 0.0009 * heat; p.vy -= p.y * 0.0009 * heat;
    }
    for (const { a, b } of links) {
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 70) / d) * 0.03 * heat;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const p of nodes) {
      if (p === dragging) { p.vx = 0; p.vy = 0; continue; }
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += p.vx; p.y += p.vy;
    }
    heat *= 0.985;
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function draw() {
    const dpr = devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);
    ctx2d.translate(view.x, view.y);
    ctx2d.scale(view.k, view.k);
    const near = new Set(selected ? [selected, ...(neighbours.get(selected) ?? []).map((x) => x.other)] : []);
    const accent = css('--cr-accent');
    const line = css('--cr-ink-3');
    const ink = css('--cr-ink');
    ctx2d.lineWidth = 1 / view.k;
    for (const { e, a, b } of links) {
      const lit = selected && (e.from === selected || e.to === selected);
      ctx2d.strokeStyle = lit ? accent : line;
      ctx2d.globalAlpha = lit ? 0.95 : selected ? 0.08 : 0.28;
      ctx2d.setLineDash(e.confidence === 'INFERRED' || e.confidence === 'AMBIGUOUS' ? [4 / view.k, 4 / view.k] : []);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); ctx2d.stroke();
    }
    ctx2d.setLineDash([]);
    for (const p of visible.values()) {
      const dim = selected && !near.has(p.n.id);
      const r = Math.min(13, 3.5 + Math.sqrt(degree.get(p.n.id)) * 1.3);
      ctx2d.globalAlpha = dim ? 0.2 : 1;
      ctx2d.fillStyle = COLOURS[Math.abs(p.n.community ?? hash(p.n.file ?? p.n.label)) % COLOURS.length];
      ctx2d.beginPath(); ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2); ctx2d.fill();
      if (p.n.id === selected) { ctx2d.strokeStyle = ink; ctx2d.lineWidth = 2 / view.k; ctx2d.stroke(); ctx2d.lineWidth = 1 / view.k; }
      if (!dim && (near.has(p.n.id) || view.k > 1.1 || degree.get(p.n.id) >= 8)) {
        ctx2d.fillStyle = ink;
        ctx2d.font = `${12 / view.k}px system-ui, sans-serif`;
        ctx2d.fillText(p.n.label.slice(0, 40), p.x + r + 3 / view.k, p.y + 4 / view.k);
      }
    }
    ctx2d.globalAlpha = 1;
  }
  const hash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; };

  function loop() {
    if (stopped) return;
    if (!stage.isConnected) { stop(); return; }
    if (heat > 0.02) { step(); draw(); frame = requestAnimationFrame(loop); } else { frame = null; draw(); }
  }
  const wake = (amount = 0.5) => { heat = Math.max(heat, amount); if (!frame && !reduced) frame = requestAnimationFrame(loop); if (reduced) settle(); };
  function settle() { for (let i = 0; i < 260 && heat > 0.02; i++) step(); draw(); }

  function fit() {
    if (!visible.size) return;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const p of visible.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const k = Math.min(2, Math.max(0.05, Math.min((w - 60) / (x1 - x0 || 1), (hgt - 60) / (y1 - y0 || 1))));
    view = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: hgt / 2 - ((y0 + y1) / 2) * k };
    draw();
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    w = r.width; hgt = r.height;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, hgt * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${hgt}px`;
    draw();
  }

  async function showSource(n, into) {
    try {
      const r = await source(n.file);
      const lines = r.text.split('\n');
      const from = Math.max(0, (n.line ?? 1) - 4);
      const shown = lines.slice(from, from + 24).map((l, i) => `${String(from + i + 1).padStart(4)}  ${l}`).join('\n');
      into.replaceChildren(h('pre', shown));
    } catch (e) { into.replaceChildren(h('p.hint', e.message)); }
  }

  function select(id, { center = false } = {}) {
    selected = id;
    choose();
    const p = visible.get(id);
    const n = p?.n;
    if (!n) { details.replaceChildren(h('p.hint', 'Select something on the map to see what it connects to.')); draw(); return; }
    if (center && p) { view.x = w / 2 - p.x * view.k; view.y = hgt / 2 - p.y * view.k; }
    const list = (items, title) => (items.length ? h('div', h('h4', `${title} (${items.length})`), h('div.cr-graph-links', ...items.slice(0, 40).map(({ edge, other }) => {
      const o = byId.get(other);
      return h('button', { onclick: () => select(other, { center: true }), title: edge.confidence === 'EXTRACTED' ? 'Read directly from the code' : edge.confidence === 'INFERRED' ? 'Worked out by Graphify' : '' }, h('span.hint', edge.relation), ' ', o?.label ?? '?');
    }))) : null);
    const all = neighbours.get(id) ?? [];
    const sourceBox = h('div');
    details.replaceChildren(...[
      h('h3', n.label),
      n.file ? h('p.hint', h('code', `${n.file}${n.line ? `:${n.line}` : ''}`)) : null,
      list(all.filter((x) => x.out), 'Uses'),
      list(all.filter((x) => !x.out), 'Used by'),
      n.file ? h('div', h('button.btn.small', { onclick: () => showSource(n, sourceBox) }, 'Show the code'), sourceBox) : null,
    ].filter(Boolean));
    wake(0.25);
    draw();
  }

  const toWorld = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; };
  function hit(e) {
    const m = toWorld(e);
    let best = null; let bestD = (14 / view.k) ** 2;
    for (const p of visible.values()) { const d = (p.x - m.x) ** 2 + (p.y - m.y) ** 2; if (d < bestD) { best = p; bestD = d; } }
    return best;
  }
  let dragging = null;
  let panning = null;
  let moved = false;
  let pressedAt = null;
  const wandered = (e) => pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    moved = false;
    pressedAt = { x: e.clientX, y: e.clientY };
    dragging = hit(e);
    if (!dragging) panning = { x: e.clientX - view.x, y: e.clientY - view.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging || panning) {
      if (!moved && !wandered(e)) return;
      moved = true;
      if (dragging) { const m = toWorld(e); dragging.x = m.x; dragging.y = m.y; wake(0.15); draw(); } else { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; draw(); }
      return;
    }
    canvas.style.cursor = hit(e) ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerup', (e) => {
    const onNode = dragging;
    dragging = null; panning = null; pressedAt = null;
    if (moved) return;
    if (onNode) select(onNode.n.id); else select(null);
    canvas.focus({ preventScroll: true });
    e.stopPropagation();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    const k = Math.min(5, Math.max(0.03, view.k * (e.deltaY < 0 ? 1.13 : 1 / 1.13)));
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    draw();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (!selected) return;
    const near = neighbours.get(selected) ?? [];
    if (['ArrowRight', 'ArrowDown'].includes(e.key) && near.length) { e.preventDefault(); e.stopPropagation(); select(near[0].other, { center: true }); }
    if (['ArrowLeft', 'ArrowUp'].includes(e.key) && near.length) { e.preventDefault(); e.stopPropagation(); select(near[near.length - 1].other, { center: true }); }
    if (e.key === 'Escape') { e.stopPropagation(); select(null); }
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { results.replaceChildren(); return; }
    const found = graph.nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.file ?? '').toLowerCase().includes(q)).sort((a, b) => degree.get(b.id) - degree.get(a.id)).slice(0, 8);
    results.replaceChildren(...found.map((n) => h('button', { onclick: () => { results.replaceChildren(); search.value = n.label; select(n.id, { center: true }); } }, h('b', n.label), n.file ? h('span.hint', ` ${n.file}`) : null)));
    if (!found.length) results.replaceChildren(h('p.hint', 'Nothing by that name.'));
  });
  limit.addEventListener('change', () => { choose(); heat = 1; wake(1); setTimeout(fit, reduced ? 0 : 900); });

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas.parentElement);
  function stop() { stopped = true; if (frame) cancelAnimationFrame(frame); observer.disconnect(); }

  choose();
  resize();
  details.replaceChildren(h('p.hint', 'Select something on the map to see what it connects to. Solid lines were read directly from the code; dashed ones were worked out by Graphify.'));
  if (reduced) { heat = 1; settle(); fit(); } else { wake(1); setTimeout(() => { if (!stopped) fit(); }, 900); }
  return { stop };
}

