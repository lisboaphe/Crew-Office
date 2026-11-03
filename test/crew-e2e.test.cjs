// The required multiplayer demo, end to end, against a real host process and real
// workers: Alice hosts, Bob joins with the room password, each brings three agents on
// their own worker, Alice's project manager plans, both approve, the agents exchange real
// correlated messages across teams, write files, run the tests in the sandbox, review,
// and summarise — and everything is still there after the host restarts.
//
// The agents use the scripted test provider (no AI model), so this runs offline and
// deterministically; every layer below the provider is the production code path.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startHost, player, startWorker, waitFor } = require('./lib/crew-harness.cjs');

const FAKE_KEY = 'sk-ant-api03-FAKE-SECRET-should-never-leave-the-worker-0000';

test('Alice and Bob build a task app together, across teams and machines', { timeout: 180_000 }, async (t) => {
  let host = await startHost();
  const alice = player(host.url);
  const bob = player(host.url);
  const workers = [];
  t.after(async () => { alice.leaveAll(); bob.leaveAll(); for (const w of workers) w.stop(); await host.stop(); });

  // --- Phase 1: accounts, hosting, joining ---
  assert.strictEqual((await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' })).status, 200);
  assert.strictEqual((await bob.post('/api/crew/register', { username: 'bob', password: 'bob-pass-12', displayName: 'Bob' })).status, 200);
  const { room } = await alice.post('/api/crew/rooms', { name: 'Alice’s studio', privacy: 'password', password: 'office-pw', maxPlayers: 4 });
  assert.ok(room?.code, 'room has a code');
  assert.strictEqual((await bob.post('/api/crew/rooms/join', { code: room.code, password: 'wrong' })).status, 401, 'wrong password refused');
  const joined = await bob.post('/api/crew/rooms/join', { code: room.code, password: 'office-pw' });
  assert.strictEqual(joined.status, 200);
  assert.strictEqual(joined.room.myRole, 'member');
  const R = `/api/crew/rooms/${room.id}`;

  // Both players are "in the office" (presence drives whether attended workers run).
  const aliceView = await alice.enter(room.id);
  await bob.enter(room.id);

  // --- Phase 2: each player's own team ---
  const mk = (p, name, role, skills, extra = {}) => p.post(`${R}/agents`, { name, role, skills, provider: 'scripted', model: 'scripted', tools: ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec'], budgetUsd: 50, ...extra });
  const pm = (await mk(alice, 'Paige', 'Project Manager', ['planning'], { isManager: true })).agent;
  const fe = (await mk(alice, 'Felix', 'Frontend Developer', ['html', 'javascript'])).agent;
  const ds = (await mk(alice, 'Uma', 'UI Designer', ['css'])).agent;
  const be = (await mk(bob, 'Boris', 'Backend Developer', ['node', 'api'])).agent;
  const qa = (await mk(bob, 'Quinn', 'QA Engineer', ['testing'])).agent;
  const sec = (await mk(bob, 'Sasha', 'Security Reviewer', ['security'])).agent;
  assert.ok(pm && fe && ds && be && qa && sec, 'six agents created');

  // Ownership: Bob cannot reconfigure, pause or remove Alice's agent, nor the reverse.
  assert.strictEqual((await bob.patch(`${R}/agents/${fe.id}`, { name: 'Hijacked' })).status, 403);
  assert.strictEqual((await bob.post(`${R}/agents/${fe.id}/pause`)).status, 403);
  assert.strictEqual((await alice.del(`${R}/agents/${be.id}`)).status, 403);
  // Another player's brief is not visible to them.
  const bobsView = await bob.get(`${R}/state`);
  assert.strictEqual(bobsView.agents.find((a) => a.id === fe.id).instructions, undefined);

  // Workers: one on each player's machine. Alice's holds a (fake) Anthropic key.
  const wa = await alice.post(`${R}/workers`, { name: 'Alice laptop' });
  const wb = await bob.post(`${R}/workers`, { name: 'Bob desktop' });
  workers.push(startWorker({ hostUrl: host.url, token: wa.worker.token, secrets: { anthropic: FAKE_KEY } }));
  workers.push(startWorker({ hostUrl: host.url, token: wb.worker.token }));
  await waitFor(async () => (await alice.get(`${R}/state`)).agents.every((a) => a.available), { what: 'all agents available' });

  // --- Phase 3/4: a shared project ---
  const { project } = await alice.post(`${R}/projects`, { name: 'Task app', goal: 'Build a simple working task management web application.', managerAgentId: pm.id });
  const P = `${R}/projects/${project.id}`;
  for (const a of [fe, ds]) assert.strictEqual((await alice.post(`${P}/grants`, { agentId: a.id, budgetUsd: 10, requiresApproval: false })).status, 200);
  // Alice cannot lend Bob's agents; Bob has to join and lend them himself.
  assert.strictEqual((await alice.post(`${P}/grants`, { agentId: be.id, budgetUsd: 10 })).status, 403);
  assert.strictEqual((await bob.post(`${P}/grants`, { agentId: be.id, budgetUsd: 10 })).status, 403, 'must join first');
  assert.strictEqual((await bob.post(`${P}/join`)).status, 200);
  for (const a of [be, qa, sec]) assert.strictEqual((await bob.post(`${P}/grants`, { agentId: a.id, budgetUsd: 10, requiresApproval: true })).status, 200);

  assert.strictEqual((await alice.post(`${P}/start`)).status, 200);

  // The manager plans for real (submit_plan), then the plan waits for Alice.
  const planApproval = await waitFor(async () => (await alice.get(`${R}/state`)).approvals.find((a) => a.kind === 'plan' && a.status === 'pending'), { what: 'plan approval' });
  assert.ok(planApproval.detail.tasks.length >= 4);
  assert.strictEqual((await bob.post(`${R}/approvals/${planApproval.id}`, { decision: 'approved' })).status, 403, 'Bob cannot approve Alice’s plan');
  assert.strictEqual((await alice.post(`${R}/approvals/${planApproval.id}`, { decision: 'approved' })).status, 200);

  // Work for Bob's agents was requested by Alice's side: Bob approves each assignment.
  const bobApprovals = await waitFor(async () => {
    const s = await bob.get(`${R}/state`);
    const mine = s.approvals.filter((a) => a.kind === 'assignment' && a.status === 'pending' && a.approverId === s.me.id);
    return mine.length >= 3 ? mine : null;
  }, { what: 'Bob’s assignment approvals' });
  for (const a of bobApprovals) {
    assert.strictEqual((await alice.post(`${R}/approvals/${a.id}`, { decision: 'approved' })).status, 403, 'Alice cannot approve work for Bob’s agents');
    assert.strictEqual((await bob.post(`${R}/approvals/${a.id}`, { decision: 'approved' })).status, 200);
  }

  const done = await waitFor(async () => {
    const s = await alice.get(P);
    return s.project.status === 'completed' ? s : null;
  }, { timeout: 120_000, what: 'project completion' });

  // Deliverables are real files, produced by the agents' tool calls.
  const files = done.files.map((f) => f.path);
  for (const f of ['openapi.json', 'server.js', 'public/index.html', 'public/app.js', 'public/style.css', 'tests/api.test.js', 'SUMMARY.md']) assert.ok(files.includes(f), `${f} produced`);
  const testReport = done.files.find((f) => f.path.startsWith('test-results/'));
  assert.ok(testReport, 'a test report was stored');
  const report = await fetch(`${host.url}${P}/files/${testReport.path}`, { headers: { Cookie: '' } });
  assert.strictEqual(report.status, 401, 'files need a signed-in member');
  const reportText = (await alice.text(`${P}/files/${testReport.path}`)).text;
  assert.match(reportText, /Exit code: 0/, 'the QA agent’s sandboxed test run passed');
  assert.ok(files.some((f) => f.startsWith('reviews/')), 'security review stored');

  // Every task is completed with evidence attached.
  for (const task of done.tasks) assert.strictEqual(task.status, 'completed', `${task.title} completed`);

  // Real cross-team conversation: Felix (Alice) asked Boris (Bob), Boris answered on the
  // same correlation id, and Boris handed the contract to Felix.
  const feAgent = await alice.get(`${R}/agents/${fe.id}`);
  const q = feAgent.messages.find((m) => m.kind === 'question' && m.toAgentId === be.id);
  assert.ok(q, 'frontend asked backend a question');
  const beAgent = await bob.get(`${R}/agents/${be.id}`);
  const a = beAgent.messages.find((m) => m.kind === 'answer' && m.correlationId === q.correlationId);
  assert.ok(a, 'backend answered with the same correlation id');
  assert.ok(a.body.includes('/api/tasks'), 'the answer carries the API contract');
  assert.ok(beAgent.messages.some((m) => m.kind === 'handoff' && m.toAgentId === fe.id), 'backend handed the contract to frontend');

  // The office floor was driven by these events (bubbles, meetings, task reactions).
  assert.ok(aliceView.events.some((e) => e.event === 'bubble'), 'speech bubbles were sent');
  assert.ok(aliceView.events.some((e) => e.event === 'meeting' && e.data.on), 'a meeting was shown while agents talked');

  // Credentials never reached the host: not in its database, not in any API response.
  const dbBytes = fs.readdirSync(path.join(host.stateDir, 'crew')).filter((f) => f.startsWith('crew.sqlite')).map((f) => fs.readFileSync(path.join(host.stateDir, 'crew', f)).toString('latin1')).join('');
  assert.ok(!dbBytes.includes('FAKE-SECRET'), 'no API key in the host database');
  assert.ok(!JSON.stringify(await bob.get(`${R}/state`)).includes('FAKE-SECRET'));

  // Costs were tracked per agent and per task.
  const st = await alice.get(`${R}/state`);
  assert.ok(st.agents.find((x) => x.id === pm.id).tokensIn > 0, 'token usage recorded');

  // --- Reconnect: the host restarts, both players come back, nothing is lost ---
  alice.leaveAll(); bob.leaveAll();
  for (const w of workers) w.stop();
  await host.stop();
  host = await startHost({ stateDir: host.stateDir, port: host.port });
  const alice2 = player(host.url);
  assert.strictEqual((await alice2.post('/api/crew/login', { username: 'alice', password: 'alice-pass-1' })).status, 200);
  const again = await alice2.get(P);
  assert.strictEqual(again.project.status, 'completed');
  assert.strictEqual(again.files.length, done.files.length);
  assert.match(again.project.summary, /Completed \d+ of \d+ tasks/);
});

