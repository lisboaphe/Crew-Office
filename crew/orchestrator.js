// The Orchestrator: draw who does what and in what order, save it, and run it.
//
// The editor is its own little world of DOM and SVG. It keeps its state across the office's
// updates, because a playbook half drawn must not be redrawn by a heartbeat. A run is ordinary
// tasks on the host (lib/crew/playbooks.cjs), so the monitor reads the same state the rest of the
// app does, and clicking anything opens the real logs and files.

import { h, api, toast, modal, ago, helpTip } from './common.js';
import { openGuidedTour } from './tutorial.js';

const NODE = {
  lead: { label: 'Lead Agent', hint: 'Owns the run and writes the final summary.', color: '#9b6dff' },
  worker: { label: 'Worker Agent', hint: 'Connect to a step to give it that step.', color: '#4f8cff' },
  task: { label: 'Task', hint: 'A piece of work for an agent.', color: '#39b58a' },
  dependency: { label: 'Dependency', hint: 'Waits for everything coming in, then lets the rest go.', color: '#7c8aa5' },
  condition: { label: 'Condition', hint: 'Runs or skips what comes next, by how the steps before ended.', color: '#e0a83c' },
  review: { label: 'Code Review', hint: 'An agent reviews the steps before it.', color: '#20a7c9' },
  test: { label: 'Test', hint: 'An agent runs the tests and reports the real result.', color: '#6bbd4b' },
  approval: { label: 'Approval', hint: 'Waits for you, if approvals are on.', color: '#e0764a' },
  merge: { label: 'Merge', hint: 'Checks the work really merged. Merging itself goes through review.', color: '#d364b8' },
  completion: { label: 'Completion', hint: 'The end of a path.', color: '#8b95a9' },
};
const TOUR_SEEN = 'crew.orchestratorTourSeen';
const W = 190;
const H = 66;
const STATE_TONE = { completed: 'ok', in_progress: 'run', queued: 'run', review: 'run', awaiting_approval: 'wait', waiting: 'wait', pending: 'idle', failed: 'bad', blocked: 'bad', cancelled: 'muted' };
const POLICY = [
  ['approvals', 'Ask for approvals', 'Off means Approval nodes pass by themselves, and the project runs autonomously. Deletes and rollbacks always ask.'],
  ['requireReview', 'Another agent reviews before merging', null],
  ['testsBeforeDone', 'Run tests before marking done', null],
  ['createRepo', 'Give the run a Git repository', 'Each agent then works on its own branch and merges through review.'],
  ['progressReports', 'Write progress reports', null],
  ['handoffNotes', 'Write handoff notes when delegating', null],
  ['updateReadme', 'Update the README at the end', null],
];

const svg = (tag, attrs = {}) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const curve = (a, b) => { const x1 = a.x + W; const y1 = a.y + H / 2; const x2 = b.x; const y2 = b.y + H / 2; const d = Math.max(40, Math.abs(x2 - x1) / 2); return `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`; };

/** A graph on a pannable, zoomable canvas. Editable, or read-only for watching a run. */
function createCanvas({ graph, readOnly = false, onSelect = () => {}, onChange = () => {}, decorate = null }) {
  let view = { x: 20, y: 20, k: 0.85 };
  let selected = null;
  const edgesSvg = svg('svg', { class: 'cr-canvas-edges' });
  const nodesEl = h('div.cr-canvas-nodes');
  const world = h('div.cr-canvas-world', edgesSvg, nodesEl);
  const zoomOut = h('button.btn.small', { 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, '−');
  const zoomIn = h('button.btn.small', { 'aria-label': 'Zoom in', onclick: () => zoomBy(1.2) }, '+');
  const fit = h('button.btn.small', { onclick: () => fitAll() }, 'Fit');
  const el = h('div.cr-canvas', { tabIndex: 0, 'aria-label': 'Playbook canvas' }, world, h('div.cr-canvas-zoom', zoomOut, fit, zoomIn));
  let pending = null;

  const apply = () => { world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; };
  function zoomBy(f, cx = el.clientWidth / 2, cy = el.clientHeight / 2) {
    const k = Math.min(1.6, Math.max(0.35, view.k * f));
    view.x = cx - ((cx - view.x) / view.k) * k;
    view.y = cy - ((cy - view.y) / view.k) * k;
    view.k = k;
    apply();
  }
  function fitAll() {
    if (!graph.nodes.length) return;
    const xs = graph.nodes.map((n) => n.x); const ys = graph.nodes.map((n) => n.y);
    const w = Math.max(...xs) - Math.min(...xs) + W + 60; const hh = Math.max(...ys) - Math.min(...ys) + H + 60;
    const k = Math.min(1.1, Math.max(0.35, Math.min((el.clientWidth || 800) / w, (el.clientHeight || 400) / hh)));
    view = { k, x: 30 - Math.min(...xs) * k, y: 30 - Math.min(...ys) * k };
    apply();
  }
  const toWorld = (e) => { const r = el.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; };

  function drawEdges(preview = null) {
    edgesSvg.replaceChildren();
    const at = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      if (!at[e.from] || !at[e.to]) continue;
      const path = svg('path', { d: curve(at[e.from], at[e.to]), class: `cr-edge${selected === `e:${e.from}>${e.to}` ? ' on' : ''}` });
      if (!readOnly) {
        const hit = svg('path', { d: curve(at[e.from], at[e.to]), class: 'cr-edge-hit' });
        hit.addEventListener('click', (ev) => { ev.stopPropagation(); selected = `e:${e.from}>${e.to}`; onSelect(null, { edge: true }); draw(); el.focus(); });
        edgesSvg.append(hit);
      }
      edgesSvg.append(path);
    }
    if (preview) edgesSvg.append(svg('path', { d: curve(preview.from, { x: preview.to.x, y: preview.to.y - H / 2 }), class: 'cr-edge preview' }));
  }

  function drawNodes() {
    nodesEl.replaceChildren(...graph.nodes.map((n) => {
      const def = NODE[n.type];
      const deco = decorate?.(n) ?? {};
      const box = h('div.cr-node', { class: `${n.id === selected ? 'on' : ''} ${deco.tone ? `tone-${deco.tone}` : ''}`, style: { left: `${n.x}px`, top: `${n.y}px`, '--node': def.color }, tabIndex: 0, role: 'button', 'aria-label': `${def.label}: ${n.config.title ?? ''}` },
        h('span.cr-node-type', def.label), h('b', deco.title ?? n.config.title ?? def.label), deco.sub ? h('span.hint', deco.sub) : null);
      if (!readOnly) {
        const output = h('span.cr-port.out', { title: 'Drag to connect' });
        const input = h('span.cr-port.in');
        output.addEventListener('pointerdown', (e) => startConnect(e, n));
        input.dataset.node = n.id;
        box.append(input, output);
      }
      box.addEventListener('pointerdown', (e) => startDrag(e, n));
      // draw() replaces the clicked box, which takes keyboard focus with it, so hand focus back to the
      // canvas or the Delete key goes nowhere.
      box.addEventListener('click', (e) => { e.stopPropagation(); selected = n.id; onSelect(n); draw(); if (!readOnly) el.focus(); });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { selected = n.id; onSelect(n); draw(); } });
      return box;
    }));
  }
  const draw = () => { drawEdges(); drawNodes(); };

  function startDrag(e, n) {
    if (readOnly || e.target.classList.contains('cr-port')) return;
    e.stopPropagation();
    const from = toWorld(e); const ox = n.x; const oy = n.y; let moved = false;
    const box = e.currentTarget;
    const move = (m) => { const p = toWorld(m); n.x = Math.round(ox + p.x - from.x); n.y = Math.round(oy + p.y - from.y); moved = true; box.style.left = `${n.x}px`; box.style.top = `${n.y}px`; if (!pending) pending = requestAnimationFrame(() => { pending = null; drawEdges(); }); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) onChange(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startConnect(e, n) {
    e.stopPropagation(); e.preventDefault();
    const move = (m) => drawEdges({ from: n, to: toWorld(m) });
    const up = (u) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const target = document.elementFromPoint(u.clientX, u.clientY)?.closest('.cr-node');
      const id = target?.querySelector('.cr-port.in')?.dataset.node;
      if (id && id !== n.id && !graph.edges.some((x) => x.from === n.id && x.to === id)) { graph.edges.push({ from: n.id, to: id }); onChange(); }
      drawEdges();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cr-node, .cr-canvas-zoom')) return;
    selected = null; onSelect(null);
    const sx = e.clientX - view.x; const sy = e.clientY - view.y; let moved = false;
    const move = (m) => { moved = true; view.x = m.clientX - sx; view.y = m.clientY - sy; apply(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (!moved) draw(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  /** Remove the selected step (with its connections) or connection. The Delete key and the inspector's button both come here. */
  function removeSelected() {
    if (readOnly || !selected) return;
    if (selected.startsWith('e:')) { const [from, to] = selected.slice(2).split('>'); graph.edges = graph.edges.filter((x) => !(x.from === from && x.to === to)); } else {
      graph.nodes = graph.nodes.filter((x) => x.id !== selected);
      graph.edges = graph.edges.filter((x) => x.from !== selected && x.to !== selected);
    }
    selected = null; onSelect(null); onChange(); draw();
  }
  if (!readOnly) {
    // The key only reaches here while the canvas has focus, which clicking into the inspector
    // takes away: that is why the inspector has a button for the same thing.
    el.addEventListener('keydown', (e) => {
      if (!['Delete', 'Backspace'].includes(e.key) || !selected || e.target.matches('input,textarea,select')) return;
      removeSelected();
    });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => { e.preventDefault(); const type = e.dataTransfer.getData('text/crew-node'); if (type) addNode(type, toWorld(e)); });
  }
  function addNode(type, at = null) {
    const id = `n${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`;
    const p = at ?? { x: (el.clientWidth / 2 - view.x) / view.k - W / 2 + Math.random() * 30, y: (el.clientHeight / 2 - view.y) / view.k - H / 2 + Math.random() * 30 };
    const n = { id, type, x: Math.round(p.x), y: Math.round(p.y), config: type === 'condition' ? { when: 'all_succeeded' } : {} };
    graph.nodes.push(n);
    selected = id; onSelect(n); onChange(); draw(); el.focus();
    return n;
  }
  apply(); draw();
  const replace = (g) => { graph = g; selected = null; draw(); fitAll(); };
  return { el, draw, addNode, removeSelected, fitAll, replace, get graph() { return graph; } };
}

/** Everything the Orchestrator keeps between visits. */
export function createOrchestrator(ctx) {
  const { S, roomId } = ctx;
  const R = `/api/crew/rooms/${roomId}`;
  let data = { playbooks: [], runs: [], templates: [] };
  let current = null;
  let dirty = false;
  let watching = null;
  let runTimer = null;

  const editorRoot = h('div.cr-orch');
  const runsRoot = h('div.cr-runs');

  async function load() {
    data = await api('GET', `${R}/playbooks`);
    if (current && !data.playbooks.some((p) => p.id === current.id)) { current = null; dirty = false; }
    return data;
  }

  // --- the list and the editor -----------------------------------------------------------

  function drawEditor() {
    if (!current) { editorRoot.replaceChildren(drawList()); return; }
    editorRoot.replaceChildren(drawBoard());
  }

  function drawList() {
    return h('div',
      h('div.row', h('h2.grow', 'Playbooks'), h('button.btn.small', { onclick: tour, title: 'A guided tour of the Orchestrator' }, 'How it works'), helpTip('What is a playbook?', ['A saved plan of who does what, and in what order.', 'Start from a template and choose your agents.', 'Run it with a goal. Each step becomes a real task you can watch.'])),
      data.playbooks.length ? h('div.cr-list', ...data.playbooks.map((p) => h('div.cr-item.click.row', { onclick: () => { current = structuredClone(p); dirty = false; drawEditor(); } }, h('div.grow', h('b', p.name), h('div.hint', `${p.graph.nodes.length} steps · ${p.description || 'No description'}`)), h('span.hint', ago(p.updatedAt))))) : h('p.hint', 'No playbooks yet. Start from one of these:'),
      h('h3', 'Start from a template'),
      h('div.cr-preset-grid', ...data.templates.map((t) => h('button.cr-preset', { onclick: () => create({ templateId: t.id }) }, h('b', t.name), h('span.hint', t.description))),
        h('button.cr-preset', { onclick: () => create({ name: 'New playbook', graph: { nodes: [], edges: [] } }) }, h('b', 'Blank canvas'), h('span.hint', 'Build it yourself.'))));
  }

  async function create(body) {
    try {
      const { playbook } = await api('POST', `${R}/playbooks`, body);
      await load();
      current = structuredClone(playbook); dirty = false; drawEditor();
    } catch (e) { toast(e.message, 6000); }
  }

  function drawBoard() {
    const inspector = h('aside.cr-inspector');
    const saveBtn = h('button.btn.primary', { onclick: save }, 'Save');
    const name = h('input.cr-title-input', { value: current.name, 'aria-label': 'Playbook name', oninput: () => { current.name = name.value; markDirty(); } });
    const markDirty = () => { dirty = true; saveBtn.textContent = 'Save*'; };
    const canvas = createCanvas({ graph: current.graph, onChange: markDirty, onSelect: (n, how) => drawInspector(inspector, n, canvas, markDirty, how) });
    async function save() {
      try {
        const { playbook } = await api('PUT', `${R}/playbooks/${current.id}`, { name: current.name, graph: canvas.graph, policy: current.policy });
        current = structuredClone(playbook); current.graph = canvas.graph; dirty = false; saveBtn.textContent = 'Save'; toast('Saved');
        await load();
      } catch (e) { toast(e.message, 6000); }
    }
    current.graph = canvas.graph;
    const palette = h('div.cr-palette', ...Object.entries(NODE).map(([type, def]) => h('button.cr-chip', { draggable: true, title: def.hint, style: { '--node': def.color }, onclick: () => canvas.addNode(type), ondragstart: (e) => e.dataTransfer.setData('text/crew-node', type) }, def.label)));
    drawInspector(inspector, null, canvas, markDirty);
    setTimeout(() => canvas.fitAll());
    return h('div.cr-board',
      h('div.cr-board-head', h('button.btn.small', { onclick: () => { if (dirty && !confirm('Leave without saving?')) return; current = null; dirty = false; drawEditor(); } }, '← Playbooks'), name, h('span.grow'),
        h('button.btn.small', { onclick: tour, title: 'A guided tour of the Orchestrator' }, 'How it works'), h('button.btn.small.danger', { onclick: remove }, 'Delete'), saveBtn, h('button.btn.primary.cr-run-btn', { onclick: async () => { await save(); startRun(); } }, 'Run')),
      palette, h('div.cr-board-main', canvas.el, inspector));
  }

  async function remove() {
    if (!confirm(`Delete the playbook “${current.name}”? Runs it already started are kept.`)) return;
    try { await api('DELETE', `${R}/playbooks/${current.id}`); current = null; dirty = false; await load(); drawEditor(); } catch (e) { toast(e.message, 6000); }
  }

  function drawInspector(box, n, canvas, markDirty, how = {}) {
    if (!n && how.edge) {
      box.replaceChildren(h('h3', 'Connection'), h('p.hint', 'The step it leads to waits for the one it comes from.'),
        h('button.btn.small.danger', { onclick: () => canvas.removeSelected() }, 'Remove connection'));
      return;
    }
    if (!n) {
      const budget = h('input', { type: 'number', min: 1, max: 100, value: current.policy.taskBudgetPct ?? '', placeholder: 'none', style: { width: '80px' }, onchange: () => { current.policy.taskBudgetPct = budget.value === '' ? null : Number(budget.value); markDirty(); } });
      box.replaceChildren(h('h3', 'Rules for this playbook'),
        ...POLICY.map(([k, label, hint]) => { const c = h('input', { type: 'checkbox', checked: Boolean(current.policy[k]), onchange: () => { current.policy[k] = c.checked; markDirty(); } }); return h('label.cr-check', c, h('span', label, hint ? h('span.hint', ` ${hint}`) : null)); }),
        h('div.cr-field', h('label', 'Per-task usage share'), h('div.row', budget, h('span.hint', '% of your own estimate')), h('p.hint', 'Only applies if you set a capacity on your worker. It is an estimate, not a hard limit from the provider.')),
        h('p.hint', 'Drag from a node’s right edge to another node to connect them. Steps with no connection between them run at the same time. Select a step or connection to remove it, with its button or the Delete key.'));
      return;
    }
    const def = NODE[n.type];
    const parts = [h('h3', def.label), h('p.hint', def.hint)];
    const set = (k, v) => { n.config[k] = v || undefined; markDirty(); canvas.draw(); };
    if (n.type === 'lead' || n.type === 'worker') {
      const agents = n.type === 'lead' ? S.agents.filter((a) => a.ownerId === S.me.id) : S.agents;
      const sel = h('select', { onchange: () => { set('agentId', sel.value); set('title', S.agents.find((a) => a.id === sel.value)?.name); } }, h('option', { value: '' }, 'Choose an agent…'), ...agents.map((a) => h('option', { value: a.id, selected: n.config.agentId === a.id }, `${a.name} (${a.role}, ${a.ownerName})`)));
      parts.push(h('div.cr-field', h('label', 'Agent'), sel));
      if (n.config.agentId && S.agents.find((a) => a.id === n.config.agentId)?.ownerId !== S.me.id) parts.push(h('p.cr-provider-note', 'This is another player’s agent. They are asked when the run starts, and the step waits until they lend it. It runs on their computer and their plan.'));
      if (n.config.agentId) parts.push(h('button.btn.small', { onclick: () => ctx.openAgent(n.config.agentId) }, 'Open agent editor'));
    } else if (!['completion', 'dependency'].includes(n.type)) {
      const title = h('input', { value: n.config.title ?? '', placeholder: def.label, oninput: () => set('title', title.value) });
      parts.push(h('div.cr-field', h('label', 'Name'), title));
    }
    if (['task', 'review', 'test'].includes(n.type)) {
      const desc = h('textarea', { value: n.config.description ?? '', rows: 4, placeholder: 'What should be done? Leave empty to use the run’s goal.', oninput: () => { n.config.description = desc.value || undefined; markDirty(); } });
      const role = h('input', { value: n.config.roleHint ?? '', placeholder: 'e.g. Backend', oninput: () => set('roleHint', role.value) });
      parts.push(h('div.cr-field', h('label', 'Instructions'), desc), h('div.cr-field', h('label', 'Or pick the best agent for this role'), role, h('p.hint', 'Used when no Worker Agent is connected.')));
    }
    if (n.type === 'condition') {
      const when = h('select', { onchange: () => set('when', when.value) }, h('option', { value: 'all_succeeded', selected: n.config.when !== 'any_failed' }, 'Continue if everything before succeeded'), h('option', { value: 'any_failed', selected: n.config.when === 'any_failed' }, 'Continue only if something before failed'));
      parts.push(h('div.cr-field', h('label', 'When'), when));
    }
    parts.push(h('div.actions', h('button.btn.small.danger', { onclick: () => canvas.removeSelected() }, 'Remove step')));
    box.replaceChildren(...parts);
  }

  function startRun() {
    modal(`Run “${current.name}”`, (close) => {
      const goal = h('textarea', { rows: 4, placeholder: 'What should this run achieve? e.g. Build a small task management web app.' });
      const err = h('p.error');
      const go = async () => {
        err.textContent = '';
        try {
          const { run } = await api('POST', `${R}/playbooks/${current.id}/run`, { goal: goal.value });
          close();
          toast('Started');
          await load();
          ctx.showRuns(run.id);
        } catch (e) { err.textContent = e.message; }
      };
      return h('div', h('div.cr-field', h('label', 'Goal'), goal), h('p.hint', 'Each step becomes a real task. Your agents use your own connections; a limit pauses the work, and nothing switches to a paid API.'), err,
        h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: go }, 'Start')));
    });
  }

  // --- the guided tour ---------------------------------------------------------------------

  const here = (sel) => () => editorRoot.querySelector(sel);
  let touring = null;

  function tour() {
    touring?.close();
    const example = data.templates.find((t) => t.id === 'build-review') ?? data.templates[0];
    touring = openGuidedTour({
      label: 'How the Orchestrator works',
      onClose: () => { touring = null; try { localStorage.setItem(TOUR_SEEN, '1'); } catch { /* it may offer again */ } },
      steps: [
        { title: 'The Orchestrator', lines: [
          'You draw who does what, and in what order. That drawing is a playbook, and you can run it as many times as you like.',
          'A run is not a simulation. Each step becomes a real task on the board, done by a real agent, on its owner’s computer and with its owner’s connection.',
          'You can try everything as we go: this tour does not block the page.',
        ] },
        { title: 'Start from a template', spot: () => (current ? null : editorRoot.querySelector('.cr-preset-grid')), lines: [
          'Four ready-made shapes: one agent, build and review, parallel workers, and try-then-rescue.',
          'Choosing one only makes a draft. Nothing runs until you press Run.',
        ], action: !current && example ? { label: `Open “${example.name}” as a draft to follow along`, run: () => create({ templateId: example.id }) } : undefined,
        away: 'You already have a playbook open, so the templates are behind ← Playbooks.' },
        { title: 'The ten kinds of step', spot: here('.cr-palette'), away: 'Open a playbook to see these.', lines: [
          'Lead and Worker are agents. The Lead owns the run and writes the final summary. A Worker does the steps it is connected to.',
          'Task, Code Review and Test are work for an agent to do.',
          'Condition, Approval, Merge and Completion have no AI in them. The office settles those itself, from what really happened.',
          'Click one to add it, or drag it onto the board.',
        ] },
        { title: 'Connect them', spot: here('.cr-canvas'), away: 'Open a playbook to see the board.', lines: [
          'Drag from a step’s right edge to another step: the second waits for the first.',
          'Steps with no connection between them run at the same time. That is how you get parallel work.',
          'Connect a Worker to a Task to give it that task. With none connected, you can name a role and the best agent for it is picked.',
          'Select a step or connection and press Remove, or the Delete key, to take it out. Scroll to zoom, drag the background to move.',
        ] },
        { title: 'Choose who does it', spot: here('.cr-inspector'), away: 'Open a playbook to see this panel.', lines: [
          'Click a step and this panel shows its settings: which agent, or what to do.',
          'You can name a friend’s agent. They are asked when the run starts, the step waits until they lend it, and it runs on their computer and their plan.',
          'The Lead has to be one of your own.',
        ] },
        { title: 'Set the rules', spot: here('.cr-inspector'), away: 'Open a playbook to see this panel.', lines: [
          'Click the empty board and this panel shows the rules for the whole playbook: approvals, another agent reviewing before a merge, tests before done, a Git repository.',
          'With approvals off, Approval steps pass by themselves. Deleting things and rolling back still ask, whatever you set here.',
        ] },
        { title: 'Run it', spot: here('.cr-run-btn'), away: 'Open a playbook to see the Run button.', lines: [
          'Run saves the playbook and asks for a goal, such as “Build a small task management web app”.',
          'Every agent needs its worker online. A step that cannot start says why and waits.',
          'A usage limit pauses the work. Nothing switches to a paid API by itself.',
        ] },
        { title: 'Watch it happen', spot: () => document.querySelector('.cr-tabs'), lines: [
          'The Runs tab shows the same board, lit up by what each step is really doing. Click any step to open its logs and files.',
          'Agents also work in the office itself, and talk in the project’s channel in the chat on the right.',
          'Approvals wait for you at the tick at the top of the screen.',
        ] },
        { title: 'What agents can use', lines: [
          'A run is an ordinary project, so if Memory & Knowledge is on for it, its agents get relevant memories and a map of the code before they start.',
          'That material is treated as information only. It never changes what an agent is allowed to do.',
          'Stop All AI Activity at the top of the screen stops everything, at any moment.',
        ] },
      ],
    });
  }

  // --- watching a run --------------------------------------------------------------------

  function drawRuns() {
    if (watching) return;
    runsRoot.replaceChildren(h('h2', 'Runs'), data.runs.length
      ? h('div.cr-list', ...data.runs.map((r) => {
        const tasks = Object.values(r.tasks);
        const done = tasks.filter((t) => t.status === 'completed').length;
        return h('div.cr-item.click', { onclick: () => watch(r.id) }, h('div.row', h('b.grow', r.name), h('span.pill', r.status)), h('div.cr-progress', h('div', { style: { width: `${tasks.length ? (100 * done) / tasks.length : 0}%` } })), h('div.hint', `${done} of ${tasks.length} steps · ${ago(r.createdAt)}`));
      }))
      : h('p.hint', 'No runs yet. Open a playbook and press Run.'));
  }

  async function watch(id) {
    watching = id;
    clearInterval(runTimer);
    runTimer = setInterval(() => { if (runsRoot.isConnected) drawRun(); }, 4000);
    await drawRun();
  }

  function stopWatching() { clearInterval(runTimer); watching = null; load().then(drawRuns); }

  async function drawRun() {
    if (!watching) return;
    let run;
    try { ({ run } = await api('GET', `${R}/runs/${watching}`)); } catch (e) { toast(e.message); stopWatching(); return; }
    const tasks = Object.values(run.tasks);
    const count = (...states) => tasks.filter((t) => states.includes(t.status)).length;
    const decorate = (n) => {
      const t = run.tasks[n.id];
      const a = run.agents[n.id];
      if (t) return { tone: STATE_TONE[t.status] ?? 'idle', sub: `${t.status.replace(/_/g, ' ')}${t.assignedAgentName ? ` · ${t.assignedAgentName}` : ''}` };
      if (a) return { tone: a.granted ? (['WORKING', 'PLANNING', 'REVIEW'].includes(a.status) ? 'run' : 'idle') : 'wait', title: a.name, sub: a.granted ? `${a.status.toLowerCase()} · ${a.ownerName}` : `waiting for ${a.ownerName} to lend it` };
      return {};
    };
    const canvas = createCanvas({ graph: run.graph, readOnly: true, decorate, onSelect: (n) => {
      if (!n) return;
      if (run.tasks[n.id]) ctx.taskDetail(run.tasks[n.id]);
      else if (run.agents[n.id]) ctx.openAgent(run.agents[n.id].id);
    } });
    const lead = S.agents.find((a) => a.id === run.leadAgentId);
    const workers = Object.values(run.agents).filter((a) => a && ['WORKING', 'PLANNING', 'REVIEW', 'ASSIGNED'].includes(a.status));
    const stat = (label, n, tone = '') => h('div.cr-stat-tile', { class: tone }, h('b', n), h('span.hint', label));
    const wanting = Object.values(run.agents).filter((a) => a && !a.granted);
    const tests = run.deliverables.filter((d) => d.kind === 'test_result');
    const files = run.deliverables.filter((d) => d.kind !== 'test_result');
    const list = (items, render, empty) => (items.length ? h('div.cr-list', ...items.map(render)) : h('p.hint', empty));
    runsRoot.replaceChildren(...[
      h('div.row', h('button.btn.small', { onclick: stopWatching }, '← Runs'), h('h2.grow', run.name), h('span.pill', run.status)),
      h('p.hint', run.goal),
      h('dl.cr-kv.tight', h('dt', 'Lead'), h('dd', lead?.name ?? 'Unknown'), h('dt', 'Active workers'), h('dd', workers.length ? workers.map((a) => a.name).join(', ') : 'None right now'), h('dt', 'Tokens processed'), h('dd', run.tokens.toLocaleString())),
      h('div.cr-stat-row', stat('Running', count('in_progress', 'queued', 'review'), 'run'), stat('Waiting', count('pending', 'waiting', 'awaiting_approval'), 'wait'), stat('Completed', count('completed'), 'ok'), stat('Failed', count('failed', 'blocked'), 'bad')),
      wanting.length ? h('p.cr-provider-note', `Waiting for ${[...new Set(wanting.map((a) => a.ownerName))].join(', ')} to lend ${wanting.map((a) => a.name).join(', ')} to this project.`) : null,
      h('div.cr-run-canvas', canvas.el),
      run.summary ? h('div.cr-item', h('h3', 'Final result'), h('div', run.summary)) : null,
      h('h3', 'Deliverables'), list(files, (d) => h('div.cr-item.click.row', { onclick: () => ctx.viewFile(run.projectId, d.path) }, h('code.grow', d.path), h('span.hint', d.kind)), 'No files yet.'),
      h('h3', 'Test results'), list(tests, (d) => h('div.cr-item.click.row', { onclick: () => ctx.viewFile(run.projectId, d.path) }, h('code.grow', d.path)), 'No tests have run yet.'),
      h('h3', 'Git'), list(run.git, (g) => h('div.cr-item.row', h('span.grow', `${g.kind.replace(/_/g, ' ')}${g.ref ? `: ${g.ref}` : ''}`), g.new ? h('code', String(g.new).slice(0, 8)) : null, h('span.hint', ago(g.created_at))), 'No Git activity in this run.'),
      h('h3', 'Agent communication'), list(run.messages.slice(-15), ctx.messageView, 'No messages yet.')].filter(Boolean));
    setTimeout(() => canvas.fitAll());
  }

  /** Called when the Orchestrator's tabs are shown. */
  const showEditor = () => { if (!editorRoot.firstChild) editorRoot.replaceChildren(h('p.hint', 'Loading playbooks…')); load().then(() => { if (!current || !editorRoot.firstChild) drawEditor(); offerTour(); }).catch((e) => toast(e.message)); return editorRoot; };
  const showRuns = (id = null) => { load().then(() => { if (id) watch(id); else drawRuns(); }).catch((e) => toast(e.message)); return runsRoot; };

  /** Someone saved a playbook. The list can follow; a board somebody is drawing on stays put. */
  const changed = () => load().then(() => { if (!current && editorRoot.isConnected) drawEditor(); if (!watching && runsRoot.isConnected) drawRuns(); }).catch(() => {});

  const playbooksUsing = (agentId) => data.playbooks.filter((p) => p.graph.nodes.some((n) => n.config.agentId === agentId));

  /** The wizard's "put them in this playbook": a worker node with this agent, ready to connect. */
  async function addToPlaybook(playbookId, agent) {
    const p = data.playbooks.find((x) => x.id === playbookId);
    if (!p) return;
    const graph = structuredClone(p.graph);
    const y = Math.max(0, ...graph.nodes.map((n) => n.y)) + 120;
    graph.nodes.push({ id: `n${Date.now().toString(36)}`, type: 'worker', x: 60, y, config: { agentId: agent.id, title: agent.name } });
    await api('PUT', `${R}/playbooks/${playbookId}`, { graph });
    await load();
  }

  /** Once per browser, the first time someone opens the Orchestrator. */
  function offerTour() {
    let seen = true;
    try { seen = localStorage.getItem(TOUR_SEEN) === '1'; } catch { /* no memory, so do not nag */ }
    if (!seen && !touring && editorRoot.isConnected) setTimeout(tour, 350);
  }

  /** The page went away: a tour pointing at it has nothing left to point at. */
  const closeTour = () => touring?.close();

  load().catch(() => {});
  return { showEditor, showRuns, changed, playbooksUsing, addToPlaybook, tour, closeTour, playbooks: () => data.playbooks };
}
