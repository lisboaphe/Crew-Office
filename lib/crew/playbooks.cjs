// Playbooks: a saved graph of who does what, in what order, compiled into the ordinary task engine.
//
// Nothing runs here. A run is a project whose tasks come from the graph instead of a manager's
// plan, so scheduling, workers, permissions, approvals, Git and logs are the same code as any
// other project, and what the monitor shows is that real state. The idea of named strategies
// and the shape of a run budget come from the MIT-licensed alethe-orchestrate-skill (see NOTICE);
// this is an original implementation for this architecture.
//
// A few nodes have no agent, and the host settles them itself in tick():
//   condition   passes or skips a branch by how its inputs ended
//   approval    waits for a person (or passes, if the playbook has approvals off)
//   merge       checks that the upstream work really merged, by asking the merge requests
//   completion  marks the end of a path

'use strict';

const { newId, now, json, parse } = require('./db.cjs');
const { httpError, cleanName } = require('./auth.cjs');

const NODE_TYPES = ['lead', 'worker', 'task', 'dependency', 'condition', 'review', 'test', 'approval', 'merge', 'completion'];
const AGENT_NODES = new Set(['lead', 'worker']);
const WORK_NODES = new Set(['task', 'review', 'test']);
const GATE_NODES = new Set(['condition', 'approval', 'merge', 'completion']);
const MAX_NODES = 80;
const DEFAULT_POLICY = { approvals: true, requireReview: true, testsBeforeDone: true, updateReadme: false, progressReports: false, handoffNotes: false, createRepo: false, taskBudgetPct: null };

function node(id, type, x, y, config = {}) { return { id, type, x, y, config }; }
function edge(from, to) { return { from, to }; }

const TEMPLATES = [
  {
    id: 'single', name: 'One agent', description: 'The simplest start: one agent does the task, and you get the result.',
    graph: { nodes: [node('w', 'worker', 60, 120), node('t', 'task', 320, 120, { title: 'Do the work' }), node('c', 'completion', 580, 120)], edges: [edge('w', 't'), edge('t', 'c')] },
    policy: { requireReview: false, approvals: false },
  },
  {
    id: 'build-review', name: 'Build and review', description: 'One agent builds, another reviews, and you approve before it counts as done.',
    graph: { nodes: [node('l', 'lead', 60, 40), node('w', 'worker', 60, 220), node('t', 'task', 320, 220, { title: 'Build it' }), node('r', 'worker', 320, 40), node('v', 'review', 580, 220, { title: 'Review the work' }), node('a', 'approval', 840, 220, { title: 'Approve the result' }), node('c', 'completion', 1100, 220)], edges: [edge('w', 't'), edge('t', 'v'), edge('r', 'v'), edge('v', 'a'), edge('a', 'c')] },
  },
  {
    id: 'parallel', name: 'Parallel workers', description: 'Two agents work side by side, then one tests the combined result.',
    graph: { nodes: [node('l', 'lead', 60, 20), node('w1', 'worker', 60, 140), node('w2', 'worker', 60, 300), node('t1', 'task', 320, 140, { title: 'First part' }), node('t2', 'task', 320, 300, { title: 'Second part' }), node('q', 'worker', 580, 60), node('x', 'test', 580, 220, { title: 'Test it together' }), node('c', 'completion', 840, 220)], edges: [edge('w1', 't1'), edge('w2', 't2'), edge('t1', 'x'), edge('t2', 'x'), edge('q', 'x'), edge('x', 'c')] },
  },
  {
    id: 'rescue', name: 'Try, then rescue', description: 'If the first attempt fails, a second agent takes over. It only runs when it is needed.',
    graph: { nodes: [node('w', 'worker', 60, 120), node('t', 'task', 320, 120, { title: 'First attempt' }), node('f', 'condition', 580, 120, { when: 'any_failed', title: 'Did it fail?' }), node('s', 'worker', 580, 300), node('b', 'task', 840, 120, { title: 'Rescue it' }), node('c', 'completion', 1100, 120)], edges: [edge('w', 't'), edge('t', 'f'), edge('f', 'b'), edge('s', 'b'), edge('b', 'c')] },
    policy: { requireReview: false, approvals: false },
  },
];

function createPlaybooks(crew) {
  const { db } = crew;
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_by TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      graph TEXT NOT NULL, policy TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS playbook_runs (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, playbook_id TEXT NOT NULL, project_id TEXT NOT NULL, created_by TEXT NOT NULL,
      graph TEXT NOT NULL, policy TEXT NOT NULL, node_tasks TEXT NOT NULL, wanted TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);

  const shape = (p) => ({ id: p.id, roomId: p.room_id, createdBy: p.created_by, name: p.name, description: p.description, graph: parse(p.graph, { nodes: [], edges: [] }), policy: { ...DEFAULT_POLICY, ...parse(p.policy, {}) }, createdAt: p.created_at, updatedAt: p.updated_at });
  const getRow = (roomId, id) => {
    const p = db.get('SELECT * FROM playbooks WHERE id = ? AND room_id = ?', id, roomId);
    if (!p) throw httpError(404, 'No such playbook.');
    return p;
  };

  /** Throws on anything that could not run. Unassigned agents are only checked when a run starts. */
  function validateGraph(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (nodes.length > MAX_NODES) throw httpError(400, `A playbook can have at most ${MAX_NODES} nodes.`);
    const ids = new Set();
    const clean = nodes.map((n) => {
      if (!NODE_TYPES.includes(n.type)) throw httpError(400, `Unknown node type ${n.type}.`);
      const id = String(n.id ?? '').slice(0, 40);
      if (!id || ids.has(id)) throw httpError(400, 'Every node needs its own id.');
      ids.add(id);
      const c = n.config ?? {};
      const when = c.when === 'any_failed' ? 'any_failed' : 'all_succeeded';
      return { id, type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, config: { title: cleanName(c.title, 120) || undefined, description: String(c.description ?? '').slice(0, 4000) || undefined, agentId: c.agentId ? String(c.agentId) : undefined, roleHint: cleanName(c.roleHint, 80) || undefined, when: n.type === 'condition' ? when : undefined } };
    });
    const seen = new Set();
    const cleanEdges = edges.map((e) => ({ from: String(e.from), to: String(e.to) })).filter((e) => {
      const key = `${e.from}>${e.to}`;
      if (seen.has(key) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
      seen.add(key);
      return true;
    });
    if (order(clean, cleanEdges).length !== clean.length) throw httpError(400, 'These connections form a loop, so nothing could ever start. Remove one.');
    return { nodes: clean, edges: cleanEdges };
  }

  /** Dependency order. Shorter than the node list when there is a loop. */
  function order(nodes, edges) {
    const incoming = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) incoming.set(e.to, incoming.get(e.to) + 1);
    const ready = nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
    const out = [];
    while (ready.length) {
      const id = ready.shift();
      out.push(id);
      for (const e of edges) if (e.from === id) { incoming.set(e.to, incoming.get(e.to) - 1); if (incoming.get(e.to) === 0) ready.push(e.to); }
    }
    return out;
  }

  function cleanPolicy(policy = {}) {
    const out = { ...DEFAULT_POLICY };
    for (const k of ['approvals', 'requireReview', 'testsBeforeDone', 'updateReadme', 'progressReports', 'handoffNotes', 'createRepo']) if (policy[k] !== undefined) out[k] = Boolean(policy[k]);
    const pct = policy.taskBudgetPct;
    out.taskBudgetPct = pct === null || pct === undefined || pct === '' ? null : Math.min(100, Math.max(1, Number(pct)));
    return out;
  }

  function create(roomId, userId, { name, description = '', graph, policy, templateId }) {
    crew.rooms.require(roomId, userId, 'projects.create');
    const template = templateId ? TEMPLATES.find((t) => t.id === templateId) : null;
    if (templateId && !template) throw httpError(404, 'No such template.');
    const n = cleanName(name) || template?.name;
    if (!n) throw httpError(400, 'Give the playbook a name.');
    const id = newId('pbk');
    db.run('INSERT INTO playbooks (id, room_id, created_by, name, description, graph, policy, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, roomId, userId, n, String(description || template?.description || '').slice(0, 500), json(validateGraph(graph ?? template?.graph ?? { nodes: [], edges: [] })), json(cleanPolicy(policy ?? template?.policy)), now(), now());
    crew.audit(roomId, userId, 'playbook.create', { id, name: n });
    crew.hub.broadcast(roomId, 'playbooks', {});
    return shape(getRow(roomId, id));
  }

  function mayEdit(p, userId) {
    if (p.created_by !== userId && !crew.rooms.can(p.room_id, userId, 'room.settings')) throw httpError(403, 'Only whoever made this playbook, or an admin, can change it.');
  }

  function update(roomId, userId, id, { name, description, graph, policy }) {
    const p = getRow(roomId, id);
    mayEdit(p, userId);
    db.run('UPDATE playbooks SET name = ?, description = ?, graph = ?, policy = ?, updated_at = ? WHERE id = ?',
      cleanName(name) || p.name, description !== undefined ? String(description).slice(0, 500) : p.description,
      graph ? json(validateGraph(graph)) : p.graph, policy ? json(cleanPolicy(policy)) : p.policy, now(), id);
    crew.hub.broadcast(roomId, 'playbooks', {});
    return shape(getRow(roomId, id));
  }

  function remove(roomId, userId, id) {
    const p = getRow(roomId, id);
    mayEdit(p, userId);
    db.run('DELETE FROM playbooks WHERE id = ?', id);
    crew.hub.broadcast(roomId, 'playbooks', {});
  }

  // --- a run -------------------------------------------------------------------------------

  /** The agent a node names, or the one connected into it. */
  function agentFor(graph, n) {
    if (n.config.agentId) return n.config.agentId;
    const sources = graph.edges.filter((e) => e.to === n.id).map((e) => graph.nodes.find((x) => x.id === e.from)).filter((x) => x && AGENT_NODES.has(x.type));
    return sources.map((x) => x.config.agentId).find(Boolean) ?? null;
  }

  /** The steps a node waits for, seeing through dependency nodes and past agent nodes. */
  function upstream(graph, id, seen = new Set()) {
    const out = [];
    for (const e of graph.edges.filter((x) => x.to === id)) {
      const from = graph.nodes.find((x) => x.id === e.from);
      if (!from || seen.has(from.id) || AGENT_NODES.has(from.type)) continue;
      seen.add(from.id);
      if (from.type === 'dependency') out.push(...upstream(graph, from.id, seen));
      else out.push(from.id);
    }
    return out;
  }

  /** Everything wrong with starting this, in words the editor can show. */
  function problems(roomId, graph) {
    const out = [];
    const steps = graph.nodes.filter((n) => WORK_NODES.has(n.type));
    if (!steps.length) out.push('Add at least one Task, Code Review or Test.');
    if (graph.nodes.filter((n) => n.type === 'lead').length > 1) out.push('A playbook can only have one Lead Agent.');
    for (const n of graph.nodes.filter((x) => AGENT_NODES.has(x.type))) {
      if (!n.config.agentId) out.push(`Choose an agent for the ${n.type === 'lead' ? 'Lead Agent' : 'Worker Agent'} node.`);
      else if (crew.agents.get(n.config.agentId)?.room_id !== roomId) out.push('A node names an agent that is no longer in this office.');
    }
    for (const n of steps) if (!agentFor(graph, n) && !n.config.roleHint) out.push(`“${n.config.title ?? n.type}” has no agent. Connect a Worker Agent to it.`);
    return [...new Set(out)];
  }

  function start(roomId, userId, id, { goal, name }) {
    crew.safety.refuseIfStopped(roomId);
    const pb = getRow(roomId, id);
    crew.rooms.require(roomId, userId, 'projects.create');
    const graph = parse(pb.graph, { nodes: [], edges: [] });
    const policy = { ...DEFAULT_POLICY, ...parse(pb.policy, {}) };
    const wrong = problems(roomId, graph);
    if (wrong.length) throw httpError(400, wrong.join(' '));
    const text = String(goal ?? '').trim();
    if (!text) throw httpError(400, 'Describe what this run should achieve.');

    const named = graph.nodes.map((n) => n.config.agentId).filter(Boolean);
    const leadNode = graph.nodes.find((n) => n.type === 'lead');
    const leadId = leadNode?.config.agentId ?? named.find((a) => crew.agents.get(a)?.owner_id === userId);
    if (!leadId || crew.agents.get(leadId)?.owner_id !== userId) throw httpError(400, 'The lead has to be one of your own agents: it writes the final summary, on your plan.');

    const project = crew.work.createProject(roomId, userId, { name: cleanName(name) || `${pb.name}: ${text.slice(0, 40)}`, goal: text, managerAgentId: leadId });
    crew.policies.set(roomId, userId, 'project', project.id, {
      approvalMode: policy.approvals ? 'balanced' : 'autonomous', requireReview: policy.requireReview, testsBeforeDone: policy.testsBeforeDone,
      updateReadme: policy.updateReadme, progressReports: policy.progressReports, handoffNotes: policy.handoffNotes,
    });
    if (policy.createRepo && crew.git.hasGit()) crew.git.create(roomId, userId, project.id, { name: 'main' });

    // Your own agents join at once. Another player's agent is theirs to lend: they are asked, and
    // the work waits for their answer. Their credentials and plan never leave their computer.
    const asked = new Set();
    for (const agentId of new Set(named)) {
      const a = crew.agents.get(agentId);
      if (a.owner_id === userId) { if (agentId !== leadId) crew.work.grant(roomId, userId, project.id, agentId, { tools: parse(a.tools, []), budgetUsd: Math.min(a.budget_usd, 5), requiresApproval: false }); } else if (!asked.has(a.owner_id)) {
        asked.add(a.owner_id);
        crew.work.joinProject(roomId, a.owner_id, project.id);
        crew.work.notify(roomId, a.owner_id, `${crew.auth.getUser(userId)?.displayName} wants ${a.name} on “${project.name}”. Open the project and lend your agent to let the work start.`, 'warn', `project:${project.id}`);
      }
    }

    const nodeTasks = {};
    const wanted = {};
    const by = { type: 'human', id: userId };
    for (const nodeId of order(graph.nodes, graph.edges)) {
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (!WORK_NODES.has(n.type) && !GATE_NODES.has(n.type)) continue;
      const deps = upstream(graph, n.id).map((d) => nodeTasks[d]).filter(Boolean);
      const title = n.config.title ?? { task: 'Task', review: 'Code review', test: 'Run the tests', condition: 'Condition', approval: 'Approval', merge: 'Merge', completion: 'Done' }[n.type];
      const test = n.type === 'test' ? 'Run the project’s tests with your tools, and finish with complete_task including the real command, exit code and output. Do not report a result you did not observe.\n\n' : '';
      const review = n.type === 'review' ? 'Review the results and files of the steps before this one against the goal. Say plainly what is wrong and what is good.\n\n' : '';
      const t = crew.work.createTask(crew.work.getProject(project.id), {
        kind: n.type === 'review' ? 'review' : WORK_NODES.has(n.type) ? 'work' : 'gate', title, description: `${test}${review}${n.config.description ?? `Part of the goal: ${text}`}`,
        roleHint: n.config.roleHint ?? null, deps, by,
      });
      nodeTasks[n.id] = t.id;
      if (policy.taskBudgetPct && WORK_NODES.has(n.type)) crew.work.setTask(t.id, { budget_pct: policy.taskBudgetPct });
      if (WORK_NODES.has(n.type)) wanted[t.id] = agentFor(graph, n);
    }

    const runId = newId('run');
    db.run('INSERT INTO playbook_runs (id, room_id, playbook_id, project_id, created_by, graph, policy, node_tasks, wanted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      runId, roomId, id, project.id, userId, json(graph), json(policy), json(nodeTasks), json(wanted), now());
    db.run("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?", now(), project.id);
    crew.bus.post({ roomId, channelId: project.channelId, senderType: 'human', senderId: userId, kind: 'chat', body: `Started from the playbook “${pb.name}”. Goal: ${text}` });
    crew.audit(roomId, userId, 'playbook.run', { runId, playbookId: id, projectId: project.id });
    crew.work.publishProject(project.id);
    crew.work.kick();
    crew.hub.broadcast(roomId, 'playbooks', {});
    return getRun(roomId, runId, userId);
  }

  /** Called with every scheduling pass: hand out what can start, and settle the agentless steps. */
  function tick() {
    for (const run of db.all("SELECT r.* FROM playbook_runs r JOIN projects p ON p.id = r.project_id WHERE p.status = 'active'")) {
      if (crew.safety.isStopped(run.room_id)) continue;
      const wanted = parse(run.wanted, {});
      const policy = { ...DEFAULT_POLICY, ...parse(run.policy, {}) };
      for (const [taskId, agentId] of Object.entries(wanted)) {
        const t = crew.work.getTask(taskId);
        if (!t || t.status !== 'pending' || t.assigned_agent_id) continue;
        const target = agentId ?? crew.work.pickAgent(crew.work.getProject(run.project_id), t.role_hint);
        if (target && crew.work.grantOf(run.project_id, target)) crew.work.assign(taskId, target, { by: { type: 'human', id: run.created_by } });
      }
      for (const t of db.all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'gate' AND status = 'pending'", run.project_id)) settleGate(run, t, policy);
    }
  }

  function settleGate(run, t, policy) {
    const nodeTasks = parse(run.node_tasks, {});
    const graph = parse(run.graph, { nodes: [] });
    const n = graph.nodes.find((x) => nodeTasks[x.id] === t.id);
    const deps = parse(t.deps, []).map(crew.work.getTask).filter(Boolean);
    if (!deps.every((d) => ['completed', 'failed', 'cancelled', 'blocked'].includes(d.status))) return;
    const failed = deps.filter((d) => d.status !== 'completed');
    const finish = (status, summary) => { crew.work.setTask(t.id, { status, result_summary: summary }); crew.work.settle(t.project_id); };

    if (n?.type === 'condition') {
      const met = n.config.when === 'any_failed' ? failed.length > 0 : failed.length === 0;
      return met ? finish('completed', 'Condition met.') : finish('cancelled', 'Condition not met, so this branch was skipped.');
    }
    if (failed.length) return finish('blocked', 'A step before this did not complete.');
    if (n?.type === 'approval') {
      if (!policy.approvals) return finish('completed', 'Approvals are off in this playbook, so this passed without asking.');
      crew.work.setTask(t.id, { status: 'awaiting_approval' });
      crew.work.requestApproval({ roomId: run.room_id, kind: 'gate', taskId: t.id, approverId: run.created_by, detail: { title: t.title, reason: `“${t.title}” is waiting for you to continue the run.`, results: deps.map((d) => ({ title: d.title, result: d.result_summary })) } });
      return undefined;
    }
    if (n?.type === 'merge') {
      if (!crew.git.forProject(t.project_id).length) return finish('completed', 'This run has no Git repository, so there was nothing to merge.');
      const merges = deps.flatMap((d) => db.all('SELECT status, merge_commit, branch FROM merge_requests WHERE task_id = ?', d.id));
      if (!merges.length) return finish('completed', 'No merge requests came from the steps before this.');
      if (merges.some((m) => m.status === 'conflict')) return finish('blocked', 'A merge request has a conflict.');
      if (merges.every((m) => m.status === 'merged')) return finish('completed', `Merged: ${merges.map((m) => `${m.branch} (${String(m.merge_commit).slice(0, 8)})`).join(', ')}`);
      return undefined; // still under review
    }
    return finish('completed', 'Reached the end of this path.');
  }

  function shapeRun(run) {
    const nodeTasks = parse(run.node_tasks, {});
    const graph = parse(run.graph, { nodes: [], edges: [] });
    const project = crew.work.getProject(run.project_id);
    const tasks = Object.fromEntries(Object.entries(nodeTasks).map(([nodeId, id]) => [nodeId, crew.work.shapeTask(crew.work.getTask(id))]));
    const agents = Object.fromEntries(graph.nodes.filter((n) => n.config.agentId).map((n) => {
      const a = crew.agents.get(n.config.agentId);
      return [n.id, a ? { id: a.id, name: a.name, color: a.color, status: a.status, ownerName: crew.auth.getUser(a.owner_id)?.displayName, granted: Boolean(crew.work.grantOf(run.project_id, a.id)), tokens: a.tokens_in + a.tokens_out } : null];
    }));
    return {
      id: run.id, playbookId: run.playbook_id, projectId: run.project_id, name: project?.name, goal: project?.goal, status: project?.status ?? 'deleted', summary: project?.summary ?? null,
      leadAgentId: project?.manager_agent_id, createdBy: run.created_by, createdAt: run.created_at, graph, tasks, agents,
    };
  }

  function getRun(roomId, runId, viewerId = null) {
    const run = db.get('SELECT * FROM playbook_runs WHERE id = ? AND room_id = ?', runId, roomId);
    if (!run) throw httpError(404, 'No such run.');
    const shaped = shapeRun(run);
    const all = crew.work.listTasks(run.project_id);
    const taskIds = new Set(all.map((t) => t.id));
    const channel = crew.work.getProject(run.project_id)?.channel_id;
    let messages = [];
    try { messages = viewerId && channel ? crew.bus.history(roomId, viewerId, channel, { limit: 40 }) : []; } catch { /* not theirs to read */ }
    return {
      ...shaped,
      synthesis: all.filter((t) => t.kind === 'synthesis').at(-1) ?? null,
      messages,
      git: crew.git.forProject(run.project_id).flatMap((r) => db.all('SELECT kind, ref, new, created_at, tests FROM git_events WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20', r.id)),
      deliverables: db.all('SELECT path, kind, task_id, size FROM artifacts WHERE project_id = ?', run.project_id).map((a) => ({ path: a.path, kind: a.kind, taskId: a.task_id, size: a.size })),
      tokens: all.filter((t) => taskIds.has(t.id)).reduce((s, t) => s + (t.tokens ?? 0), 0),
    };
  }

  const list = (roomId) => db.all('SELECT * FROM playbooks WHERE room_id = ? ORDER BY updated_at DESC', roomId).map(shape);
  const listRuns = (roomId) => db.all('SELECT * FROM playbook_runs WHERE room_id = ? ORDER BY created_at DESC LIMIT 30', roomId).map(shapeRun);

  return { create, update, remove, list, listRuns, start, tick, getRun, problems, templates: () => TEMPLATES, NODE_TYPES };
}

module.exports = { createPlaybooks, TEMPLATES, NODE_TYPES };
