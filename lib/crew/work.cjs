// Shared projects and the work in them: grants, tasks, files, notes, approvals — and the
// orchestrator that moves tasks through their lifecycle.
//
//   Project → Milestones → Tasks → Subtasks → Jobs (agent executions)
//
// A project starts with a planning task for its manager agent. The manager's plan (a real
// model call ending in `submit_plan`) becomes tasks; each is matched to an agent the
// agents' owners granted to this project. The project creator approves the plan; each
// owner whose grant asks for it approves work assigned to their agents. Tasks whose
// dependencies are complete are queued as jobs and run in parallel on their owners'
// workers. When everything is settled the manager writes the final summary.
//
// A task is complete only through `complete_task`, which demands evidence: a work task
// must name files it produced in the project, and a review or summary is itself stored as
// a file. There is no other path to `completed`.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newId, now, json, parse } = require('./db.cjs');
const { httpError, cleanName } = require('./auth.cjs');
const { PERMISSIONS } = require('./catalog.cjs');

const MAX_FILE = 256 * 1024;
const MAX_FILES = 400;
const MAX_PLAN_TASKS = 14;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);

function createWork(crew) {
  const { db } = crew;
  let kickTimer = null;

  // --- projects -------------------------------------------------------------

  function shapeProject(p) {
    if (!p) return null;
    const tasks = db.all('SELECT status, kind FROM tasks WHERE project_id = ?', p.id);
    const work = tasks.filter((t) => t.kind !== 'plan');
    return {
      id: p.id, roomId: p.room_id, name: p.name, goal: p.goal, createdBy: p.created_by, managerAgentId: p.manager_agent_id,
      status: p.status, summary: p.summary, channelId: p.channel_id, createdAt: p.created_at, updatedAt: p.updated_at,
      members: db.all('SELECT user_id FROM project_members WHERE project_id = ?', p.id).map((m) => m.user_id),
      grants: db.all('SELECT * FROM project_grants WHERE project_id = ?', p.id).map(shapeGrant),
      progress: { total: work.length, done: work.filter((t) => t.status === 'completed').length },
      cost: db.get('SELECT COALESCE(SUM(actual_cost),0) c, COALESCE(SUM(tokens),0) t FROM tasks WHERE project_id = ?', p.id),
    };
  }

  const shapeGrant = (g) => ({ projectId: g.project_id, agentId: g.agent_id, grantedBy: g.granted_by, tools: parse(g.tools, []), budgetUsd: g.budget_usd, spentUsd: g.spent_usd, requiresApproval: Boolean(g.requires_approval) });

  const getProject = (id) => db.get('SELECT * FROM projects WHERE id = ?', id);

  function projectFor(roomId, projectId) {
    const p = getProject(projectId);
    if (!p || p.room_id !== roomId) throw httpError(404, 'No such project.');
    return p;
  }

  const isMember = (projectId, userId) => Boolean(db.get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId));

  function createProject(roomId, userId, { name, goal, managerAgentId }) {
    crew.rooms.require(roomId, userId, 'projects.create');
    const n = cleanName(name);
    if (!n) throw httpError(400, 'A project needs a name.');
    const g = String(goal ?? '').trim().slice(0, 4000);
    if (!g) throw httpError(400, 'Describe the goal.');
    const manager = crew.agents.get(managerAgentId);
    if (!manager || manager.room_id !== roomId) throw httpError(400, 'Choose a manager agent.');
    if (manager.owner_id !== userId) throw httpError(403, 'The manager must be one of your own agents.');
    const id = newId('prj');
    const ch = crew.bus.ensureChannel(roomId, `project-${n.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${id.slice(-4).toLowerCase()}`, 'project', { projectId: id });
    db.tx(() => {
      db.run('INSERT INTO projects (id, room_id, name, goal, created_by, manager_agent_id, status, channel_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, roomId, n, g, userId, manager.id, 'draft', ch.id, now(), now());
      db.run('INSERT INTO project_members (project_id, user_id) VALUES (?,?)', id, userId);
    });
    grant(roomId, userId, id, manager.id, { tools: parse(manager.tools, []), budgetUsd: Math.min(manager.budget_usd, 5), requiresApproval: false });
    fs.mkdirSync(filesDir(roomId, id), { recursive: true });
    crew.audit(roomId, userId, 'project.create', { projectId: id, name: n });
    publishProject(id);
    return shapeProject(getProject(id));
  }

  function joinProject(roomId, userId, projectId) {
    crew.rooms.require(roomId, userId, 'projects.join');
    projectFor(roomId, projectId);
    db.run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)', projectId, userId);
    publishProject(projectId);
    return shapeProject(getProject(projectId));
  }

  /**
   * An owner lends one of their agents to a project, on their terms: which permission
   * groups it may use here (a subset of what the agent has at all), how much it may spend
   * here, and whether work given to it needs the owner's approval first.
   */
  function grant(roomId, userId, projectId, agentId, { tools, budgetUsd = 2, requiresApproval = true }) {
    projectFor(roomId, projectId);
    if (!isMember(projectId, userId)) throw httpError(403, 'Join the project before lending it agents.');
    const agent = crew.agents.owned(agentId, userId);
    if (agent.room_id !== roomId) throw httpError(400, 'That agent is in another office.');
    const allowed = parse(agent.tools, []);
    const chosen = (tools ?? allowed).filter((t) => PERMISSIONS[t] && allowed.includes(t));
    const budget = Number(budgetUsd);
    if (!(budget >= 0 && budget <= agent.budget_usd)) throw httpError(400, `Project budget must be between 0 and the agent's own budget (${agent.budget_usd}).`);
    db.run(`INSERT INTO project_grants (project_id, agent_id, granted_by, tools, budget_usd, requires_approval, created_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(project_id, agent_id) DO UPDATE SET tools = excluded.tools, budget_usd = excluded.budget_usd, requires_approval = excluded.requires_approval`,
      projectId, agentId, userId, json(chosen), budget, requiresApproval ? 1 : 0, now());
    crew.audit(roomId, userId, 'project.grant', { projectId, agentId, tools: chosen, budget, requiresApproval });
    publishProject(projectId);
    kick();
    return shapeGrant(db.get('SELECT * FROM project_grants WHERE project_id = ? AND agent_id = ?', projectId, agentId));
  }

  function revokeGrant(roomId, userId, projectId, agentId) {
    projectFor(roomId, projectId);
    crew.agents.owned(agentId, userId);
    const p = getProject(projectId);
    if (p.manager_agent_id === agentId) throw httpError(409, 'The manager cannot leave its own project.');
    db.run('DELETE FROM project_grants WHERE project_id = ? AND agent_id = ?', projectId, agentId);
    for (const t of db.all("SELECT id FROM tasks WHERE project_id = ? AND assigned_agent_id = ? AND status NOT IN ('completed','failed','cancelled')", projectId, agentId)) {
      cancelTaskJobs(t.id, 'agent withdrawn from project');
      setTask(t.id, { status: 'pending', assigned_agent_id: null, approval_state: 'none' });
    }
    crew.audit(roomId, userId, 'project.revoke', { projectId, agentId });
    publishProject(projectId);
    kick();
  }

  const grantOf = (projectId, agentId) => db.get('SELECT * FROM project_grants WHERE project_id = ? AND agent_id = ?', projectId, agentId);

  function startProject(roomId, userId, projectId) {
    const p = projectFor(roomId, projectId);
    if (p.created_by !== userId) throw httpError(403, 'Only the project creator can start it.');
    if (p.status !== 'draft') throw httpError(409, 'This project has already started.');
    db.run("UPDATE projects SET status = 'planning', updated_at = ? WHERE id = ?", now(), projectId);
    const planText = 'Break the project goal into concrete tasks for the team, then call submit_plan.';
    createTask(p, { kind: 'plan', title: `Plan: ${p.name}`, description: planText, assignedAgentId: p.manager_agent_id, by: { type: 'human', id: userId }, skipApproval: true });
    crew.bus.post({ roomId, channelId: p.channel_id, senderType: 'human', senderId: userId, kind: 'chat', body: `Project started. Goal: ${p.goal}` });
    publishProject(projectId);
    kick();
    return shapeProject(getProject(projectId));
  }

  function publishProject(projectId) {
    const p = getProject(projectId);
    if (p) crew.hub.broadcast(p.room_id, 'project', shapeProject(p));
  }

  // --- tasks ----------------------------------------------------------------

  function shapeTask(t) {
    if (!t) return null;
    const a = t.assigned_agent_id ? db.get('SELECT name, owner_id, color FROM agents WHERE id = ?', t.assigned_agent_id) : null;
    return {
      id: t.id, projectId: t.project_id, parentId: t.parent_id, milestone: t.milestone, kind: t.kind, title: t.title, description: t.description,
      roleHint: t.role_hint, assignedAgentId: t.assigned_agent_id, assignedAgentName: a?.name ?? null, ownerId: a?.owner_id ?? null, agentColor: a?.color,
      status: t.status, priority: t.priority, deps: parse(t.deps, []), deliverables: parse(t.deliverables, []), approvalState: t.approval_state,
      approvedBy: t.approved_by, resultSummary: t.result_summary, attempts: t.attempts, maxAttempts: t.max_attempts, timeoutS: t.timeout_s,
      mrId: t.mr_id ?? null, budgetPct: t.budget_pct ?? null, pausedReason: t.paused_reason ?? null,
      estCost: t.est_cost, actualCost: t.actual_cost, tokens: t.tokens, createdBy: { type: t.created_by_type, id: t.created_by_id },
      artifacts: db.all('SELECT path, kind FROM artifacts WHERE task_id = ?', t.id), createdAt: t.created_at, updatedAt: t.updated_at,
    };
  }

  const getTask = (id) => db.get('SELECT * FROM tasks WHERE id = ?', id);

  function setTask(taskId, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    db.run(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => patch[c]), now(), taskId);
    const t = getTask(taskId);
    const p = getProject(t.project_id);
    // New or reopened work wakes a finished project: a contract update or a declined merge can
    // arrive after the summary was written, and a completed project is not scheduled.
    if (p.status === 'completed' && !TERMINAL.has(t.status)) db.run("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?", now(), p.id);
    crew.hub.broadcast(p.room_id, 'task', shapeTask(t));
    publishProject(p.id);
  }

  function createTask(project, { kind = 'work', title, description = '', roleHint = null, assignedAgentId = null, deps = [], deliverables = [], milestone = null, parentId = null, priority = 2, by, skipApproval = false }) {
    const id = newId('tsk');
    db.run(`INSERT INTO tasks (id, project_id, parent_id, milestone, kind, title, description, role_hint, assigned_agent_id, status, priority, deps, deliverables, created_by_type, created_by_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, project.id, parentId, milestone, kind, cleanName(title, 120) || 'Task', String(description).slice(0, 4000), roleHint, null, 'pending', priority,
      json(deps), json(deliverables), by.type, by.id, now(), now());
    if (assignedAgentId) assign(id, assignedAgentId, { by, skipApproval });
    else setTask(id, { status: 'pending' });
    return getTask(id);
  }

  /**
   * Give a task to an agent. Work for an agent whose owner is not the person (or whose
   * manager agent is not owned by the person) asking needs the owner's approval when their
   * grant says so; that is the one rule that stops a manager — or a room owner — from
   * spending someone else's agent.
   */
  function assign(taskId, agentId, { by, skipApproval = false }) {
    const t = getTask(taskId);
    const p = getProject(t.project_id);
    const g = grantOf(p.id, agentId);
    if (!g) throw httpError(403, 'That agent has not been granted to this project by its owner.');
    const agent = crew.agents.get(agentId);
    const requester = by.type === 'human' ? by.id : crew.agents.get(by.id)?.owner_id;
    const crossTeam = requester !== agent.owner_id;
    const needs = !skipApproval && crossTeam && g.requires_approval;
    setTask(taskId, { assigned_agent_id: agentId, approval_state: needs ? 'pending' : 'none', status: needs ? 'awaiting_approval' : 'pending' });
    if (needs) {
      requestApproval({ roomId: p.room_id, kind: 'assignment', taskId, agentId, approverId: agent.owner_id,
        detail: { title: t.title, project: p.name, requestedBy: by, agentName: agent.name } });
    }
    kick();
  }

  function pickAgent(project, roleHint, { exclude = [], allow = () => true } = {}) {
    const grants = db.all('SELECT agent_id FROM project_grants WHERE project_id = ?', project.id).map((g) => g.agent_id).filter((id) => !exclude.includes(id) && allow(id));
    const words = String(roleHint ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    let best = null;
    for (const id of grants) {
      const a = crew.agents.get(id);
      if (!a) continue;
      const hay = `${a.role} ${parse(a.skills, []).join(' ')} ${a.name}`.toLowerCase();
      let score = words.reduce((s, w) => s + (hay.includes(w) ? 3 : 0), 0);
      if (a.is_manager || id === project.manager_agent_id) score -= 2;
      const load = db.get("SELECT COUNT(*) n FROM tasks WHERE assigned_agent_id = ? AND status NOT IN ('completed','failed','cancelled')", id).n;
      score -= load * 0.5;
      if (!crew.agents.available(a)) score -= 1;
      if (!best || score > best.score) best = { id, score };
    }
    return best?.id ?? null;
  }

  /** The manager's plan, validated, becomes tasks. Called by the submit_plan tool. */
  function acceptPlan(planTask, agent, plan) {
    const p = getProject(planTask.project_id);
    if (planTask.kind !== 'plan') throw httpError(400, 'submit_plan is only for planning tasks.');
    if (db.get("SELECT 1 FROM tasks WHERE project_id = ? AND kind != 'plan'", p.id)) throw httpError(409, 'A plan was already submitted for this project.');
    const items = Array.isArray(plan?.tasks) ? plan.tasks : [];
    if (!items.length) throw httpError(400, 'The plan has no tasks.');
    if (items.length > MAX_PLAN_TASKS) throw httpError(400, `At most ${MAX_PLAN_TASKS} tasks in a plan.`);
    const keys = new Set();
    for (const [i, it] of items.entries()) {
      it.key = String(it.key ?? `t${i + 1}`);
      if (keys.has(it.key)) throw httpError(400, `Duplicate task key ${it.key}.`);
      keys.add(it.key);
      if (!String(it.title ?? '').trim()) throw httpError(400, `Task ${it.key} has no title.`);
    }
    for (const it of items) for (const d of it.depends_on ?? []) if (!keys.has(String(d))) throw httpError(400, `Task ${it.key} depends on unknown key ${d}.`);
    // Cycle check: repeatedly remove tasks whose dependencies are all removed.
    const left = new Map(items.map((it) => [it.key, new Set((it.depends_on ?? []).map(String))]));
    let progressed = true;
    while (left.size && progressed) {
      progressed = false;
      for (const [k, deps] of left) if ([...deps].every((d) => !left.has(d))) { left.delete(k); progressed = true; }
    }
    if (left.size) throw httpError(400, `The plan has a dependency cycle among: ${[...left.keys()].join(', ')}.`);

    const idByKey = new Map();
    const by = { type: 'agent', id: agent.id };
    const unassigned = [];
    for (const it of items) {
      const named = it.assignee ? crew.agents.resolve(p.room_id, it.assignee) : null;
      const agentId = named && grantOf(p.id, named.id) ? named.id : pickAgent(p, `${it.role ?? ''} ${it.title}`);
      const t = createTask(p, {
        kind: it.kind === 'review' ? 'review' : 'work', title: it.title, description: it.description ?? '', roleHint: it.role ?? null,
        deps: (it.depends_on ?? []).map((d) => idByKey.get(String(d))).filter(Boolean),
        deliverables: (it.deliverables ?? []).map(String).slice(0, 10), milestone: it.milestone ?? null, by,
      });
      idByKey.set(it.key, t.id);
      if (agentId) db.run('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?', agentId, t.id);
      else unassigned.push(it.title);
    }
    // Dependencies may name keys declared later; resolve them now that every id exists.
    for (const it of items) {
      const deps = (it.depends_on ?? []).map((d) => idByKey.get(String(d))).filter(Boolean);
      db.run('UPDATE tasks SET deps = ? WHERE id = ?', json(deps), idByKey.get(it.key));
    }
    db.run("UPDATE projects SET status = 'awaiting_plan_approval', updated_at = ? WHERE id = ?", now(), p.id);
    requestApproval({ roomId: p.room_id, kind: 'plan', taskId: planTask.id, agentId: agent.id, approverId: p.created_by,
      detail: { project: p.name, tasks: items.map((it) => ({ title: it.title, assignee: crew.agents.get(db.get('SELECT assigned_agent_id a FROM tasks WHERE id = ?', idByKey.get(it.key)).a)?.name ?? null })) } });
    for (const id of idByKey.values()) setTask(id, {});
    publishProject(p.id);
    return { created: items.length, unassigned };
  }

  /** The plan was approved: route each task's assignment through the owners' approvals. */
  function releasePlan(projectId, approverId) {
    const p = getProject(projectId);
    db.run("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?", now(), projectId);
    for (const t of db.all("SELECT * FROM tasks WHERE project_id = ? AND kind != 'plan' AND status = 'pending'", projectId)) {
      if (t.assigned_agent_id) assign(t.id, t.assigned_agent_id, { by: { type: 'human', id: approverId } });
    }
    crew.bus.post({ roomId: p.room_id, channelId: p.channel_id, senderType: 'human', senderId: approverId, kind: 'approval', body: 'Plan approved. Assignments are going out to the team.' });
    publishProject(projectId);
    kick();
  }

  function addTask(roomId, userId, projectId, input) {
    const p = projectFor(roomId, projectId);
    if (!isMember(projectId, userId)) throw httpError(403, 'Join the project to add tasks.');
    const t = createTask(p, { kind: input.kind === 'review' ? 'review' : 'work', title: input.title, description: input.description, roleHint: input.roleHint,
      deps: (input.deps ?? []).filter((d) => getTask(d)?.project_id === projectId), deliverables: input.deliverables ?? [], priority: input.priority ?? 2, by: { type: 'human', id: userId } });
    const agentId = input.agentId ?? pickAgent(p, `${input.roleHint ?? ''} ${input.title}`);
    if (agentId) assign(t.id, agentId, { by: { type: 'human', id: userId } });
    if (p.status === 'draft') db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
    publishProject(p.id);
    return shapeTask(getTask(t.id));
  }

  function cancelTask(roomId, userId, taskId) {
    const t = getTask(taskId);
    if (!t) throw httpError(404, 'No such task.');
    const p = projectFor(roomId, t.project_id);
    const agentOwner = t.assigned_agent_id ? crew.agents.get(t.assigned_agent_id)?.owner_id : null;
    if (p.created_by !== userId && agentOwner !== userId) throw httpError(403, 'Only the project creator or the assigned agent’s owner can cancel this task.');
    cancelTaskJobs(taskId, 'cancelled by a human');
    setTask(taskId, { status: 'cancelled' });
    settleDependents(p.id);
    kick();
  }

  /** An estimated share of the owner's allowance this task may use; enforced on the owner's worker. */
  function setTaskBudget(roomId, userId, taskId, pct) {
    const t = getTask(taskId);
    if (!t) throw httpError(404, 'No such task.');
    const p = projectFor(roomId, t.project_id);
    const owner = t.assigned_agent_id ? crew.agents.get(t.assigned_agent_id)?.owner_id : null;
    if (p.created_by !== userId && owner !== userId) throw httpError(403, 'Only the project creator or the agent’s owner can set this.');
    const v = pct === null || pct === undefined || pct === '' ? null : Number(pct);
    if (v !== null && !(v > 0 && v <= 100)) throw httpError(400, 'A task budget is between 1 and 100 percent.');
    setTask(taskId, { budget_pct: v });
    crew.audit(roomId, userId, 'task.budget', { taskId, pct: v });
    // A task paused at its old estimate carries on from its checkpoint.
    for (const j of db.all("SELECT * FROM jobs WHERE type = 'task' AND ref_id = ? AND status = 'waiting'", taskId)) {
      if (parse(j.result, null)?.pause?.kind === 'budget') {
        crew.jobs.requeue(j.id, { resume: { kind: 'pause', reason: 'budget raised' } });
        setTask(taskId, { status: 'queued', paused_reason: null });
      }
    }
    return shapeTask(getTask(taskId));
  }

  function retryTask(roomId, userId, taskId) {
    const t = getTask(taskId);
    if (!t) throw httpError(404, 'No such task.');
    const p = projectFor(roomId, t.project_id);
    if (!isMember(p.id, userId)) throw httpError(403, 'Join the project first.');
    if (!['failed', 'blocked', 'cancelled'].includes(t.status)) throw httpError(409, 'Only failed, blocked or cancelled tasks can be retried.');
    setTask(taskId, { status: 'pending', attempts: 0 });
    if (p.status === 'completed') db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
    for (const d of db.all("SELECT id, deps FROM tasks WHERE project_id = ? AND status = 'blocked'", p.id)) if (parse(d.deps, []).includes(taskId)) setTask(d.id, { status: 'pending' });
    kick();
  }

  function cancelTaskJobs(taskId, reason) {
    for (const j of db.all("SELECT id FROM jobs WHERE type = 'task' AND ref_id = ? AND status IN ('queued','leased','waiting')", taskId)) crew.jobs.cancel(j.id, reason);
  }

  function unassignAgent(agentId) {
    for (const t of db.all("SELECT id FROM tasks WHERE assigned_agent_id = ? AND status NOT IN ('completed','failed','cancelled')", agentId)) {
      setTask(t.id, { status: 'pending', assigned_agent_id: null, approval_state: 'none' });
    }
  }

  // --- scheduling -----------------------------------------------------------

  /** Coalesced: many state changes in one tick schedule once. */
  function kick() {
    if (kickTimer) return;
    kickTimer = setImmediate(() => { kickTimer = null; try { schedule(); } catch (err) { crew.crash.record('schedule', err); } });
  }

  function schedule() {
    for (const t of db.all("SELECT * FROM tasks WHERE status = 'pending' AND assigned_agent_id IS NOT NULL")) {
      const p = getProject(t.project_id);
      if (!p || !['planning', 'active'].includes(p.status)) continue;
      if (t.kind !== 'plan' && p.status !== 'active') continue;
      if (t.approval_state === 'pending' || t.approval_state === 'rejected') continue;
      const deps = parse(t.deps, []).map(getTask).filter(Boolean);
      if (deps.some((d) => ['failed', 'cancelled', 'blocked'].includes(d.status))) { setTask(t.id, { status: 'blocked', result_summary: 'A task this depends on did not complete.' }); continue; }
      if (!deps.every((d) => d.status === 'completed')) continue;
      const agent = crew.agents.get(t.assigned_agent_id);
      if (!agent) continue;
      const g = grantOf(p.id, agent.id);
      if (!g) continue;
      if (g.spent_usd >= g.budget_usd && g.budget_usd > 0) { setTask(t.id, { status: 'blocked', result_summary: 'Project budget for this agent is used up. Its owner can raise it.' }); notifyBudget(agent, p); continue; }
      setTask(t.id, { status: 'queued', attempts: t.attempts + 1 });
      // One attempt per job: retries are the task's business (retryOrFail), so a failure is
      // counted once, and the next attempt is told what went wrong with the last.
      crew.jobs.enqueue({ roomId: p.room_id, agentId: agent.id, type: 'task', refId: t.id, maxAttempts: 1, idemKey: `task:${t.id}:run${db.get("SELECT COUNT(*) n FROM jobs WHERE type = 'task' AND ref_id = ?", t.id).n + 1}` });
      crew.agents.setStatus(agent.id, 'ASSIGNED', { taskId: t.id });
      crew.office.jobQueued(p.room_id, t, agent);
    }
    crew.playbooks.tick();
    for (const p of db.all("SELECT * FROM projects WHERE status = 'active'")) maybeSynthesize(p);
  }

  function settleDependents(projectId) {
    for (const t of db.all("SELECT * FROM tasks WHERE project_id = ? AND status = 'pending' AND kind != 'gate'", projectId)) {
      const deps = parse(t.deps, []).map(getTask).filter(Boolean);
      if (deps.some((d) => ['failed', 'cancelled', 'blocked'].includes(d.status))) setTask(t.id, { status: 'blocked', result_summary: 'A task this depends on did not complete.' });
    }
  }

  function maybeSynthesize(p) {
    const tasks = db.all("SELECT * FROM tasks WHERE project_id = ? AND kind != 'plan'", p.id);
    const work = tasks.filter((t) => t.kind !== 'synthesis');
    if (!work.length || !work.every((t) => TERMINAL.has(t.status))) return;
    const summaries = tasks.filter((t) => t.kind === 'synthesis');
    if (summaries.some((t) => !TERMINAL.has(t.status))) return;
    // Work that settled after the last summary gets a new summary; otherwise there is nothing to add.
    const lastSummary = Math.max(0, ...summaries.map((t) => t.updated_at));
    if (summaries.length && !work.some((t) => t.updated_at > lastSummary)) {
      db.run("UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?", now(), p.id);
      publishProject(p.id);
      return;
    }
    createTask(p, { kind: 'synthesis', title: `Final summary: ${p.name}`, assignedAgentId: p.manager_agent_id, by: { type: 'agent', id: p.manager_agent_id }, skipApproval: true,
      description: 'Every task is settled. Read the results and files, check them against the goal, and call complete_task with the final project summary: what was built, where it is, what was tested, what failed or is missing, and any decisions the humans need to make.' });
  }

  function notifyBudget(agent, p) {
    const key = `budget:${agent.id}:${p.id}`;
    if (db.get('SELECT 1 FROM notifications WHERE user_id = ? AND link = ? AND read = 0', agent.owner_id, key)) return;
    notify(p.room_id, agent.owner_id, `${agent.name} has used its budget on “${p.name}”. Raise the project budget to let it continue.`, 'warn', key);
  }

  // --- job lifecycle hooks (called by jobs.cjs) -----------------------------

  function onJobStarted(job) {
    const agent = crew.agents.get(job.agent_id);
    if (job.type === 'task') {
      const t = getTask(job.ref_id);
      if (t) setTask(t.id, { status: 'in_progress' });
      const state = t?.kind === 'plan' ? 'PLANNING' : t?.kind === 'review' ? 'REVIEW' : 'WORKING';
      crew.agents.setStatus(job.agent_id, state, { taskId: t?.id ?? null });
      crew.office.jobStarted(agent, t?.title ?? 'Task', job);
    } else {
      if (!agent.current_task_id) crew.agents.setStatus(job.agent_id, 'WORKING');
      crew.office.jobStarted(agent, job.type === 'reply' ? 'Answering a colleague' : 'Chatting', job);
    }
  }

  function onJobInterrupted(job, reason) {
    crew.jobs.log(job, 'warn', `Interrupted: ${reason}. Back in the queue.`);
    if (job.type === 'task') { const t = getTask(job.ref_id); if (t && t.status === 'in_progress') setTask(t.id, { status: 'queued' }); }
    crew.agents.setStatus(job.agent_id, 'ASSIGNED');
    crew.office.jobEnded(crew.agents.get(job.agent_id), job, 'cancelled', reason);
  }

  function onJobFinished(job, { status, result, error }) {
    const agent = crew.agents.get(job.agent_id);
    const payload = parse(job.payload, {});
    if (job.type === 'reply') {
      if (status === 'done') {
        const text = String(result?.text ?? '').trim() || '(no answer)';
        const q = db.get("SELECT * FROM messages WHERE correlation_id = ? AND kind = 'question'", payload.correlationId);
        if (q) {
          const msg = crew.bus.post({ roomId: job.room_id, channelId: q.channel_id, senderType: 'agent', senderId: job.agent_id, toAgentId: q.sender_id,
            kind: 'answer', body: text, correlationId: payload.correlationId, replyTo: q.id, taskId: q.task_id, jobId: job.id });
          crew.bus.answered(payload.correlationId, msg);
        }
      } else if (status !== 'retrying') crew.bus.failed(payload.correlationId, error ?? status);
    }
    if (job.type === 'chat' && status === 'done') {
      const text = String(result?.text ?? '').trim();
      if (text) crew.bus.post({ roomId: job.room_id, channelId: payload.channelId, senderType: 'agent', senderId: job.agent_id, kind: 'chat', body: text, jobId: job.id });
    }
    if (job.type === 'task') {
      const t = getTask(job.ref_id);
      if (t && !TERMINAL.has(t.status)) {
        if (status === 'done') {
          // Ending a task job without complete_task is not completion — it is a failed attempt.
          if (t.status !== 'completed' && t.status !== 'review') {
            if (t.kind === 'plan' && db.get("SELECT 1 FROM tasks WHERE project_id = ? AND kind != 'plan'", t.project_id)) {
              setTask(t.id, { status: 'completed', result_summary: 'Plan submitted.' });
            } else retryOrFail(t, job, 'The agent stopped without calling complete_task with evidence.');
          }
        } else if (status === 'waiting') {
          const pause = result?.pause;
          setTask(t.id, { status: 'waiting', paused_reason: pause?.reason ?? error ?? null });
          if (pause && agent) notify(job.room_id, agent.owner_id, `${agent.name} paused “${t.title}”: ${pause.reason}`, pause.kind === 'handoff' ? 'info' : 'warn', `task:${t.id}`);
        }
        else if (status === 'retrying') setTask(t.id, { status: 'queued', result_summary: `Attempt failed: ${error ?? 'unknown error'}. Retrying.` });
        else if (status === 'cancelled') { if (t.status !== 'cancelled') setTask(t.id, { status: agent?.paused ? 'pending' : 'cancelled' }); }
        else retryOrFail(t, job, error ?? 'failed');
      }
    }
    if (agent) {
      const busy = db.get("SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'leased'", agent.id);
      const waiting = db.get("SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'waiting'", agent.id);
      const queued = db.get("SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'queued'", agent.id);
      const blocked = agent.spent_usd >= agent.budget_usd;
      const next = blocked ? 'BLOCKED' : busy ? agent.status : waiting ? 'WAITING' : queued ? 'ASSIGNED' : status === 'failed' ? 'FAILED' : status === 'done' && job.type === 'task' ? 'COMPLETED' : 'IDLE';
      crew.agents.setStatus(agent.id, next, { taskId: busy || waiting ? agent.current_task_id : null });
      crew.office.jobEnded(agent, job, status, error ?? result?.summary);
      if (next === 'COMPLETED' || next === 'FAILED') setTimeout(() => { const a = crew.agents.get(agent.id); if (a && a.status === next) crew.agents.setStatus(agent.id, 'IDLE', { taskId: null }); }, 8000).unref?.();
    }
    kick();
  }

  function retryOrFail(t, job, reason) {
    const p = getProject(t.project_id);
    if (t.attempts < t.max_attempts) {
      setTask(t.id, { status: 'pending', result_summary: `Attempt ${t.attempts} failed: ${reason}` });
    } else {
      setTask(t.id, { status: 'failed', result_summary: reason });
      crew.bus.post({ roomId: p.room_id, channelId: p.channel_id, senderType: 'system', senderId: 'system', kind: 'system', body: `Task “${t.title}” failed after ${t.attempts} attempt(s): ${reason}`, taskId: t.id });
      notify(p.room_id, p.created_by, `Task “${t.title}” failed: ${reason}`, 'error', `task:${t.id}`);
      settleDependents(p.id);
    }
  }

  /** Called by complete_task. Evidence is checked here, on the host, against real files. */
  function completeTask(job, agent, { summary, artifacts = [], tests = null }) {
    const t = getTask(job.ref_id);
    if (!t) throw httpError(404, 'Task not found.');
    if (t.assigned_agent_id !== agent.id) throw httpError(403, 'This task is not assigned to you.');
    const p = getProject(t.project_id);
    const text = String(summary ?? '').trim();
    if (text.length < 20) throw httpError(400, 'Write a real summary of what you did (at least a couple of sentences).');
    if (t.kind === 'plan') throw httpError(400, 'A planning task completes by calling submit_plan.');
    // Definition of Done. In a Git project an agent cannot declare its own work finished:
    // the only way to `completed` is a reviewed merge (reviews.cjs).
    const repos = crew.git.forProject(p.id);
    const eff = crew.policies.effective(p.room_id, { projectId: p.id, agentId: agent.id, taskId: t.id });
    if (t.kind === 'work' && repos.length && crew.hostTools.issuedTools(job, agent, t, p).includes('request_merge')) {
      throw httpError(400, 'This project uses Git: run repo_sync to test, commit and push your branch, then request_merge. The task completes when the merge does.');
    }
    if (t.kind === 'review' && t.mr_id) throw httpError(400, 'This is a merge review: finish it with review_decision.');
    if (t.kind === 'work' && eff.progressReports.value) {
      const file = path.join(filesDir(p.room_id, p.id), 'docs', 'progress', `${agent.id}.md`);
      if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(t.id)) throw httpError(400, `Progress reports are on: write docs/progress/${agent.id}.md with an entry that names task ${t.id}, then complete the task.`);
    }
    if (t.kind === 'synthesis' && eff.updateReadme.value) {
      const inFiles = fs.existsSync(path.join(filesDir(p.room_id, p.id), 'README.md'));
      const inRepo = repos.some((r) => {
        const repo = crew.git.get(r.id);
        return crew.git.log(repo, `${repo.default_branch} -- README.md`, 2).length > 1;
      });
      if (!inFiles && !inRepo) throw httpError(400, 'README updates are on for this milestone: update README.md (setup and stable architecture) first.');
    }
    const paths = [];
    if (t.kind === 'review' || t.kind === 'synthesis') {
      const name = t.kind === 'synthesis' ? 'SUMMARY.md' : `reviews/${slug(t.title)}.md`;
      writeFile(p, agent, t, name, `# ${t.title}\n\n_By ${agent.name} (${agent.role})_\n\n${text}\n`, t.kind === 'synthesis' ? 'report' : 'review');
      paths.push(name);
    }
    for (const a of artifacts) {
      const rel = safeRel(a);
      if (!fs.existsSync(path.join(filesDir(p.room_id, p.id), rel))) throw httpError(400, `Evidence missing: ${rel} is not in the project files. Write it first with write_file.`);
      paths.push(rel);
    }
    if (t.kind === 'work' && !paths.length && !tests) throw httpError(400, 'A work task needs evidence: list the project files you produced in `artifacts`, or include test results.');
    if (tests) {
      const report = `# Test run for “${t.title}”\n\nCommand: \`${String(tests.command ?? '').slice(0, 200)}\`\nExit code: ${Number(tests.exitCode)}\nRan on: ${agent.name}'s owner's worker (sandboxed)\n\n\`\`\`\n${String(tests.output ?? '').slice(0, 20_000)}\n\`\`\`\n`;
      const name = `test-results/${slug(t.title)}.md`;
      writeFile(p, agent, t, name, report, 'test_result');
      paths.push(name);
    }
    for (const rel of paths) db.run('UPDATE artifacts SET task_id = ? WHERE project_id = ? AND path = ? AND task_id IS NULL', t.id, p.id, rel);
    setTask(t.id, { status: 'completed', result_summary: text.slice(0, 4000) });
    crew.bus.post({ roomId: p.room_id, channelId: p.channel_id, senderType: 'agent', senderId: agent.id, kind: 'handoff', body: `Done: ${t.title}\n${text.slice(0, 1500)}${paths.length ? `\nFiles: ${paths.join(', ')}` : ''}`, taskId: t.id, jobId: job.id });
    if (t.kind === 'synthesis') {
      // Work may have arrived while the summary was being written; then the project stays open.
      const stillOpen = db.get("SELECT 1 FROM tasks WHERE project_id = ? AND id != ? AND status NOT IN ('completed','failed','cancelled','blocked')", p.id, t.id);
      db.run('UPDATE projects SET status = ?, summary = ?, updated_at = ? WHERE id = ?', stillOpen ? 'active' : 'completed', text.slice(0, 8000), now(), p.id);
      for (const m of db.all('SELECT user_id FROM project_members WHERE project_id = ?', p.id)) notify(p.room_id, m.user_id, `Project “${p.name}” is complete. The summary is in SUMMARY.md.`, 'info', `project:${p.id}`);
      publishProject(p.id);
    }
    crew.office.taskDone(agent, t, paths);
    return { ok: true, files: paths };
  }

  // --- files ----------------------------------------------------------------

  const filesDir = (roomId, projectId) => path.join(crew.dataDir, 'rooms', roomId, 'projects', projectId, 'files');

  function safeRel(rel) {
    const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some((seg) => seg === '..' || seg === '') || s.length > 200 || /\p{Cc}/u.test(s)) {
      throw httpError(400, `Not an allowed project path: ${rel}. Use a relative path like src/app.js.`);
    }
    return s;
  }

  function writeFile(p, agent, t, rel, content, kind = 'file') {
    const safe = safeRel(rel);
    const body = String(content ?? '');
    if (Buffer.byteLength(body) > MAX_FILE) throw httpError(413, `Files are limited to ${MAX_FILE / 1024} KB.`);
    const root = filesDir(p.room_id, p.id);
    const full = path.join(root, safe);
    if (!full.startsWith(root + path.sep)) throw httpError(400, 'Path escapes the project.');
    if (!fs.existsSync(full) && listFiles(p).length >= MAX_FILES) throw httpError(409, `A project holds at most ${MAX_FILES} files.`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    db.run('DELETE FROM artifacts WHERE project_id = ? AND path = ?', p.id, safe);
    db.run('INSERT INTO artifacts (id, project_id, task_id, agent_id, path, kind, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      newId('art'), p.id, t?.id ?? null, agent?.id ?? null, safe, kind, Buffer.byteLength(body), sha, now());
    crew.hub.broadcast(p.room_id, 'artifact', { projectId: p.id, path: safe, kind, size: Buffer.byteLength(body), agentId: agent?.id ?? null, agentName: agent?.name ?? null, taskId: t?.id ?? null });
    return { path: safe, size: Buffer.byteLength(body), sha256: sha };
  }

  function readFile(p, rel) {
    const safe = safeRel(rel);
    const full = path.join(filesDir(p.room_id, p.id), safe);
    if (!fs.existsSync(full)) throw httpError(404, `No such file: ${safe}`);
    return fs.readFileSync(full, 'utf8');
  }

  function deleteFile(p, rel) {
    const safe = safeRel(rel);
    const full = path.join(filesDir(p.room_id, p.id), safe);
    if (fs.existsSync(full)) fs.rmSync(full);
    db.run('DELETE FROM artifacts WHERE project_id = ? AND path = ?', p.id, safe);
    crew.hub.broadcast(p.room_id, 'artifact', { projectId: p.id, path: safe, deleted: true });
  }

  function listFiles(p) {
    return db.all('SELECT a.path, a.kind, a.size, a.agent_id, a.task_id, a.created_at, g.name agent_name FROM artifacts a LEFT JOIN agents g ON g.id = a.agent_id WHERE a.project_id = ? ORDER BY a.path', p.id)
      .map((a) => ({ path: a.path, kind: a.kind, size: a.size, agentId: a.agent_id, agentName: a.agent_name, taskId: a.task_id, createdAt: a.created_at }));
  }

  // --- memory ---------------------------------------------------------------
  //
  // Four scopes, four boundaries. `project` notes are visible to that project's members and
  // its granted agents. `team` notes belong to one player's agents. `user` notes are a
  // player's own. Private *agent* memory is not here at all: it lives on the owner's worker.

  function addNote(roomId, scope, scopeId, { title, body, authorType, authorId }) {
    if (!['project', 'team', 'user'].includes(scope)) throw httpError(400, 'Scope is project, team or user.');
    const id = newId('mem');
    db.run('INSERT INTO memory (id, room_id, scope, scope_id, title, body, author_type, author_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, roomId, scope, scopeId, cleanName(title, 120) || 'Note', String(body ?? '').slice(0, 8000), authorType, authorId, now());
    const note = db.get('SELECT * FROM memory WHERE id = ?', id);
    if (scope === 'project') crew.hub.broadcast(roomId, 'note', shapeNote(note));
    else crew.hub.broadcast(roomId, 'note', shapeNote(note), { toUser: scope === 'user' ? scopeId : scopeId });
    return shapeNote(note);
  }

  const shapeNote = (n) => ({ id: n.id, scope: n.scope, scopeId: n.scope_id, title: n.title, body: n.body, authorType: n.author_type, authorId: n.author_id, createdAt: n.created_at });

  function searchNotes(scope, scopeId, q = '', limit = 20) {
    const like = `%${String(q).slice(0, 100)}%`;
    return db.all('SELECT * FROM memory WHERE scope = ? AND scope_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT ?', scope, scopeId, like, like, limit).map(shapeNote);
  }

  // --- approvals & notifications -------------------------------------------

  function requestApproval({ roomId, kind, taskId = null, jobId = null, agentId = null, approverId, detail }) {
    const open = db.get("SELECT id FROM approvals WHERE kind = ? AND COALESCE(task_id,'') = COALESCE(?,'') AND COALESCE(job_id,'') = COALESCE(?,'') AND status = 'pending'", kind, taskId, jobId);
    if (open) return open.id;
    const id = newId('apv');
    db.run('INSERT INTO approvals (id, room_id, kind, task_id, job_id, agent_id, approver_id, detail, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, roomId, kind, taskId, jobId, agentId, approverId, json(detail), 'pending', now());
    crew.hub.broadcast(roomId, 'approval', shapeApproval(db.get('SELECT * FROM approvals WHERE id = ?', id)));
    notify(roomId, approverId, approvalText(kind, detail), 'warn', `approval:${id}`);
    if (agentId) crew.office.waitingOnHuman(crew.agents.get(agentId), id, detail);
    return id;
  }

  function approvalText(kind, d) {
    if (kind === 'plan') return `The plan for “${d.project}” is ready for your approval (${d.tasks?.length ?? 0} tasks).`;
    if (kind === 'assignment') return `${d.agentName} was assigned “${d.title}” on “${d.project}”. Approve to let it start.`;
    if (kind === 'tool') return `${d.agentName} wants to use ${d.tool}: ${d.summary ?? ''}`;
    return `${d.agentName ?? 'An agent'} asks for approval: ${d.reason ?? ''}`;
  }

  const shapeApproval = (a) => ({ id: a.id, kind: a.kind, taskId: a.task_id, jobId: a.job_id, agentId: a.agent_id, approverId: a.approver_id, detail: parse(a.detail, {}), status: a.status, decidedBy: a.decided_by, createdAt: a.created_at, decidedAt: a.decided_at });

  function decide(roomId, userId, approvalId, decision, note = '') {
    const a = db.get('SELECT * FROM approvals WHERE id = ? AND room_id = ?', approvalId, roomId);
    if (!a) throw httpError(404, 'No such approval.');
    if (a.approver_id !== userId) throw httpError(403, 'This decision belongs to someone else.');
    if (a.status !== 'pending') throw httpError(409, 'Already decided.');
    if (!['approved', 'rejected'].includes(decision)) throw httpError(400, 'Decision is approved or rejected.');
    db.run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', decision, userId, now(), approvalId);
    crew.audit(roomId, userId, `approval.${decision}`, { approvalId, kind: a.kind });
    const ok = decision === 'approved';
    if (a.agent_id) crew.office.humanDecided(crew.agents.get(a.agent_id), approvalId, ok);
    if (a.kind === 'plan') {
      const t = getTask(a.task_id);
      if (ok) releasePlan(t.project_id, userId);
      else {
        // A rejected plan is thrown away and the manager plans again, told why.
        db.run("DELETE FROM tasks WHERE project_id = ? AND kind != 'plan'", t.project_id);
        db.run("UPDATE projects SET status = 'planning' WHERE id = ?", t.project_id);
        setTask(t.id, { status: 'pending', attempts: 0, description: `${t.description}\n\nThe previous plan was rejected by the project creator.${note ? ` Their feedback: ${String(note).slice(0, 1000)}` : ''}` });
      }
    } else if (a.kind === 'assignment') {
      setTask(a.task_id, { approval_state: ok ? 'approved' : 'rejected', approved_by: userId, status: ok ? 'pending' : 'blocked', result_summary: ok ? null : 'The agent’s owner declined this assignment.' });
      if (!ok) settleDependents(getTask(a.task_id).project_id);
    } else if (a.kind === 'gate') {
      const t = getTask(a.task_id);
      setTask(t.id, { status: ok ? 'completed' : 'blocked', approved_by: userId, result_summary: ok ? `Approved by ${crew.auth.getUser(userId)?.displayName}.${note ? ` ${note}` : ''}` : `Declined by ${crew.auth.getUser(userId)?.displayName}.${note ? ` ${note}` : ''}` });
      if (!ok) settleDependents(t.project_id);
    } else if (a.kind === 'merge') {
      crew.reviews.onMergeDecision(a, ok, userId);
    } else if (a.job_id) {
      // Tool and human approvals resume the parked job, telling the agent the outcome.
      crew.jobs.requeue(a.job_id, { resume: { approvalId, decision, note: String(note).slice(0, 1000), by: crew.auth.getUser(userId)?.displayName } });
    }
    crew.hub.broadcast(roomId, 'approval', shapeApproval(db.get('SELECT * FROM approvals WHERE id = ?', approvalId)));
    db.run('UPDATE notifications SET read = 1 WHERE link = ?', `approval:${approvalId}`);
    kick();
    return shapeApproval(db.get('SELECT * FROM approvals WHERE id = ?', approvalId));
  }

  function notify(roomId, userId, text, level = 'info', link = null) {
    const id = newId('ntf');
    db.run('INSERT INTO notifications (id, room_id, user_id, text, level, link, created_at) VALUES (?,?,?,?,?,?,?)', id, roomId, userId, String(text).slice(0, 500), level, link, now());
    crew.hub.broadcast(roomId, 'notification', { id, text, level, link, read: false, createdAt: now() }, { toUser: userId });
  }

  // --- the context a worker gets with a job ---------------------------------

  /** Everything the worker needs to run a job, filtered to what this agent may see. */
  function buildContext(job) {
    const agent = crew.agents.get(job.agent_id);
    const payload = parse(job.payload, {});
    const room = crew.rooms.get(job.room_id);
    const base = {
      job: { id: job.id, type: job.type, depth: job.depth, attempt: job.attempts },
      agent: { id: agent.id, name: agent.name, role: agent.role, skills: parse(agent.skills, []), instructions: [agent.instructions, crew.profiles.promptSection(agent.id)].filter(Boolean).join('\n\n'), provider: agent.provider, model: agent.model, fallbacks: crew.profiles.fallbacks(agent.id),
        autonomy: agent.autonomy, budgetRemainingUsd: Math.max(0, agent.budget_usd - agent.spent_usd) },
      room: { name: room.name },
      resume: payload.resume ?? null,
    };
    let project = null;
    let task = null;
    if (job.type === 'task') {
      task = getTask(job.ref_id);
      project = getProject(task.project_id);
    } else if (payload.projectId) project = getProject(payload.projectId);
    const g = project ? grantOf(project.id, agent.id) : null;
    const perms = new Set(g ? parse(g.tools, []).filter((t) => parse(agent.tools, []).includes(t)) : []);
    const tools = crew.hostTools.issuedTools(job, agent, task, project);
    base.tools = tools;
    if (project) {
      base.project = {
        id: project.id, name: project.name, goal: project.goal,
        budgetRemainingUsd: g ? Math.max(0, g.budget_usd - g.spent_usd) : 0,
        team: db.all('SELECT agent_id FROM project_grants WHERE project_id = ?', project.id).map((r) => crew.agents.get(r.agent_id)).filter(Boolean)
          .map((a) => ({ name: a.name, role: a.role, owner: crew.auth.getUser(a.owner_id)?.displayName, skills: parse(a.skills, []), available: crew.agents.available(a), isManager: a.id === project.manager_agent_id })),
        files: perms.has('files.read') ? listFiles(project).map((f) => f.path) : [],
        notes: perms.has('memory') ? searchNotes('project', project.id, '', 10).map((n) => ({ title: n.title, body: n.body.slice(0, 600) })) : [],
        repos: perms.has('git') ? crew.git.forProject(project.id).map((r) => ({ id: r.id, name: r.name, url: r.url, defaultBranch: r.defaultBranch })) : [],
      };
      const eff = crew.policies.effective(job.room_id, { projectId: project.id, agentId: agent.id, taskId: task?.id });
      base.rules = {
        lines: crew.policies.promptLines(eff, agent.id, task?.id ?? '-'),
        syncMode: eff.syncMode.value, testsBeforeDone: eff.testsBeforeDone.value, approvalMode: eff.approvalMode.value,
      };
    }
    if (task) {
      const siblings = db.all("SELECT * FROM tasks WHERE project_id = ? AND kind != 'plan' ORDER BY created_at", project.id);
      base.task = {
        id: task.id, kind: task.kind, title: task.title, description: task.description, deliverables: parse(task.deliverables, []),
        previousAttempt: task.attempts > 1 ? task.result_summary : null,
        branch: crew.reviews.branchFor(agent, task), budgetPct: task.budget_pct ?? null,
        mergeRequest: crew.reviews.contextFor(task.kind === 'review' ? task : null), feedback: crew.reviews.feedbackFor(task),
        dependencies: parse(task.deps, []).map(getTask).filter(Boolean).map((d) => ({ title: d.title, result: d.result_summary, files: db.all('SELECT path FROM artifacts WHERE task_id = ?', d.id).map((a) => a.path) })),
        board: task.kind === 'synthesis' || task.kind === 'plan'
          ? siblings.filter((s) => s.id !== task.id).map((s) => ({ title: s.title, status: s.status, agent: crew.agents.get(s.assigned_agent_id)?.name ?? null, result: s.result_summary }))
          : undefined,
      };
    }
    base.inbox = crew.bus.inbox(agent.id, { markDelivered: true }).map((m) => ({ from: m.senderName, kind: m.kind, body: m.body }));
    if (job.type === 'reply') base.question = { from: payload.fromName, body: payload.question, correlationId: payload.correlationId };
    if (job.type === 'chat') {
      base.conversation = crew.bus.history(job.room_id, payload.userId, payload.channelId, { limit: 20 })
        .map((m) => ({ role: m.senderType === 'agent' ? 'assistant' : 'user', name: m.senderName, body: m.body }));
    }
    return base;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'item';
  }

  const listProjects = (roomId) => db.all('SELECT * FROM projects WHERE room_id = ? ORDER BY created_at DESC', roomId).map(shapeProject);
  const listTasks = (projectId) => db.all('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at', projectId).map(shapeTask);
  const approvalsFor = (roomId, userId) => db.all("SELECT * FROM approvals WHERE room_id = ? AND (approver_id = ? OR status = 'pending') ORDER BY created_at DESC LIMIT 100", roomId, userId).map(shapeApproval);
  const notificationsFor = (roomId, userId) => db.all('SELECT * FROM notifications WHERE room_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100', roomId, userId)
    .map((n) => ({ id: n.id, text: n.text, level: n.level, link: n.link, read: Boolean(n.read), createdAt: n.created_at }));

  return {
    createProject, joinProject, grant, revokeGrant, grantOf, startProject, getProject, projectFor, isMember, shapeProject, listProjects, publishProject,
    createTask, assign, acceptPlan, addTask, cancelTask, retryTask, setTaskBudget, getTask, setTask, shapeTask, listTasks, unassignAgent, pickAgent,
    kick, schedule, settle: settleDependents, onJobStarted, onJobFinished, onJobInterrupted, completeTask,
    filesDir, safeRel, writeFile, readFile, deleteFile, listFiles,
    addNote, searchNotes, requestApproval, decide, notify, approvalsFor, notificationsFor, buildContext,
  };
}

module.exports = { createWork };
