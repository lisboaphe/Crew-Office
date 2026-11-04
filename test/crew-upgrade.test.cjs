// Conflicts, rollback, contract dependencies, budgets, billing protection, provider states,
// handoff, resumable uploads. Each maps to an acceptance item in the upgrade prompt; see
// docs/developer/upgrade-report.md.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { makeCrew, present, workerFor, room, agent } = require('./lib/crew-unit.cjs');
const { startHost, player, startWorker, waitFor } = require('./lib/crew-harness.cjs');
const { compare } = require('../lib/crew/contracts.cjs');
const { createBudget } = require('../lib/crew-worker/budget.cjs');
const { createVault } = require('../lib/crew-worker/vault.cjs');
const { createProvider } = require('../lib/crew-worker/providers.cjs');
const { createProviderStatus } = require('../lib/crew-worker/provider-status.cjs');
const { subscriptionEnv } = require('../lib/crew-worker/cli-providers.cjs');
const { createChatgptPlan } = require('../lib/crew-worker/chatgpt-plan.cjs');
const { runJob } = require('../lib/crew-worker/runner.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'git'];

/** A commit on a branch of a hosted bare repo, put there the way the host would see it. */
function branchWith(crew, repo, branch, file, text) {
  const dir = tmp('crew-br-');
  const bare = crew.git.gitDir(repo);
  execFileSync('git', ['clone', '--quiet', bare, dir]);
  execFileSync('git', ['config', 'user.email', 'a@x'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir });
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `edit ${file}\n\nCrew-Tests: passed`], { cwd: dir });
  execFileSync('git', ['--git-dir', bare, 'fetch', '--quiet', dir, `HEAD:refs/heads/${branch}`]);
  return dir;
}

function gitOffice(t) {
  const { crew, close } = makeCrew();
  t.after(close);
  const r = room(crew);
  const a = agent(crew, r.room.id, r.alice.id, 'Paige', 'PM', { isManager: true, tools: TOOLS });
  const p = crew.work.createProject(r.room.id, r.alice.id, { name: 'Web', goal: 'g', managerAgentId: a.id });
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
  const repo = crew.git.get(crew.git.create(r.room.id, r.alice.id, p.id, { name: 'web' }).id);
  return { crew, ...r, a, p, repo };
}

test('a conflicting merge stops, reports the files, leaves main alone and sends the work back', (t) => {
  const { crew, room: rm, alice, a, p, repo } = gitOffice(t);
  crew.policies.set(rm.id, alice.id, 'project', p.id, { approvalMode: 'autonomous', requireReview: false });
  branchWith(crew, repo, 'agent/paige/one', 'README.md', 'one\n');
  branchWith(crew, repo, 'agent/paige/two', 'README.md', 'two\n');
  assert.strictEqual(crew.git.merge(repo, 'agent/paige/one', { by: {}, message: 'm1' }).merged, true);
  const mainAfterFirst = crew.git.branchHead(repo, 'main');

  const task = crew.work.createTask(crew.work.getProject(p.id), { title: 'Second edit', assignedAgentId: a.id, by: { type: 'human', id: alice.id } });
  const out = crew.reviews.request({ agent: crew.agents.get(a.id), task: crew.work.getTask(task.id), project: crew.work.getProject(p.id) }, { repo: 'web', branch: 'agent/paige/two', summary: 'Second edit of the readme, tests passed.' });
  assert.strictEqual(out.status, 'conflict');
  assert.strictEqual(crew.git.branchHead(repo, 'main'), mainAfterFirst, 'main did not move');
  const after = crew.work.getTask(task.id);
  assert.strictEqual(after.status, 'pending', 'the task went back to its author');
  assert.match(after.result_summary, /conflicts in: README\.md/);
  assert.match(crew.git.readFile(repo, 'agent/paige/two', 'README.md'), /two/, 'the branch is untouched');
});

test('snapshots and rollback make a new commit; history is kept', (t) => {
  const { crew, alice, repo } = gitOffice(t);
  const snap = crew.git.snapshot(repo, 'before', alice.id);
  branchWith(crew, repo, 'agent/paige/x', 'x.txt', 'x');
  crew.git.merge(repo, 'agent/paige/x', { by: {}, message: 'm' });
  assert.ok(crew.git.readFile(repo, 'main', 'x.txt'));
  crew.git.rollback(repo, snap.tag, alice.id);
  assert.strictEqual(crew.git.readFile(repo, 'main', 'x.txt'), null, 'content rolled back');
  assert.ok(crew.git.log(repo, 'main', 50).some((c) => c.subject === 'm'), 'the merged commit is still in history');
});

test('contract check: removed endpoints are breaking, additions are not', () => {
  const spec = (paths, req = []) => JSON.stringify({ info: { version: '1' }, paths, components: { schemas: { Task: { required: req } } } });
  const base = spec({ '/a': { get: {} }, '/b': { post: {} } });
  assert.strictEqual(compare(base, spec({ '/a': { get: {} }, '/b': { post: {} }, '/c': { get: {} } })).breaking, false);
  const removed = compare(base, spec({ '/a': { get: {} } }));
  assert.strictEqual(removed.breaking, true);
  assert.deepStrictEqual(removed.removed, ['POST /b']);
  assert.strictEqual(compare(base, spec({ '/a': { get: {} }, '/b': { post: {} } }, ['title'])).breaking, true, 'a newly required field is breaking');
  assert.strictEqual(compare('plain text', 'other text').breaking, null, 'unknown formats are not guessed at');
});

test('a contract change notifies only the dependent project, with a task for its agents', (t) => {
  const { crew, room: rm, alice, bob, a, repo } = gitOffice(t);
  branchWith(crew, repo, 'agent/paige/spec', 'openapi.json', JSON.stringify({ info: { version: '1' }, paths: { '/tasks': { get: {} }, '/old': { get: {} } } }));
  crew.git.merge(repo, 'agent/paige/spec', { by: {}, message: 'first spec' });

  const appDev = agent(crew, rm.id, bob.id, 'Dana', 'Integration Developer', { tools: TOOLS, isManager: true });
  const app = crew.work.createProject(rm.id, bob.id, { name: 'App', goal: 'g', managerAgentId: appDev.id });
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", app.id);
  const unrelatedAgent = agent(crew, rm.id, bob.id, 'Una', 'Writer', { tools: TOOLS });
  const unrelated = crew.work.createProject(rm.id, bob.id, { name: 'Docs', goal: 'g', managerAgentId: unrelatedAgent.id });
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", unrelated.id);
  assert.throws(() => crew.contracts.link(rm.id, alice.id, { dependentProjectId: app.id, providerRepoId: repo.id, contractPath: 'openapi.json' }), /creator/, 'only the dependent project’s creator links it');
  crew.contracts.link(rm.id, bob.id, { dependentProjectId: app.id, providerRepoId: repo.id, contractPath: 'openapi.json' });

  // A change elsewhere in the repository does not disturb the dependent project.
  branchWith(crew, repo, 'agent/paige/other', 'notes.txt', 'n');
  crew.git.merge(repo, 'agent/paige/other', { by: {}, message: 'other' });
  assert.strictEqual(crew.work.listTasks(app.id).length, 0);

  branchWith(crew, repo, 'agent/paige/spec2', 'openapi.json', JSON.stringify({ info: { version: '2' }, paths: { '/tasks': { get: {} } } }));
  crew.git.merge(repo, 'agent/paige/spec2', { by: {}, message: 'second spec' });
  const tasks = crew.work.listTasks(app.id);
  assert.strictEqual(tasks.length, 1, 'one adaptation task');
  assert.match(tasks[0].title, /^Adapt to web contract/);
  assert.match(tasks[0].description, /BREAKING/);
  assert.match(tasks[0].description, /GET \/old/);
  assert.strictEqual(tasks[0].assignedAgentId, appDev.id);
  assert.strictEqual(crew.work.listTasks(unrelated.id).length, 0, 'unrelated projects hear nothing');
  assert.ok(crew.work.notificationsFor(rm.id, bob.id).some((n) => /Contract update/.test(n.text)));
  assert.ok(!crew.work.notificationsFor(rm.id, alice.id).some((n) => /Contract update/.test(n.text)), 'the provider’s team is not spammed');
  void a;
});

test('paid API is off by default, on the owner’s machine, in the one path every call takes', async () => {
  const dir = tmp('crew-bill-');
  const vault = createVault(dir);
  vault.set('anthropic', 'apiKey', 'sk-ant-test');
  const budget = createBudget(dir);
  assert.strictEqual(budget.status().neverPaidApi, true);
  assert.throws(() => createProvider('anthropic', vault, budget), /Paid API usage is off/);
  assert.throws(() => createProvider('openai', vault, budget), /Paid API usage is off/);
  assert.deepStrictEqual(budget.blockedProviders(['anthropic', 'openai', 'scripted', 'local', 'chatgpt-plan']), ['anthropic', 'openai'], 'paid providers are not even claimed');
  const status = createProviderStatus({ vault, budget });
  assert.strictEqual(status.state('anthropic').state, 'Requires User Action');
  const t = await status.test('anthropic');
  assert.strictEqual(t.ok, false);
  assert.match(t.reason, /Paid API usage is off/, 'Test Connection does not spend either');
  budget.update({ neverPaidApi: false });
  assert.ok(createProvider('anthropic', vault, budget), 'only the owner’s explicit choice opens it');
  // The choice survives a restart, and so does the default for a fresh worker.
  assert.strictEqual(createBudget(dir).status().neverPaidApi, false);
  assert.strictEqual(createBudget(tmp('crew-bill2-')).status().neverPaidApi, true);
});

test('a key in the environment cannot silently switch a subscription CLI to API billing', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-shell';
  process.env.OPENAI_API_KEY = 'sk-shell';
  process.env.ANTHROPIC_AUTH_TOKEN = 'x';
  const env = subscriptionEnv();
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(env.OPENAI_API_KEY, undefined);
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
});

test('automated Claude Code stays off and is reported honestly until the owner opts in', () => {
  const dir = tmp('crew-claude-');
  const vault = createVault(dir);
  const budget = createBudget(dir);
  assert.throws(() => createProvider('claude-cli', vault, budget), /Automated Claude Code is off/);
  const status = createProviderStatus({ vault, budget });
  assert.strictEqual(status.state('claude-cli').state, 'Not Supported');
  assert.strictEqual(status.state('claude-handoff').state, 'Limited');
  assert.strictEqual(status.state('chatgpt-plan').state, 'Requires User Action', 'no sign-in, no green light');
  assert.strictEqual(status.state('codex-cli').state, 'Connected', 'installed-or-unknown is not Working');
});

test('budgets: per-task estimate, owner reserve, concurrency, labelled as estimates', () => {
  let t = 1_000_000;
  const budget = createBudget(tmp('crew-bud-'), { now: () => t });
  budget.update({ provider: { name: 'codex-cli', capacity: 100, window: 'weekly', reservePct: 20, maxConcurrent: 2 } });

  // A 25% task may make about 25 requests, then it pauses.
  const r = budget.open('codex-cli', 'task-a', 25);
  assert.strictEqual(r.ok, true);
  let last;
  const warned = [];
  for (let i = 0; i < 25; i++) { last = budget.charge(r, 'codex-cli', 'task-a'); warned.push(...(last.warn ?? [])); t += 1; }
  assert.strictEqual(last.stop, true, 'stops at the estimate');
  assert.match(last.pause.reason, /Estimated, not a provider limit/);
  assert.deepStrictEqual(warned, [50, 75, 90], 'warned at 50, 75 and 90 percent');
  budget.close(r);

  // Starting it again is refused until the owner raises it; raising it lets it continue.
  const again = budget.open('codex-cli', 'task-a', 25);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.pause.kind, 'budget');
  const raised = budget.open('codex-cli', 'task-a', 40);
  assert.strictEqual(raised.ok, true, 'carries its earlier usage');
  budget.close(raised);

  // Two concurrent tasks cannot spend the same remainder: the second is warned and capped.
  const first = budget.open('codex-cli', 'task-b', 40);          // 80 usable − 25 used = 55 free; holds 40
  assert.strictEqual(first.ok, true);
  const second = budget.open('codex-cli', 'task-c', 40);         // only 15 left
  assert.strictEqual(second.ok, true);
  assert.ok(second.cap <= 15.0001, `capped to what is free, got ${second.cap}`);
  assert.match(second.warning, /may pause early rather than oversubscribe/);
  assert.deepStrictEqual(budget.blockedProviders(['codex-cli']), ['codex-cli'], 'max simultaneous jobs reached');
  budget.close(first); budget.close(second);

  // The status never invents a balance.
  const st = budget.status().providers['codex-cli'];
  assert.match(st.remainingAllowance, /unavailable/);
  assert.match(st.measured, /measured/);
});

test('budgets: the owner’s reserve holds, and capacity returns when the window rolls over', () => {
  let t = 5_000_000;
  const budget = createBudget(tmp('crew-bud2-'), { now: () => t });
  budget.update({ provider: { name: 'local', capacity: 10, window: 'session5h', reservePct: 50 } });
  const r = budget.open('local', 'x', null);
  for (let i = 0; i < 5; i++) { budget.charge(r, 'local', 'x'); t += 1; }
  budget.close(r);
  const none = budget.open('local', 'y', null);
  assert.strictEqual(none.ok, false, 'half is kept for the owner');
  assert.ok(none.pause.resumeAfter > t, 'it says when capacity returns');
  assert.deepStrictEqual(budget.blockedProviders(['local']), ['local']);
  t += 5 * 3600_000 + 10;
  assert.deepStrictEqual(budget.blockedProviders(['local']), [], 'window rolled over');
});

/** A job context and a stub host, enough to drive the runner for real. */
function runnerRig(provider) {
  const calls = [];
  const host = {
    base: 'http://x', token: 't',
    post: async (p, b) => {
      calls.push({ p, b });
      if (p.endsWith('/usage')) return { stop: false };
      if (p.endsWith('/tool')) return { ok: true, result: {} };
      if (p.endsWith('/authorize')) return { allowed: true };
      return {};
    },
  };
  const ctx = {
    job: { id: 'job_1', type: 'task', depth: 0 }, agent: { id: 'agt_1', name: 'A', role: 'Dev', skills: [], instructions: '', provider, model: 'default' },
    room: { name: 'R' }, tools: ['report_progress', 'complete_task'], task: { id: 'tsk_1', kind: 'work', title: 'T', description: 'd', budgetPct: 2 }, resume: null,
  };
  return { host, ctx, calls };
}

test('hitting a limit pauses and checkpoints; no retry, no fallback to anything paid', async () => {
  // A stand-in OpenAI: signed-in account, usage limit mid-stream, as the docs describe.
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })}\n\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CREW_OPENAI_API_BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = tmp('crew-lim-');
    const vault = createVault(dir);
    vault.setSecret('chatgptPlan', { accessToken: 'tok', expiresAt: Date.now() + 3600_000, scopes: 'chatgpt.tokens.use.direct', clientId: 'c' });
    vault.set('openai', 'apiKey', 'sk-should-never-be-used');
    const budget = createBudget(dir);
    const { host, ctx, calls } = runnerRig('chatgpt-plan');
    ctx.agent.model = 'gpt-x';
    await runJob({ ctx, host, vault, budget, localTools: {}, dataDir: dir });
    const fin = calls.find((c) => c.p.endsWith('/finish'));
    assert.strictEqual(fin.b.status, 'waiting');
    assert.strictEqual(fin.b.result.pause.kind, 'provider_limit');
    assert.match(fin.b.result.pause.reason, /ChatGPT Settings → Usage/);
    assert.strictEqual(requests, 1, 'exactly one request: no retry around the limit');
    assert.ok(fs.existsSync(path.join(dir, 'checkpoints', 'job_1.json')), 'work so far is checkpointed');
  } finally {
    server.close();
    delete process.env.CREW_OPENAI_API_BASE;
  }
});

test('a per-task estimate pauses a real job at its limit with the transcript saved', async () => {
  const dir = tmp('crew-pause-');
  const vault = createVault(dir);
  const budget = createBudget(dir);
  budget.update({ provider: { name: 'scripted', capacity: 50, reservePct: 0 } });
  const { host, ctx, calls } = runnerRig('scripted');
  ctx.project = { name: 'P', goal: 'g', team: [] };
  ctx.tools = ['write_file', 'complete_task', 'report_progress'];
  await runJob({ ctx, host, vault, budget, localTools: {}, dataDir: dir });
  const fin = calls.find((c) => c.p.endsWith('/finish'));
  assert.strictEqual(fin.b.status, 'waiting', JSON.stringify(fin.b));
  assert.strictEqual(fin.b.result.pause.kind, 'budget');
  assert.ok(fs.existsSync(path.join(dir, 'checkpoints', 'job_1.json')));
  const models = calls.filter((c) => c.p.endsWith('/usage')).length;
  assert.strictEqual(models, 1, 'one request was 2% of the 50-request estimate');
});

test('ChatGPT sign-in follows the documented request: PKCE, loopback, dynamic client, plan scope', async () => {
  // Plumbing only, against a stand-in. This does NOT show the real OpenAI service accepts it.
  let tokenBody = null;
  const auth = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      tokenBody = new URLSearchParams(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }));
    });
  });
  await new Promise((r) => auth.listen(0, '127.0.0.1', r));
  process.env.CREW_OPENAI_AUTH_BASE = `http://127.0.0.1:${auth.address().port}`;
  process.env.CREW_CHATGPT_PORT = String(14550 + Math.floor(Math.random() * 400));
  try {
    const vault = createVault(tmp('crew-siwc-'));
    delete require.cache[require.resolve('../lib/crew-worker/chatgpt-plan.cjs')];
    const plan = require('../lib/crew-worker/chatgpt-plan.cjs').createChatgptPlan(vault);
    const { url, done } = plan.startLogin();
    const q = new URL(url).searchParams;
    assert.strictEqual(q.get('client_id'), 'dynamic_agent_client');
    assert.strictEqual(q.get('code_challenge_method'), 'S256');
    assert.strictEqual(q.get('resource'), 'https://api.openai.com/v1');
    assert.ok(q.get('scope').includes('chatgpt.tokens.use.direct') && q.get('scope').includes('offline_access'));
    assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/, 'loopback 127.0.0.1, not localhost');
    assert.match(q.get('ext_agent_host_id'), /^urn:uuid:/);
    assert.ok(q.get('agent_name_hint'));
    const redirect = q.get('redirect_uri');
    const bad = await fetch(`${redirect}?code=c&state=wrong`);
    assert.match(await bad.text(), /did not match/, 'a forged callback is refused');
    await done.catch(() => {});
    const second = plan.startLogin();
    const q2 = new URL(second.url).searchParams;
    const ok = await fetch(`${redirect}?code=thecode&state=${q2.get('state')}&client_id=oaiapp_123&scope=x`);
    assert.match(await ok.text(), /Signed in/);
    await second.done;
    assert.strictEqual(tokenBody.get('client_id'), 'oaiapp_123', 'the issued client, not the registration entrypoint');
    assert.strictEqual(tokenBody.get('grant_type'), 'authorization_code');
    assert.ok(tokenBody.get('code_verifier'));
    assert.deepStrictEqual(plan.status().signedIn, true);
    assert.strictEqual(createChatgptPlan(vault).status().planScope, true, 'stored encrypted, survives a reload');
  } finally {
    auth.close();
    delete process.env.CREW_OPENAI_AUTH_BASE;
    delete process.env.CREW_CHATGPT_PORT;
  }
});

test('Claude manual handoff: no model call, a real brief, and Done imports the result', async () => {
  const dir = tmp('crew-hand-');
  const vault = createVault(dir);
  const budget = createBudget(dir);
  const { host, ctx, calls } = runnerRig('claude-handoff');
  ctx.project = { name: 'P', goal: 'g', team: [] };
  ctx.tools = ['complete_task'];
  process.env.CREW_CLAUDE_CLI = path.join(dir, 'must-not-be-run');
  await runJob({ ctx, host, vault, budget, localTools: {}, dataDir: dir });
  delete process.env.CREW_CLAUDE_CLI;
  const fin = calls.find((c) => c.p.endsWith('/finish'));
  assert.strictEqual(fin.b.status, 'waiting');
  assert.strictEqual(fin.b.result.pause.kind, 'handoff');
  assert.strictEqual(calls.filter((c) => c.p.endsWith('/usage')).length, 0, 'the app made no model call');
  const folder = path.join(dir, 'handoffs', 'job_1');
  assert.match(fs.readFileSync(path.join(folder, 'HANDOFF.md'), 'utf8'), /own Claude Code/);

  // Done without a result: it asks again rather than inventing completion.
  calls.length = 0;
  ctx.resume = { kind: 'handoff' };
  await runJob({ ctx, host, vault, budget, localTools: {}, dataDir: dir });
  assert.match(calls.find((c) => c.p.endsWith('/finish')).b.result.pause.reason, /RESULT\.md was not found/);

  fs.writeFileSync(path.join(folder, 'RESULT.md'), 'Did the thing by hand and tested it.');
  calls.length = 0;
  await runJob({ ctx, host, vault, budget, localTools: {}, dataDir: dir });
  const tool = calls.find((c) => c.p.endsWith('/tool'));
  assert.strictEqual(tool.b.name, 'complete_task');
  assert.strictEqual(calls.find((c) => c.p.endsWith('/finish')).b.status, 'done');
});

test('uploads: only missing data travels, chunks resume, corruption and bad hashes never publish', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  const bob = player(host.url);
  t.after(async () => { alice.leaveAll(); bob.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  await bob.post('/api/crew/register', { username: 'bob', password: 'bob-pass-12', displayName: 'Bob' });
  const { room: rm } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  await bob.post('/api/crew/rooms/join', { code: rm.code });
  const R = `/api/crew/rooms/${rm.id}`;
  const a = (await alice.post(`${R}/agents`, { name: 'P', role: 'PM', provider: 'scripted', model: 'scripted' })).agent;
  const { project } = await alice.post(`${R}/projects`, { name: 'P', goal: 'g', managerAgentId: a.id });
  const U = `${R}/projects/${project.id}`;

  const data = crypto.randomBytes(2_500_000);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const begun = await alice.post(`${U}/uploads`, { path: 'release/app.zip', size: data.length, sha256: sha });
  assert.strictEqual(begun.done, false);
  assert.strictEqual(begun.chunks, 3);
  const put = (i, bytes, headers = {}) => alice.raw('PUT', `${U}/uploads/${begun.uploadId}/chunks/${i}`, bytes, headers);
  const slice = (i) => data.subarray(i * begun.chunkSize, (i + 1) * begun.chunkSize);

  assert.strictEqual((await put(0, slice(0))).status, 200);
  // The connection drops here. Finalising now is refused and says what is missing.
  const early = await alice.post(`${U}/uploads/${begun.uploadId}/finalize`);
  assert.strictEqual(early.status, 409);
  assert.strictEqual((await alice.get(`${U}/blobs`)).files.length, 0, 'nothing published early');
  // After reconnecting, the host says what it has, and only the rest is sent.
  assert.deepStrictEqual((await alice.get(`${U}/uploads/${begun.uploadId}`)).received, [0]);
  // Bob cannot continue or read Alice's upload.
  await bob.post(`${U}/join`);
  assert.strictEqual((await bob.get(`${U}/uploads/${begun.uploadId}`)).status, 403);
  // A corrupted chunk is caught on arrival.
  const wrong = await put(1, Buffer.alloc(slice(1).length, 1), { 'X-Chunk-Sha256': crypto.createHash('sha256').update(slice(1)).digest('hex') });
  assert.strictEqual(wrong.status, 422);
  assert.strictEqual((await put(1, slice(1))).status, 200);
  assert.strictEqual((await put(2, slice(2))).status, 200);
  const fin = await alice.post(`${U}/uploads/${begun.uploadId}/finalize`);
  assert.strictEqual(fin.file.version, 1);
  assert.strictEqual(fin.file.sha256, sha);

  // Download is byte-identical, an attachment, never rendered.
  const res = await alice.rawGet(`${U}/blobs/${fin.file.id}`);
  assert.strictEqual(crypto.createHash('sha256').update(res.body).digest('hex'), sha);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');

  // Publishing the same bytes again sends nothing and makes version 2.
  const dup = await alice.post(`${U}/uploads`, { path: 'release/app.zip', size: data.length, sha256: sha });
  assert.strictEqual(dup.done, true);
  assert.strictEqual(dup.file.version, 2);

  // A file that does not match its declared hash is never published.
  const other = Buffer.from('hello');
  const liar = await alice.post(`${U}/uploads`, { path: 'bad.bin', size: other.length, sha256: 'a'.repeat(64) });
  await alice.raw('PUT', `${U}/uploads/${liar.uploadId}/chunks/0`, other);
  assert.strictEqual((await alice.post(`${U}/uploads/${liar.uploadId}/finalize`)).status, 422);
  assert.ok(!(await alice.get(`${U}/blobs`)).files.some((f) => f.path === 'bad.bin'));

  // Traversal is refused.
  assert.strictEqual((await alice.post(`${U}/uploads`, { path: '../../evil', size: 1, sha256: 'b'.repeat(64) })).status, 400);
  // Someone not on the project cannot publish.
  const carol = player(host.url);
  await carol.post('/api/crew/register', { username: 'carol', password: 'carol-pass', displayName: 'C' });
  await carol.post('/api/crew/rooms/join', { code: rm.code });
  assert.strictEqual((await carol.post(`${U}/uploads`, { path: 'x', size: 1, sha256: 'c'.repeat(64) })).status, 403);

  // Host backups exist, and say what they leave out.
  const backup = await alice.post(`${R}/backups`);
  assert.ok(backup.file && fs.existsSync(backup.file));
  assert.strictEqual((await bob.post(`${R}/backups`)).status, 403);
});

test('a worker with paid API off leaves such jobs queued, and the room sees why', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  t.after(async () => { alice.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  const { room: rm } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  const R = `/api/crew/rooms/${rm.id}`;
  await alice.enter(rm.id);
  const a = (await alice.post(`${R}/agents`, { name: 'Pat', role: 'PM', provider: 'anthropic', model: 'claude-sonnet-5-5', isManager: true })).agent;
  const { worker } = await alice.post(`${R}/workers`, { name: 'PC' });
  const dir = tmp('crew-q-');
  const vault = createVault(dir);
  vault.set('anthropic', 'apiKey', 'sk-ant-api03-not-a-real-key-000000');
  const w = startWorker({ hostUrl: host.url, token: worker.token, dir });
  t.after(() => w.stop());
  await waitFor(async () => (await alice.get(`${R}/state`)).agents[0].available, { what: 'available' });
  const { project } = await alice.post(`${R}/projects`, { name: 'P', goal: 'g', managerAgentId: a.id });
  await alice.post(`${R}/projects/${project.id}/start`);
  await new Promise((r) => setTimeout(r, 2500));
  const s = await alice.get(`${R}/projects/${project.id}`);
  assert.strictEqual(s.tasks[0].status, 'queued', 'the job waits; nothing was sent to Anthropic');
  const d = await alice.get(`${R}/agents/${a.id}`);
  assert.strictEqual(d.agent.tokensIn, 0);
});

test('the browser’s fallback SHA-256 matches the host’s, for the plain-HTTP LAN pages that need it', async () => {
  const { sha256Fallback } = await import('../crew/workspace.js');
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
    const bytes = crypto.randomBytes(size);
    assert.strictEqual(sha256Fallback(new Uint8Array(bytes)), crypto.createHash('sha256').update(bytes).digest('hex'), `size ${size}`);
  }
});

void present; void workerFor;
