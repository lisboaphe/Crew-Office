// One switch, in one place: what is switched on in an agent's own panel is what it can use — on
// its owner's projects, in a project's chat, and from a direct chat, where asking for work starts
// it. Lending to somebody else's project can still narrow it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCrew, present, workerFor, room, agent } = require('./lib/crew-unit.cjs');

const chatJob = (crew, r, from, a, { channelId, projectId = null }) => {
  const msg = crew.bus.post({ roomId: r.id, channelId, senderType: 'human', senderId: from.id, toAgentId: a.id, kind: 'chat', body: 'Please build it.' });
  return crew.jobs.enqueue({ roomId: r.id, agentId: a.id, type: 'chat', refId: msg.id, idemKey: `chat:${msg.id}:${a.id}`, payload: { channelId, userId: from.id, projectId } });
};
const issued = (crew, job) => crew.work.buildContext(crew.db.get('SELECT * FROM jobs WHERE id = ?', job.id)).tools;

test('a tool switched on after the project was made is usable in it at once', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM', { isManager: true, tools: ['messaging', 'files.read'] });
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  assert.deepEqual(crew.work.toolsOn(p, crew.agents.get(pm.id)), ['messaging', 'files.read']);
  crew.agents.update(pm.id, alice.id, { tools: ['messaging', 'files.read', 'files.write', 'delegate', 'exec'] });
  assert.deepEqual(crew.work.toolsOn(p, crew.agents.get(pm.id)).sort(), ['delegate', 'exec', 'files.read', 'files.write', 'messaging']);
});

test('lending to someone else’s project: a full loan follows the agent, a narrowed one stays narrow', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM');
  const full = agent(crew, r.id, bob.id, 'Boris', 'Backend', { tools: ['messaging'] });
  const narrow = agent(crew, r.id, bob.id, 'Bea', 'Backend', { tools: ['messaging', 'files.read'] });
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  crew.work.joinProject(r.id, bob.id, p.id);
  crew.work.grant(r.id, bob.id, p.id, full.id, {});
  crew.work.grant(r.id, bob.id, p.id, narrow.id, { tools: ['messaging'] });
  crew.agents.update(full.id, bob.id, { tools: ['messaging', 'files.write'] });
  crew.agents.update(narrow.id, bob.id, { tools: ['messaging', 'files.read', 'files.write'] });
  assert.deepEqual(crew.work.toolsOn(p, crew.agents.get(full.id)), ['messaging', 'files.write'], 'it lent everything, so it still does');
  assert.deepEqual(crew.work.toolsOn(p, crew.agents.get(narrow.id)), ['messaging'], 'Bob chose what to lend here, and that holds');
  crew.agents.update(narrow.id, bob.id, { tools: ['files.read'] });
  assert.deepEqual(crew.work.toolsOn(p, crew.agents.get(narrow.id)), [], 'switched off on the agent is off everywhere');
});

test('in a project’s chat, the agent gets its own tools, not just lookups', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM');
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  const ch = crew.bus.channelsFor(r.id, alice.id).find((c) => c.projectId === p.id);
  const tools = issued(crew, chatJob(crew, r, alice, pm, { channelId: ch.id, projectId: p.id }));
  for (const n of ['write_file', 'delegate_task', 'run_command', 'read_task', 'send_message']) assert.ok(tools.includes(n), `${n} is there`);
  for (const n of ['complete_task', 'submit_plan', 'start_project']) assert.ok(!tools.includes(n), `${n} is not: it needs a task, or the chat already has a project`);
});

test('in a direct chat, asking for work starts a project with the owner’s team, and its plan goes out', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Manager', 'Project manager', { isManager: true });
  agent(crew, r.id, alice.id, 'Code Developer', 'Developer');
  agent(crew, r.id, bob.id, 'Boris', 'Backend');
  const dm = crew.bus.dmChannel(r.id, alice.id, pm.id);
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();

  const job = chatJob(crew, r, alice, pm, { channelId: dm.id });
  const tools = issued(crew, job);
  assert.ok(tools.includes('start_project'), 'an agent with delegate can start work from chat');
  assert.ok(!tools.includes('write_file'), 'nothing needs a project it does not have');
  const leased = crew.jobs.claim(wk);
  assert.equal(leased.id, job.id);
  const out = await crew.hostTools.call(wk, { jobId: job.id, name: 'start_project', args: { name: 'MT5 bot', goal: 'Build an MT5 trading bot and backtest it.' } });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result.team, ['Code Developer'], 'the owner’s agents join, nobody else’s');

  const p = crew.work.listProjects(r.id).find((x) => x.name === 'MT5 bot');
  assert.equal(p.status, 'planning');
  const plan = crew.db.get("SELECT * FROM tasks WHERE project_id = ? AND kind = 'plan'", p.id);
  assert.equal(plan.assigned_agent_id, pm.id);
  // The plan, for the owner's own agents, needs no second yes: asking was it.
  const res = crew.work.acceptPlan(plan, crew.agents.get(pm.id), { tasks: [{ key: 'bot', title: 'Write the bot', assignee: 'Code Developer' }, { key: 'test', title: 'Backtest it', assignee: 'Code Developer', depends_on: ['bot'] }] });
  assert.equal(res.released, true);
  assert.equal(crew.work.getProject(p.id).status, 'active');
  assert.equal(crew.work.approvalsFor(r.id, alice.id).filter((a) => a.kind === 'plan').length, 0);
});

test('without delegate, a direct chat has no start_project, and says which switch it needs', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Manager', 'PM', { tools: ['messaging', 'files.read'] });
  const dm = crew.bus.dmChannel(r.id, alice.id, pm.id);
  assert.ok(!issued(crew, chatJob(crew, r, alice, pm, { channelId: dm.id })).includes('start_project'));
});

test('a plan waits for its creator when someone else’s agent is on it, or approvals are manual', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Manager', 'PM', { isManager: true });
  const boris = agent(crew, r.id, bob.id, 'Boris', 'Backend');
  const planFor = (name, lend) => {
    const p = crew.work.createProject(r.id, alice.id, { name, goal: 'g', managerAgentId: pm.id });
    if (lend) { crew.work.joinProject(r.id, bob.id, p.id); crew.work.grant(r.id, bob.id, p.id, boris.id, {}); }
    crew.work.startProject(r.id, alice.id, p.id);
    return { p, plan: crew.db.get("SELECT * FROM tasks WHERE project_id = ? AND kind = 'plan'", p.id) };
  };
  const own = planFor('Own', false);
  assert.equal(crew.work.acceptPlan(own.plan, crew.agents.get(pm.id), { tasks: [{ key: 'a', title: 'Do it', assignee: 'Manager' }] }).released, true, 'started by hand, all hers: it goes out too');
  const shared = planFor('Shared', true);
  crew.work.acceptPlan(shared.plan, crew.agents.get(pm.id), { tasks: [{ key: 'a', title: 'Do it', assignee: 'Boris' }] });
  assert.equal(crew.work.getProject(shared.p.id).status, 'awaiting_plan_approval', 'Bob’s agent is on it');
  crew.agents.update(pm.id, alice.id, { autonomy: 'ask' });
  const careful = planFor('Careful', false);
  crew.work.acceptPlan(careful.plan, crew.agents.get(pm.id), { tasks: [{ key: 'a', title: 'Do it', assignee: 'Manager' }] });
  assert.equal(crew.work.getProject(careful.p.id).status, 'awaiting_plan_approval', 'the manager is set to ask first');
});
