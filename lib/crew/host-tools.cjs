// Tools that touch shared room state, executed by the host on behalf of a worker.
//
// The worker says "agent X, in job J, calls tool T with these arguments". Before anything
// happens the host checks: the worker holds J's lease, J belongs to X, T is in the set the
// job was issued with (which is the intersection of what X's owner gave X and what X's
// owner granted on this project), and any per-tool rule — cross-team messaging only within
// a shared project, sensitive tools behind a human approval.
//
// Arguments are treated as untrusted model output. Nothing an agent says to another agent
// is a grant of authority: a message is text in the recipient's context, nothing more.

'use strict';

const { newId, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');
const { TOOLS, PROVIDERS } = require('./catalog.cjs');

const ASK_TIMEOUT_MS = 150_000;
const MAX_ASK_DEPTH = 2;
const MAX_DELEGATION_DEPTH = 5;
const MAX_TASKS_PER_PROJECT = 300;

function createHostTools(crew) {
  const { db } = crew;

  function context(worker, jobId) {
    crew.safety.refuseIfStopped(worker.room_id);
    const job = crew.jobs.held(worker, jobId);
    const agent = crew.agents.get(job.agent_id);
    if (!agent || agent.owner_id !== worker.user_id) throw httpError(403, 'This worker does not own that agent.');
    const payload = parse(job.payload, {});
    const task = job.type === 'task' ? crew.work.getTask(job.ref_id) : null;
    const projectId = task?.project_id ?? payload.projectId ?? null;
    const project = projectId ? crew.work.getProject(projectId) : null;
    const issued = new Set(issuedTools(job, agent, task, project));
    return { job, agent, payload, task, project, issued };
  }

  function issuedTools(job, agent, task, project) {
    // Recomputed rather than trusted from the worker: a grant revoked mid-job takes effect
    // on the very next call.
    const g = project ? crew.work.grantOf(project.id, agent.id) : null;
    const perms = new Set(g ? parse(g.tools, []).filter((t) => parse(agent.tools, []).includes(t)) : []);
    const names = job.type === 'task'
      ? Object.keys(TOOLS).filter((n) => {
        const d = TOOLS[n];
        if (d.managerOnly && task?.kind !== 'plan') return false;
        if (task?.kind === 'plan' && ['complete_task', 'write_file', 'delete_file', 'delegate_task', 'request_review', 'run_command', 'request_merge', 'repo_write', 'repo_sync', 'repo_merge_main'].includes(n)) return false;
        // Git projects: reviewers decide, authors request merges; neither does the other's job.
        const gitProject = project && crew.git.forProject(project.id).length > 0;
        if ((n === 'request_merge' || n.startsWith('repo_')) && !gitProject) return false;
        if (n === 'review_decision' && !(task?.kind === 'review' && task?.mr_id)) return false;
        if (n === 'request_merge' && task?.kind !== 'work') return false;
        return d.needs === null || perms.has(d.needs);
      })
      : ['list_team', 'read_file', 'list_files', 'search_memory', 'recall'].filter((n) => TOOLS[n].needs === null || perms.has(TOOLS[n].needs));
    return names;
  }

  function requireTool(ctx, name) {
    if (!TOOLS[name]) throw httpError(400, `Unknown tool ${name}.`);
    if (!ctx.issued.has(name)) throw httpError(403, `${ctx.agent.name} is not permitted to use ${name} here.`);
    if (ctx.job.cancel) throw httpError(409, 'This job was cancelled.', { cancelled: true });
  }

  /** Which risk-table action a tool call is (policies.cjs RISK), if any. */
  const ACTION = { delete_file: 'delete_shared', run_command: 'run_code', fetch_url: 'web_fetch', delegate_task: 'delegate', repo_sync: 'push_branch' };

  /**
   * Approval gate. The effective approval mode (office → project → team → agent → task)
   * decides discretionary actions; safeguards marked `always` apply in every mode.
   */
  function gate(ctx, name, summary, action = ACTION[name]) {
    if (!action) return null;
    const eff = crew.policies.effective(ctx.job.room_id, { projectId: ctx.project?.id, agentId: ctx.agent.id, taskId: ctx.task?.id });
    const reason = crew.policies.needsApproval(action, eff);
    if (!reason) return null;
    const resume = ctx.payload.resume;
    const pending = ctx.payload.pendingTool;
    if (resume && pending && pending.tool === name && pending.summary === summary && resume.approvalId === pending.approvalId) {
      return resume.decision === 'approved' ? null : { denied: true, note: resume.note };
    }
    const approvalId = crew.work.requestApproval({
      roomId: ctx.job.room_id, kind: 'tool', taskId: ctx.task?.id ?? null, jobId: ctx.job.id, agentId: ctx.agent.id, approverId: ctx.agent.owner_id,
      detail: { agentName: ctx.agent.name, tool: name, summary, project: ctx.project?.name, reason, mode: eff.approvalMode.value, modeSource: eff.approvalMode.source },
    });
    // Remember what is being approved, so the resumed job recognises the same call.
    db.run('UPDATE jobs SET payload = ? WHERE id = ?', JSON.stringify({ ...ctx.payload, pendingTool: { tool: name, summary, approvalId } }), ctx.job.id);
    return { waiting: true, approvalId };
  }

  function teamMember(ctx, ref) {
    const target = crew.agents.resolve(ctx.job.room_id, ref);
    if (!target) throw httpError(404, `No agent called ${ref} in this office. Use list_team.`);
    if (target.id === ctx.agent.id) throw httpError(400, 'That is you.');
    // Cross-team traffic only inside a project both agents were granted to.
    const shared = ctx.project && crew.work.grantOf(ctx.project.id, target.id);
    if (!shared && target.owner_id !== ctx.agent.owner_id) throw httpError(403, `${target.name} belongs to another team and is not on this project.`);
    return target;
  }

  const channelFor = (ctx) => ctx.project?.channel_id ?? crew.bus.ensureChannel(ctx.job.room_id, 'agent-updates', 'public').id;

  const handlers = {
    list_team(ctx) {
      if (!ctx.project) return { team: crew.agents.ofOwner(ctx.job.room_id, ctx.agent.owner_id).map((a) => ({ name: a.name, role: a.role })) };
      return { team: db.all('SELECT agent_id FROM project_grants WHERE project_id = ?', ctx.project.id).map((g) => crew.agents.get(g.agent_id)).filter(Boolean)
        .map((a) => ({ name: a.name, role: a.role, skills: parse(a.skills, []), owner: crew.auth.getUser(a.owner_id)?.displayName, status: a.status, available: crew.agents.available(a), ai: PROVIDERS[a.provider]?.label ?? a.provider, aiState: crew.workers.providersOf(ctx.job.room_id, a.owner_id)?.[a.provider]?.state ?? 'not reported', canUseTools: crew.workers.providersOf(ctx.job.room_id, a.owner_id)?.[a.provider]?.tools ?? 'not reported' })) };
    },

    read_task(ctx) {
      if (!ctx.project) return { tasks: [] };
      return { tasks: crew.work.listTasks(ctx.project.id).map((t) => ({ title: t.title, kind: t.kind, status: t.status, agent: t.assignedAgentName, result: t.resultSummary, files: t.artifacts.map((a) => a.path) })) };
    },

    send_message(ctx, { to, body, kind = 'chat' }) {
      const allowedKinds = ['chat', 'progress', 'handoff', 'artifact', 'review_request'];
      const k = allowedKinds.includes(kind) ? kind : 'chat';
      let toAgentId = null;
      let channelId = channelFor(ctx);
      if (to && !String(to).startsWith('#')) toAgentId = teamMember(ctx, to).id;
      else if (to && String(to).startsWith('#')) {
        const ch = db.get('SELECT * FROM channels WHERE room_id = ? AND name = ? AND kind != ?', ctx.job.room_id, String(to).slice(1).toLowerCase(), 'dm');
        if (!ch) throw httpError(404, `No channel ${to}.`);
        channelId = ch.id;
      }
      crew.bus.guardAgentSend(ctx.agent, { toAgentId, taskId: ctx.task?.id, body });
      const m = crew.bus.post({ roomId: ctx.job.room_id, channelId, senderType: 'agent', senderId: ctx.agent.id, toAgentId, kind: k, body, taskId: ctx.task?.id, jobId: ctx.job.id });
      return { sent: true, messageId: m.id };
    },

    async ask_agent(ctx, { agent: ref, question }) {
      if (ctx.job.depth >= MAX_ASK_DEPTH) throw httpError(409, 'You are already answering a question; answer from what you know instead of asking further.');
      const target = teamMember(ctx, ref);
      if (!crew.agents.available(target)) return { answered: false, reason: `${target.name} is unavailable right now (its owner’s worker is offline or it is paused). Continue without it or message it to read later.` };
      crew.bus.guardAgentSend(ctx.agent, { toAgentId: target.id, taskId: ctx.task?.id, body: question });
      const correlationId = newId('corr');
      crew.bus.post({ roomId: ctx.job.room_id, channelId: channelFor(ctx), senderType: 'agent', senderId: ctx.agent.id, toAgentId: target.id, kind: 'question',
        body: question, correlationId, taskId: ctx.task?.id, jobId: ctx.job.id });
      crew.jobs.enqueue({ roomId: ctx.job.room_id, agentId: target.id, type: 'reply', refId: correlationId, depth: ctx.job.depth + 1, idemKey: `reply:${correlationId}`,
        payload: { correlationId, question: String(question).slice(0, 4000), fromName: ctx.agent.name, projectId: ctx.project?.id ?? null } });
      crew.office.meeting(ctx.agent, target, true);
      crew.agents.setStatus(ctx.agent.id, 'WAITING');
      const answer = await crew.bus.awaitAnswer(correlationId, ASK_TIMEOUT_MS);
      crew.office.meeting(ctx.agent, target, false);
      crew.agents.setStatus(ctx.agent.id, ctx.task?.kind === 'plan' ? 'PLANNING' : ctx.task?.kind === 'review' ? 'REVIEW' : 'WORKING');
      if (!answer) return { answered: false, reason: `${target.name} has not answered yet. The answer will arrive in your inbox; carry on with what you can.` };
      if (answer.failed) return { answered: false, reason: `${target.name} could not answer: ${answer.reason}` };
      return { answered: true, from: target.name, answer: answer.body };
    },

    report_progress(ctx, { text }) {
      crew.bus.guardAgentSend(ctx.agent, { body: text });
      crew.bus.post({ roomId: ctx.job.room_id, channelId: channelFor(ctx), senderType: 'agent', senderId: ctx.agent.id, kind: 'progress', body: text, taskId: ctx.task?.id, jobId: ctx.job.id });
      crew.jobs.log(ctx.job, 'info', `Progress: ${text}`);
      return { ok: true };
    },

    list_files(ctx) { return { files: crew.work.listFiles(ctx.project).map((f) => ({ path: f.path, size: f.size, by: f.agentName })) }; },
    read_file(ctx, { path }) {
      const text = crew.work.readFile(ctx.project, path);
      return { path, content: text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(truncated)` : text };
    },
    write_file(ctx, { path, content }) {
      const isDoc = /^(README\.md|docs\/)/i.test(String(path ?? ''));
      const g = isDoc ? gate(ctx, 'write_file', `publish ${path}`, 'publish_docs') : null;
      if (g) return g.denied ? { denied: true, note: g.note } : g;
      const out = crew.work.writeFile(ctx.project, ctx.agent, ctx.task, path, content);
      crew.office.artifact(ctx.agent, out.path);
      return out;
    },
    delete_file(ctx, { path }) {
      const g = gate(ctx, 'delete_file', `delete ${path}`);
      if (g) return g.denied ? { denied: true, note: g.note } : g;
      crew.work.deleteFile(ctx.project, path);
      return { deleted: path };
    },

    search_memory(ctx, { query = '' }) { return { notes: crew.work.searchNotes('project', ctx.project.id, query) }; },
    write_note(ctx, { title, body }) {
      return crew.work.addNote(ctx.job.room_id, 'project', ctx.project.id, { title, body, authorType: 'agent', authorId: ctx.agent.id });
    },

    delegate_task(ctx, { title, description, role, agent: ref, handoff }) {
      const eff = crew.policies.effective(ctx.job.room_id, { projectId: ctx.project.id, agentId: ctx.agent.id, taskId: ctx.task?.id });
      if (eff.handoffNotes.value && String(handoff ?? '').trim().length < 40) throw httpError(400, 'Handoff notes are on for this work: pass `handoff` — what is done, what is left, where things are, how to test — and it is saved as docs/handoffs/<task-id>.md.');
      // A chain of agents handing work to each other ends here, whatever they decide.
      let depth = 0;
      for (let t = ctx.task; t?.parent_id && depth <= MAX_DELEGATION_DEPTH; t = crew.work.getTask(t.parent_id)) depth++;
      if (depth >= MAX_DELEGATION_DEPTH) throw httpError(409, `This work has already been handed on ${depth} times. Finish it yourself or ask a person.`);
      if (db.get('SELECT COUNT(*) n FROM tasks WHERE project_id = ?', ctx.project.id).n >= MAX_TASKS_PER_PROJECT) throw httpError(409, `This project has reached ${MAX_TASKS_PER_PROJECT} tasks. A person has to decide what happens next.`);
      const g = gate(ctx, 'delegate_task', `delegate “${title}”`);
      if (g) return g.denied ? { denied: true, note: g.note } : g;
      const targetId = ref ? teamMember(ctx, ref).id : crew.work.pickAgent(ctx.project, `${role ?? ''} ${title}`, { exclude: [ctx.agent.id], allow: (id) => crew.profiles.mayDelegateTo(ctx.agent.id, id) });
      if (!targetId) throw httpError(409, 'Nobody on this project fits that role.');
      if (!crew.profiles.mayDelegateTo(ctx.agent.id, targetId)) throw httpError(403, `Your owner does not let you delegate to ${crew.agents.get(targetId)?.name}. Choose someone else, or do this yourself.`);
      const t = crew.work.createTask(ctx.project, { kind: 'work', title, description, roleHint: role, parentId: ctx.task?.id, by: { type: 'agent', id: ctx.agent.id } });
      if (eff.handoffNotes.value) {
        const note = `# Handoff: ${title}

Task: ${t.id}
From: ${ctx.agent.name} (task ${ctx.task?.id ?? '-'})
Date: ${new Date().toISOString()}

${String(handoff).trim()}
`;
        crew.work.writeFile(ctx.project, ctx.agent, ctx.task, `docs/handoffs/${t.id}.md`, note, 'handoff');
      }
      crew.work.assign(t.id, targetId, { by: { type: 'agent', id: ctx.agent.id } });
      const target = crew.agents.get(targetId);
      crew.bus.post({ roomId: ctx.job.room_id, channelId: channelFor(ctx), senderType: 'agent', senderId: ctx.agent.id, toAgentId: targetId, kind: 'delegation', body: `I delegated “${title}” to you. ${description ?? ''}`.trim(), taskId: t.id, jobId: ctx.job.id });
      return { taskId: t.id, assignedTo: target.name, status: crew.work.getTask(t.id).status };
    },

    request_review(ctx, { agent: ref, files = [], note = '' }) {
      const target = teamMember(ctx, ref);
      const t = crew.work.createTask(ctx.project, { kind: 'review', title: `Review for ${ctx.agent.name}: ${(ctx.task?.title ?? 'work').slice(0, 60)}`,
        description: `${ctx.agent.name} asks you to review: ${files.join(', ') || 'their recent work'}. ${note}`.trim(), parentId: ctx.task?.id, by: { type: 'agent', id: ctx.agent.id } });
      crew.work.assign(t.id, target.id, { by: { type: 'agent', id: ctx.agent.id } });
      crew.bus.post({ roomId: ctx.job.room_id, channelId: channelFor(ctx), senderType: 'agent', senderId: ctx.agent.id, toAgentId: target.id, kind: 'review_request', body: `Please review ${files.join(', ') || 'my work'}. ${note}`.trim(), taskId: t.id, jobId: ctx.job.id });
      return { reviewTaskId: t.id, reviewer: target.name };
    },

    request_human_approval(ctx, { reason }) {
      const resume = ctx.payload.resume;
      if (resume && ctx.payload.pendingTool?.tool === 'request_human_approval') return { decision: resume.decision, note: resume.note, by: resume.by };
      const approverId = ctx.project?.created_by ?? ctx.agent.owner_id;
      const approvalId = crew.work.requestApproval({ roomId: ctx.job.room_id, kind: 'human', taskId: ctx.task?.id ?? null, jobId: ctx.job.id, agentId: ctx.agent.id, approverId,
        detail: { agentName: ctx.agent.name, reason: String(reason).slice(0, 1000), project: ctx.project?.name } });
      db.run('UPDATE jobs SET payload = ? WHERE id = ?', JSON.stringify({ ...ctx.payload, pendingTool: { tool: 'request_human_approval', approvalId } }), ctx.job.id);
      return { waiting: true, approvalId };
    },

    submit_plan(ctx, plan) {
      if (ctx.project.manager_agent_id !== ctx.agent.id) throw httpError(403, 'Only the project manager submits the plan.');
      const out = crew.work.acceptPlan(ctx.task, ctx.agent, plan);
      return { ...out, next: 'The plan is waiting for the project creator’s approval. Your planning task is finished; stop here.' };
    },

    complete_task(ctx, args) { return crew.work.completeTask(ctx.job, ctx.agent, args); },

    request_merge(ctx, args) { return crew.reviews.request(ctx, args ?? {}); },

    review_decision(ctx, args) { return crew.reviews.decide(ctx, args ?? {}); },
  };

  /** Run one host tool. Errors become a structured result the model can read and react to. */
  async function call(worker, { jobId, name, args }) {
    const ctx = context(worker, jobId);
    try { requireTool(ctx, name); } catch (err) { crew.audit(ctx.job.room_id, worker.user_id, 'tool.request', { tool: name, why: err.message }, { outcome: 'denied', agentId: ctx.agent.id, projectId: ctx.project?.id, resource: name }); throw err; }
    if (TOOLS[name].runs !== 'host') throw httpError(400, `${name} runs on the worker, not the host.`);
    if (!ctx.project && !['list_team', 'report_progress', 'send_message'].includes(name)) throw httpError(400, `${name} needs a project context.`);
    crew.office.toolStart(ctx.agent, ctx.job, name, args);
    crew.jobs.log(ctx.job, 'tool', `${name}(${summarise(args)})`);
    try {
      const result = await handlers[name](ctx, args ?? {});
      crew.office.toolEnd(ctx.agent, ctx.job, name, 'ok');
      crew.audit(ctx.job.room_id, worker.user_id, 'tool.call', { tool: name }, { agentId: ctx.agent.id, projectId: ctx.project?.id, resource: name });
      return { ok: true, result };
    } catch (err) {
      crew.office.toolEnd(ctx.agent, ctx.job, name, 'error');
      if (err.cancelled) return { ok: false, cancelled: true, error: err.message };
      if (!err.status) crew.crash.record(`tool ${name}`, err);
      crew.jobs.log(ctx.job, 'warn', `${name} refused: ${err.message}`);
      crew.audit(ctx.job.room_id, worker.user_id, 'tool.call', { tool: name, why: String(err.message).slice(0, 200) }, { outcome: 'denied', agentId: ctx.agent.id, projectId: ctx.project?.id, resource: name });
      return { ok: false, error: err.message };
    }
  }

  /** A worker asks before running a local tool; the host decides with the same rules. */
  function authorize(worker, { jobId, name, summary }) {
    const ctx = context(worker, jobId);
    try { requireTool(ctx, name); } catch (err) { crew.audit(ctx.job.room_id, worker.user_id, 'tool.request', { tool: name, why: err.message }, { outcome: 'denied', agentId: ctx.agent.id, projectId: ctx.project?.id, resource: name }); throw err; }
    if (TOOLS[name].runs !== 'worker') throw httpError(400, `${name} is a host tool.`);
    const g = gate(ctx, name, String(summary ?? '').slice(0, 300));
    crew.office.toolStart(ctx.agent, ctx.job, name, { summary });
    crew.jobs.log(ctx.job, 'tool', `${name}: ${summary}`);
    crew.audit(ctx.job.room_id, worker.user_id, 'tool.authorize', { tool: name, summary: String(summary ?? '').slice(0, 200), decision: g?.waiting ? 'waiting' : g?.denied ? 'denied' : 'allowed' }, { outcome: g?.denied ? 'denied' : 'ok', agentId: ctx.agent.id, projectId: ctx.project?.id, resource: name });
    if (g?.waiting) return { allowed: false, waiting: true, approvalId: g.approvalId };
    if (g?.denied) return { allowed: false, denied: true, note: g.note };
    return { allowed: true };
  }

  function localDone(worker, { jobId, name, status }) {
    const ctx = context(worker, jobId);
    crew.office.toolEnd(ctx.agent, ctx.job, name, status === 'ok' ? 'ok' : 'error');
    return { ok: true };
  }

  /** Usage after each model call: budgets are enforced here, not only on the worker. */
  function usage(worker, { jobId, tokensIn = 0, tokensOut = 0, usd = 0, model }) {
    const ctx = context(worker, jobId);
    const tin = Math.max(0, tokensIn | 0);
    const tout = Math.max(0, tokensOut | 0);
    const cost = Math.max(0, Number(usd) || 0);
    crew.agents.addUsage(ctx.agent.id, tin, tout, cost);
    if (ctx.task) db.run('UPDATE tasks SET tokens = tokens + ?, actual_cost = actual_cost + ? WHERE id = ?', tin + tout, cost, ctx.task.id);
    if (ctx.project) db.run('UPDATE project_grants SET spent_usd = spent_usd + ? WHERE project_id = ? AND agent_id = ?', cost, ctx.project.id, ctx.agent.id);
    crew.jobs.log(ctx.job, 'usage', `${model}: ${tin} in / ${tout} out, $${cost.toFixed(4)}`);
    const agent = crew.agents.get(ctx.agent.id);
    const g = ctx.project ? crew.work.grantOf(ctx.project.id, agent.id) : null;
    if (agent.spent_usd >= agent.budget_usd) return { stop: true, reason: `${agent.name} has reached its budget of $${agent.budget_usd}.` };
    if (g && g.budget_usd > 0 && g.spent_usd >= g.budget_usd) return { stop: true, reason: `${agent.name} has used its $${g.budget_usd} budget on this project.` };
    return { stop: false, cancel: Boolean(crew.jobs.get(jobId).cancel) };
  }

  return { call, authorize, localDone, usage, issuedTools };
}

function summarise(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

module.exports = { createHostTools };
