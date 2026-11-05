// Things going wrong: workers vanishing, leases expiring, owners walking away, budgets
// running out, clients reconnecting, loops between agents, crashes — and the sandbox
// holding when code tries to leave it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeCrew, present, workerFor, room, agent, sleep } = require('./lib/crew-unit.cjs');
const sandbox = require('../lib/crew-worker/sandbox.cjs');
const { createCrashLog, redact } = require('../lib/crew/crash.cjs');

function oneTask(crew, r, owner, a) {
  const p = crew.work.createProject(r.id, owner.id, { name: 'P', goal: 'g', managerAgentId: a.id });
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
  const t = crew.work.addTask(r.id, owner.id, p.id, { title: 'Do it', agentId: a.id });
  crew.work.schedule();
  return { p, t };
}

test('enqueue is idempotent', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev');
  const j1 = crew.jobs.enqueue({ roomId: r.id, agentId: a.id, type: 'chat', idemKey: 'same' });
  const j2 = crew.jobs.enqueue({ roomId: r.id, agentId: a.id, type: 'chat', idemKey: 'same' });
  assert.strictEqual(j1.id, j2.id);
});

test('a worker that disappears gives its job back without costing an attempt', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev', { isManager: true });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  const { t: task } = oneTask(crew, r, alice, a);
  const job = crew.jobs.claim(wk);
  assert.strictEqual(crew.work.getTask(task.id).status, 'in_progress');
  crew.jobs.releaseWorker(wk.id);
  const back = crew.jobs.get(job.id);
  assert.strictEqual(back.status, 'queued');
  assert.strictEqual(back.attempts, 0);
  assert.strictEqual(crew.work.getTask(task.id).status, 'queued');
});

test('an expired lease is a failed attempt; the task retries, then fails, and dependents block', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev', { isManager: true });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  const { p, t: task } = oneTask(crew, r, alice, a);
  const dep = crew.work.addTask(r.id, alice.id, p.id, { title: 'After', agentId: a.id, deps: [task.id] });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const job = crew.jobs.claim(wk);
    assert.ok(job, `attempt ${attempt} handed out`);
    crew.db.run('UPDATE jobs SET lease_until = 1 WHERE id = ?', job.id);
    crew.jobs.sweep();
    crew.work.schedule();
  }
  assert.strictEqual(crew.work.getTask(task.id).status, 'failed');
  crew.work.schedule();
  assert.strictEqual(crew.work.getTask(dep.id).status, 'blocked');
  assert.ok(crew.work.notificationsFor(r.id, alice.id).some((n) => /failed/.test(n.text)), 'the creator was told');
});

// Found by release runs failing at random: a timer left behind by a finished job reached a closed
// database and became an uncaught exception, in whichever test happened to be running by then.
test('closing the office cancels what was still waiting to run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { crew, close } = makeCrew();
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev', { isManager: true });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  oneTask(crew, r, alice, a);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const job = crew.jobs.claim(wk);
    assert.ok(job, `attempt ${attempt} handed out`);
    crew.db.run('UPDATE jobs SET lease_until = 1 WHERE id = ?', job.id);
    crew.jobs.sweep();
    crew.work.schedule();
  }
  let recorded = 0;
  const record = crew.crash.record;
  crew.crash.record = (...args) => { recorded++; return record(...args); };
  crew.work.kick();
  close();
  crew.work.kick();
  assert.doesNotThrow(() => t.mock.timers.tick(60_000), 'the agent\u2019s status reset no longer fires');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(recorded, 0, 'and the scheduler did not run against a closed database');
});

test('attended workers follow their owner; always-on workers do not', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev');
  const b = agent(crew, r.id, bob.id, 'B', 'Dev');
  const pa = present(crew, r.id, alice.id);
  const pb = present(crew, r.id, bob.id);
  workerFor(crew, r.id, alice.id).auth();
  workerFor(crew, r.id, bob.id, { alwaysOn: true }).auth();
  assert.ok(crew.agents.available(crew.agents.get(a.id)));
  assert.ok(crew.agents.available(crew.agents.get(b.id)));
  pa.leave();
  pb.leave();
  await sleep(80); // past the reload grace
  assert.strictEqual(crew.agents.available(crew.agents.get(a.id)), false, 'Alice left: her attended worker stops serving');
  assert.strictEqual(crew.agents.get(a.id).status, 'OFFLINE');
  assert.strictEqual(crew.agents.available(crew.agents.get(b.id)), true, 'Bob’s always-on worker keeps his agent available');
});

test('a paused agent gets no work; resuming hands it out again', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev', { isManager: true });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  oneTask(crew, r, alice, a);
  crew.agents.setPaused(a.id, alice.id, true);
  assert.strictEqual(crew.jobs.claim(wk), null);
  crew.agents.setPaused(a.id, alice.id, false);
  assert.ok(crew.jobs.claim(wk));
});

test('budgets: usage past the limit tells the worker to stop and blocks the agent', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev', { isManager: true, budgetUsd: 1 });
  present(crew, r.id, alice.id);
  const wk = workerFor(crew, r.id, alice.id).auth();
  oneTask(crew, r, alice, a);
  const job = crew.jobs.claim(wk);
  assert.strictEqual(crew.hostTools.usage(wk, { jobId: job.id, tokensIn: 10, tokensOut: 10, usd: 0.2, model: 'x' }).stop, false);
  assert.strictEqual(crew.hostTools.usage(wk, { jobId: job.id, tokensIn: 10, tokensOut: 10, usd: 0.9, model: 'x' }).stop, true);
  crew.jobs.finish(crew.jobs.get(job.id), { status: 'failed', error: 'budget' });
  assert.strictEqual(crew.agents.get(a.id).status, 'BLOCKED');
});

test('loop guards: rate, per-pair cap, and verbatim repeats', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const a = crew.agents.get(agent(crew, r.id, alice.id, 'A', 'Dev').id);
  const b = crew.agents.get(agent(crew, r.id, alice.id, 'B', 'Dev').id);
  const ch = crew.bus.ensureChannel(r.id, 'agent-updates', 'public');
  const say = (from, to, body) => { crew.bus.guardAgentSend(from, { toAgentId: to.id, taskId: 'task1', body }); crew.bus.post({ roomId: r.id, channelId: ch.id, senderType: 'agent', senderId: from.id, toAgentId: to.id, body, taskId: 'task1' }); };
  say(a, b, 'same words');
  say(a, b, 'same words');
  assert.throws(() => say(a, b, 'same words'), /Loop detected/);
  for (let i = 0; i < 8; i++) say(i % 2 ? a : b, i % 2 ? b : a, `turn ${i}`); // 2 + 8 = the cap of 10
  assert.throws(() => say(b, a, 'one more'), /Conversation limit/);
});

test('reconnecting clients are replayed what they missed, or told to resync', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const first = present(crew, r.id, alice.id);
  assert.ok(first.frames.some((f) => f.startsWith('event: resync')), 'a fresh client gets the snapshot cue');
  const seq = crew.hub.broadcast(r.id, 'test', { n: 1 });
  crew.hub.broadcast(r.id, 'test', { n: 2 });
  first.leave();
  const again = present(crew, r.id, alice.id, { 'last-event-id': String(seq) });
  const replayed = again.frames.filter((f) => f.includes('event: test'));
  assert.strictEqual(replayed.length, 1);
  assert.match(replayed[0], /"n":2/);
});

test('direct messages are private to their player', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const a = agent(crew, r.id, alice.id, 'A', 'Dev');
  const dm = crew.bus.dmChannel(r.id, alice.id, a.id);
  crew.bus.post({ roomId: r.id, channelId: dm.id, senderType: 'human', senderId: alice.id, body: 'private' });
  assert.ok(!crew.bus.channelsFor(r.id, bob.id).some((c) => c.id === dm.id));
  assert.throws(() => crew.bus.history(r.id, bob.id, dm.id), /No such channel/);
  assert.ok(!crew.bus.search(r.id, bob.id, 'private').length);
});

test('sandbox: only node, no shell syntax, no escape, no child processes, no inherited secrets', async () => {
  assert.throws(() => sandbox.parseCommand('rm -rf /'), /Only `node/);
  assert.throws(() => sandbox.parseCommand('node a.js; curl evil'), /not allowed/);
  assert.throws(() => sandbox.parseCommand('node --allow-fs-read=* a.js'), /sets its own/);
  const outside = await sandbox.run(`node -e "require('fs').readFileSync('${path.join(__dirname, '..', 'package.json').replace(/\\/g, '/')}')"`, {});
  assert.notStrictEqual(outside.exitCode, 0, 'reading outside the copy is refused');
  const spawn = await sandbox.run(`node -e "require('child_process').execSync('node -v')"`, {});
  assert.notStrictEqual(spawn.exitCode, 0, 'starting processes is refused');
  process.env.CREW_TEST_SECRET = 'sk-ant-should-not-leak';
  const env = await sandbox.run('node -e "console.log(JSON.stringify(process.env))"', {});
  assert.ok(!env.output.includes('should-not-leak'));
  const inside = await sandbox.run('node --test t.test.js', { 't.test.js': "require('node:test')('ok', () => {})" });
  assert.strictEqual(inside.exitCode, 0, inside.output);
});

test('crash logs are written, pruned, and scrubbed of credentials', () => {
  const { crew, dataDir, close } = makeCrew();
  close();
  const log = createCrashLog({ dir: path.join(dataDir, 'logs-test'), component: 'host' });
  log.remember('message', { body: 'Bearer abcdefghijklmnop1234' });
  const file = log.write('crash', 'test', new Error('boom with sk-ant-api03-abcdefghijklmnop'), { token: 'wk_secretsecretsecret', password: 'hunter2' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /boom with \[redacted\]/);
  assert.ok(!/abcdefghijklmnop|secretsecret|hunter2/.test(text));
  assert.deepStrictEqual(redact({ nested: { apiKey: 'x' } }), { nested: { apiKey: '[redacted]' } });
  void crew;
});
