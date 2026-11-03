// Who may do what: rooms, roles, invitations, agent ownership, project grants, cross-team
// assignment and messaging. Every refusal here is a boundary between players.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeCrew, present, workerFor, room, agent } = require('./lib/crew-unit.cjs');

const status = (fn) => { try { fn(); return 200; } catch (e) { return e.status ?? 500; } };

test('joining: password, invite-only, invitations, player cap', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const carol = crew.auth.register({ username: 'carol', password: 'carol-pass', displayName: 'Carol' });
  const dave = crew.auth.register({ username: 'dave', password: 'dave-passw', displayName: 'Dave' });
  assert.strictEqual(status(() => crew.rooms.join(carol.id, { code: r.code, password: 'nope' })), 401);
  crew.rooms.updateSettings(r.id, alice.id, { privacy: 'invite' });
  assert.strictEqual(status(() => crew.rooms.join(carol.id, { code: r.code, password: 'pw-1234' })), 403, 'invite-only ignores the password');
  const inv = crew.rooms.createInvite(r.id, alice.id, { role: 'guest', uses: 1 });
  assert.strictEqual(crew.rooms.join(carol.id, { invite: inv.code }).myRole, 'guest');
  assert.strictEqual(status(() => crew.rooms.join(dave.id, { invite: inv.code })), 403, 'used-up invitation');
  const inv2 = crew.rooms.createInvite(r.id, alice.id, { uses: 5 });
  assert.strictEqual(status(() => crew.rooms.join(dave.id, { invite: inv2.code })), 409, 'the room is full (3 players)');
});

test('roles: guests watch and chat; members bring agents; only admins manage', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const guest = crew.auth.register({ username: 'gina', password: 'gina-passw', displayName: 'Gina' });
  crew.rooms.join(guest.id, { invite: crew.rooms.createInvite(r.id, alice.id, { role: 'guest' }).code });
  assert.strictEqual(status(() => agent(crew, r.id, guest.id, 'G', 'Dev')), 403);
  assert.strictEqual(status(() => crew.rooms.createInvite(r.id, bob.id)), 403, 'members cannot invite');
  assert.strictEqual(status(() => crew.rooms.setRole(r.id, bob.id, guest.id, 'admin')), 403);
  assert.strictEqual(status(() => crew.rooms.setStatus(r.id, bob.id, 'stopped')), 403, 'only the owner stops the room');
  crew.rooms.setRole(r.id, alice.id, bob.id, 'admin');
  assert.strictEqual(status(() => crew.rooms.kick(r.id, bob.id, alice.id)), 403, 'an admin cannot remove the owner');
  crew.rooms.setStatus(r.id, alice.id, 'stopped');
  assert.strictEqual(status(() => agent(crew, r.id, bob.id, 'B', 'Dev')), 409, 'a stopped room takes no new work');
});

test('agents belong to their owner, whatever the room role', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const b = agent(crew, r.id, bob.id, 'Boris', 'Backend', { instructions: 'secret brief' });
  assert.strictEqual(status(() => crew.agents.update(b.id, alice.id, { name: 'Mine now' })), 403, 'the room owner cannot reconfigure it');
  assert.strictEqual(status(() => crew.agents.setPaused(b.id, alice.id, true)), 403);
  assert.strictEqual(status(() => crew.agents.remove(b.id, alice.id)), 403);
  assert.strictEqual(crew.agents.list(r.id, alice.id).find((a) => a.id === b.id).instructions, undefined, 'the brief is private');
  assert.strictEqual(crew.agents.list(r.id, bob.id).find((a) => a.id === b.id).instructions, 'secret brief');
});

test('grants: owners lend their own agents, on their terms, after joining', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM', { isManager: true });
  const b = agent(crew, r.id, bob.id, 'Boris', 'Backend', { tools: ['messaging', 'files.read'] });
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  assert.strictEqual(status(() => crew.work.createProject(r.id, alice.id, { name: 'Q', goal: 'g', managerAgentId: b.id })), 403, 'the manager must be your own');
  assert.strictEqual(status(() => crew.work.grant(r.id, alice.id, p.id, b.id, {})), 403, 'Alice cannot lend Bob’s agent');
  assert.strictEqual(status(() => crew.work.grant(r.id, bob.id, p.id, b.id, {})), 403, 'Bob must join first');
  crew.work.joinProject(r.id, bob.id, p.id);
  const g = crew.work.grant(r.id, bob.id, p.id, b.id, { tools: ['messaging', 'files.read', 'exec'], budgetUsd: 3 });
  assert.deepStrictEqual(g.tools.sort(), ['files.read', 'messaging'], 'a grant cannot exceed the agent’s own permissions');
  assert.strictEqual(status(() => crew.work.grant(r.id, bob.id, p.id, b.id, { budgetUsd: 999 })), 400, 'nor its budget');
});

test('cross-team assignment needs the agent owner’s approval, and only theirs', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM', { isManager: true });
  const b = agent(crew, r.id, bob.id, 'Boris', 'Backend');
  const solo = agent(crew, r.id, bob.id, 'Solo', 'Backend');
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  crew.work.joinProject(r.id, bob.id, p.id);
  crew.work.grant(r.id, bob.id, p.id, b.id, { requiresApproval: true });
  assert.strictEqual(status(() => crew.work.addTask(r.id, alice.id, p.id, { title: 'Not granted', agentId: solo.id })), 403, 'an agent not lent to the project cannot be assigned');
  const task = crew.work.addTask(r.id, alice.id, p.id, { title: 'Build the API', agentId: b.id });
  assert.strictEqual(task.status, 'awaiting_approval');
  const ap = crew.work.approvalsFor(r.id, bob.id).find((a) => a.taskId === task.id);
  assert.strictEqual(ap.approverId, bob.id);
  assert.strictEqual(status(() => crew.work.decide(r.id, alice.id, ap.id, 'approved')), 403, 'the project creator (and room owner) cannot approve for Bob');
  crew.work.decide(r.id, bob.id, ap.id, 'approved');
  assert.strictEqual(crew.work.getTask(task.id).approval_state, 'approved');
  // Bob assigning his own agent needs nobody's approval.
  assert.strictEqual(crew.work.addTask(r.id, bob.id, p.id, { title: 'Own work', agentId: b.id }).approvalState, 'none');
});

test('agents may only talk across teams inside a shared project; grants are rechecked per call', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM', { isManager: true });
  const fe = agent(crew, r.id, alice.id, 'Felix', 'Frontend');
  const b = agent(crew, r.id, bob.id, 'Boris', 'Backend');
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  crew.work.grant(r.id, alice.id, p.id, fe.id, { requiresApproval: false });
  const presentA = present(crew, r.id, alice.id);
  const w = workerFor(crew, r.id, alice.id);
  const wk = w.auth();
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
  crew.work.addTask(r.id, alice.id, p.id, { title: 'Frontend', agentId: fe.id });
  crew.work.schedule();
  const job = crew.jobs.claim(wk);
  assert.ok(job, 'Felix’s task was handed to Alice’s worker');
  const send = await crew.hostTools.call(wk, { jobId: job.id, name: 'send_message', args: { to: 'Boris', body: 'hello' } });
  assert.strictEqual(send.ok, false);
  assert.match(send.error, /another team and is not on this project/);
  // Bob's worker cannot claim or act on Alice's job.
  present(crew, r.id, bob.id);
  const wb = workerFor(crew, r.id, bob.id).auth();
  assert.strictEqual(status(() => crew.jobs.held(wb, job.id)), 409);
  // Revoking files.write mid-job removes write_file on the very next call.
  const ok = await crew.hostTools.call(wk, { jobId: job.id, name: 'write_file', args: { path: 'a.txt', content: 'x' } });
  assert.strictEqual(ok.ok, true);
  crew.work.grant(r.id, alice.id, p.id, fe.id, { tools: ['messaging', 'files.read'], requiresApproval: false });
  const denied = await crew.hostTools.call(wk, { jobId: job.id, name: 'write_file', args: { path: 'b.txt', content: 'x' } }).catch((e) => ({ ok: false, error: e.message }));
  assert.match(denied.error, /not permitted/);
  // Path traversal out of the project is refused.
  crew.work.grant(r.id, alice.id, p.id, fe.id, { requiresApproval: false });
  const esc = await crew.hostTools.call(wk, { jobId: job.id, name: 'write_file', args: { path: '../../evil.txt', content: 'x' } });
  assert.match(esc.error, /Not an allowed project path/);
  presentA.leave();
  void b;
});

test('completion needs evidence that exists on the host', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const pm = agent(crew, r.id, alice.id, 'Paige', 'PM', { isManager: true });
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: pm.id });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
  const task = crew.work.addTask(r.id, alice.id, p.id, { title: 'Write it', agentId: pm.id });
  crew.work.schedule();
  const job = crew.jobs.claim(wk);
  const noEvidence = await crew.hostTools.call(wk, { jobId: job.id, name: 'complete_task', args: { summary: 'I did everything you asked, trust me.' } });
  assert.match(noEvidence.error, /needs evidence/);
  const fake = await crew.hostTools.call(wk, { jobId: job.id, name: 'complete_task', args: { summary: 'Wrote the file as requested.', artifacts: ['made-up.js'] } });
  assert.match(fake.error, /Evidence missing/);
  await crew.hostTools.call(wk, { jobId: job.id, name: 'write_file', args: { path: 'real.js', content: 'module.exports = 1;' } });
  const real = await crew.hostTools.call(wk, { jobId: job.id, name: 'complete_task', args: { summary: 'Wrote real.js with the export.', artifacts: ['real.js'] } });
  assert.strictEqual(real.ok, true);
  assert.strictEqual(crew.work.getTask(task.id).status, 'completed');
});
