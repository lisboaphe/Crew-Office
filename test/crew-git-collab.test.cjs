// Acceptance tests for the Git collaboration loop, against a real host process, real Git
// over smart HTTP, and in-process workers on separate data directories (two "PCs").
// Agents use the scripted provider, so this runs offline: every layer below the model — tool
// calls, clones, commits, pushes, the host's diff, review, rework, merges — is the real path.
// It says nothing about subscription connectors; those need real sign-ins (see
// docs/developer/upgrade-report.md).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { startHost, player, startWorker, waitFor } = require('./lib/crew-harness.cjs');

const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'git'];

async function office(t, { approval = 'balanced', rules = {} } = {}) {
  const host = await startHost();
  const alice = player(host.url);
  const bob = player(host.url);
  const workers = [];
  t.after(async () => { alice.leaveAll(); bob.leaveAll(); for (const w of workers) w.stop(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  await bob.post('/api/crew/register', { username: 'bob', password: 'bob-pass-12', displayName: 'Bob' });
  const { room } = await alice.post('/api/crew/rooms', { name: 'Studio', privacy: 'password', password: 'office-pw', maxPlayers: 4 });
  await bob.post('/api/crew/rooms/join', { code: room.code, password: 'office-pw' });
  const R = `/api/crew/rooms/${room.id}`;
  await alice.enter(room.id);
  await bob.enter(room.id);
  const mk = async (p, name, role, skills, extra = {}) => (await p.post(`${R}/agents`, { name, role, skills, provider: 'scripted', model: 'scripted', tools: TOOLS, budgetUsd: 50, ...extra })).agent;
  const pm = await mk(alice, 'Paige', 'Project Manager', ['planning'], { isManager: true });
  const reviewer = await mk(alice, 'Rita', 'Code Reviewer', ['review']);
  const dev = await mk(bob, 'Boris', 'Python Scripter', ['scripting']);
  const qa = await mk(bob, 'Quinn', 'QA Engineer', ['testing']);
  const wa = await alice.post(`${R}/workers`, { name: 'PC A' });
  const wb = await bob.post(`${R}/workers`, { name: 'PC B' });
  const pcA = startWorker({ hostUrl: host.url, token: wa.worker.token });
  const pcB = startWorker({ hostUrl: host.url, token: wb.worker.token });
  workers.push(pcA, pcB);
  await waitFor(async () => (await alice.get(`${R}/state`)).agents.every((a) => a.available), { what: 'agents available' });

  const { project } = await alice.post(`${R}/projects`, { name: 'Bot', goal: 'Build a small greeting bot.', managerAgentId: pm.id });
  const P = `${R}/projects/${project.id}`;
  await alice.post(`${P}/grants`, { agentId: pm.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  await alice.post(`${P}/grants`, { agentId: reviewer.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  await bob.post(`${P}/join`);
  await bob.post(`${P}/grants`, { agentId: dev.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  await bob.post(`${P}/grants`, { agentId: qa.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  const { repo } = await alice.post(`${P}/repos`, { name: 'bot' });
  assert.ok(repo?.id, 'repository created');
  await alice.req('PUT', `${R}/rules/project/${project.id}`, { rules: { approvalMode: approval, ...rules } });
  return { host, alice, bob, room, R, P, project, repo, pm, reviewer, dev, qa, pcA, pcB };
}

/** Approve whatever is waiting for this player, recording it. */
async function approveAll(p, R, seen = []) {
  const s = await p.get(`${R}/state`);
  for (const a of s.approvals.filter((x) => x.status === 'pending' && x.approverId === s.me.id)) {
    const r = await p.post(`${R}/approvals/${a.id}`, { decision: 'approved' });
    if (r.status === 200) seen.push(a.kind);
  }
  return seen;
}

function gitAs(host, token, args, cwd) {
  const header = `http.${host.url}/.extraHeader=Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}`;
  return spawnSync('git', ['-c', 'credential.helper=', '-c', header, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
}

test('review loop: own branches, changes requested, rework, approval, merge, QA, Definition of Done', { timeout: 150_000 }, async (t) => {
  const o = await office(t);
  const approved = [];
  assert.strictEqual((await o.alice.post(`${o.P}/start`)).status, 200);

  const done = await waitFor(async () => {
    await approveAll(o.alice, o.R, approved);
    await approveAll(o.bob, o.R, approved);
    const s = await o.alice.get(`${o.P}/git`);
    const merged = s.merges.filter((m) => m.status === 'merged');
    return merged.length >= 2 ? s : null;
  }, { timeout: 120_000, what: 'both merge requests merged' });

  const devMr = done.merges.find((m) => m.authorName === 'Boris');
  assert.strictEqual(devMr.status, 'merged');
  assert.strictEqual(devMr.reviewerName, 'Rita', 'an independent reviewer from the other team was chosen');
  // The reviewer really asked for changes, on a file and line, then approved the rework.
  const verdicts = devMr.comments.filter((c) => c.verdict).map((c) => c.verdict);
  assert.deepStrictEqual(verdicts, ['request_changes', 'approve']);
  const inline = devMr.comments.find((c) => c.file === 'src/bot.js');
  assert.ok(inline?.line, 'the review comment names a file and line');
  assert.ok(approved.includes('merge'), 'Balanced mode asked a human before merging into main');

  // main holds the reworked code, proven by cloning it with an ordinary Git client.
  const repo = done.repos[0];
  const token = (await o.alice.post(`${o.R}/git-tokens`, { label: 'test' })).token;
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-clone-'));
  const c = gitAs(o.host, token, ['clone', '--quiet', `${o.host.url}${repo.url}`, clone]);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(fs.readFileSync(path.join(clone, 'src/bot.js'), 'utf8'), /TypeError/, 'the reviewed fix reached main');
  assert.ok(fs.existsSync(path.join(clone, 'tests/integration.test.js')), 'QA’s tests reached main');

  // The code on main actually works.
  const run = spawnSync(process.execPath, ['--test', 'src/bot.test.js', 'tests/integration.test.js'], { cwd: clone, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stdout);

  // Provenance: pushes record agent, task and test result.
  const push = repo.events.find((e) => e.kind === 'push' && e.agentId === o.dev.id);
  assert.ok(push, 'a push event names the agent');
  assert.strictEqual(push.tests, 'passed');
  assert.ok(push.taskId && push.files.length, 'task and files recorded');

  // Tasks completed only through the merge.
  const tasks = (await o.alice.get(o.P)).tasks;
  const devTask = tasks.find((x) => x.title.startsWith('Build the greeting'));
  assert.strictEqual(devTask.status, 'completed');
  assert.match(devTask.resultSummary, /Merged into bot\/main/);
  const onA = path.join(o.pcA.dir, 'worktrees');
  assert.ok(!fs.existsSync(onA) || !fs.readdirSync(onA).includes(o.dev.id), 'Bob’s agent never had a clone on Alice’s machine');
  assert.ok(fs.readdirSync(path.join(o.pcB.dir, 'worktrees')).includes(o.dev.id), 'Bob’s agent worked in a clone on Bob’s machine');
});

test('the host refuses: pushes to main, other agents’ branches, secrets, force-pushes, strangers', { timeout: 90_000 }, async (t) => {
  const o = await office(t);
  const carol = player(o.host.url);
  await carol.post('/api/crew/register', { username: 'carol', password: 'carol-pass', displayName: 'Carol' });
  const url = `${o.host.url}${o.repo.url}`;
  const bobToken = (await o.bob.post(`${o.R}/git-tokens`, { label: 't' })).token;

  assert.notStrictEqual(spawnSync('git', ['-c', 'credential.helper=', 'ls-remote', url], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }).status, 0, 'no credentials, no access');
  assert.notStrictEqual(gitAs(o.host, 'gt_nonsense_token_value_0000000000', ['ls-remote', url]).status, 0, 'a made-up token is refused');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-push-'));
  assert.strictEqual(gitAs(o.host, bobToken, ['clone', '--quiet', url, dir]).status, 0, 'project member can clone');
  execFileSync('git', ['config', 'user.email', 'b@x'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'b'], { cwd: dir });
  const commitFile = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
    execFileSync('git', ['add', '-f', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', `add ${name}`], { cwd: dir });
  };
  commitFile('a.txt', 'hello');
  const toMain = gitAs(o.host, bobToken, ['push', 'origin', 'HEAD:refs/heads/main'], dir);
  assert.notStrictEqual(toMain.status, 0);
  assert.match(toMain.stderr, /protected/, 'main is protected');

  const others = gitAs(o.host, bobToken, ['push', 'origin', 'HEAD:refs/heads/agent/rita/x'], dir);
  assert.notStrictEqual(others.status, 0, 'Bob cannot push to Alice’s agent’s branch');
  assert.match(others.stderr, /belongs to someone else/);

  assert.strictEqual(gitAs(o.host, bobToken, ['push', 'origin', 'HEAD:refs/heads/agent/boris/x'], dir).status, 0, 'Bob can push his own agent’s branch');

  commitFile('config/.env', 'SECRET=1');
  const env = gitAs(o.host, bobToken, ['push', 'origin', 'HEAD:refs/heads/agent/boris/x'], dir);
  assert.notStrictEqual(env.status, 0);
  assert.match(env.stderr, /secrets file/);
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: dir });

  commitFile('key.txt', `const k = "sk-ant-api03-${'a'.repeat(30)}";`);
  const key = gitAs(o.host, bobToken, ['push', 'origin', 'HEAD:refs/heads/agent/boris/x'], dir);
  assert.notStrictEqual(key.status, 0);
  assert.match(key.stderr, /credential/);
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: dir });

  // Rewriting a pushed branch is refused, so nobody's history silently disappears.
  execFileSync('git', ['commit', '-q', '--amend', '-m', 'rewritten'], { cwd: dir });
  assert.notStrictEqual(gitAs(o.host, bobToken, ['push', '--force', 'origin', 'HEAD:refs/heads/agent/boris/x'], dir).status, 0, 'force-push refused');

  // A room member who is on no project, and a player from outside the room, get nothing.
  const invite = (await o.alice.post(`${o.R}/invites`, { role: 'member', uses: 1 })).invite;
  await carol.post('/api/crew/rooms/join', { invite: invite.code });
  const carolToken = (await carol.post(`${o.R}/git-tokens`, { label: 't' })).token;
  assert.notStrictEqual(gitAs(o.host, carolToken, ['ls-remote', url]).status, 0, 'not on the project: no read access');
  assert.strictEqual((await carol.get(`${o.R}/repos/${o.repo.id}/diff?branch=agent/boris/x`)).status, 403);
});

test('rules: progress reports are enforced when on, and not produced when off', { timeout: 150_000 }, async (t) => {
  const run = async (rules) => {
    const o = await office(t, { approval: 'autonomous', rules: { requireReview: false, ...rules } });
    await o.alice.post(`${o.P}/start`);
    const git = await waitFor(async () => {
      await approveAll(o.alice, o.R);
      await approveAll(o.bob, o.R);
      const s = await o.alice.get(`${o.P}/git`);
      return s.merges.filter((m) => m.status === 'merged').length >= 2 ? s : null;
    }, { timeout: 60_000, what: 'merges' });
    const token = (await o.alice.post(`${o.R}/git-tokens`, { label: 't' })).token;
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-rules-'));
    assert.strictEqual(gitAs(o.host, token, ['clone', '--quiet', `${o.host.url}${git.repos[0].url}`, clone]).status, 0);
    return { o, clone, git };
  };
  const on = await run({ progressReports: true });
  const report = fs.readFileSync(path.join(on.clone, 'docs', 'progress', `${on.o.dev.id}.md`), 'utf8');
  const devTask = (await on.o.alice.get(on.o.P)).tasks.find((x) => x.title.startsWith('Build the greeting'));
  assert.ok(report.includes(devTask.id), 'the report names its task');
  assert.ok(on.git.merges.every((m) => !m.reviewerName), 'review was off, so no reviewer');

  const off = await run({ progressReports: false });
  assert.ok(!fs.existsSync(path.join(off.clone, 'docs', 'progress')), 'turned off: no progress Markdown at all');
});

test('rules: inheritance shows its source; only the right people can change each level', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const eff = async (q) => (await o.alice.get(`${o.R}/rules?${q}`)).effective;
  assert.strictEqual((await eff(`projectId=${o.project.id}&agentId=${o.dev.id}`)).approvalMode.source, 'project');
  await o.bob.req('PUT', `${o.R}/rules/agent/${o.dev.id}`, { rules: { approvalMode: 'manual' } });
  const e = await eff(`projectId=${o.project.id}&agentId=${o.dev.id}`);
  assert.deepStrictEqual([e.approvalMode.value, e.approvalMode.source], ['manual', 'agent']);
  assert.strictEqual((await o.alice.req('PUT', `${o.R}/rules/agent/${o.dev.id}`, { rules: { approvalMode: 'autonomous' } })).status, 403, 'not Alice’s agent');
  assert.strictEqual((await o.bob.req('PUT', `${o.R}/rules/office/${o.room.id}`, { rules: { approvalMode: 'autonomous' } })).status, 403, 'members do not set office rules');
  assert.strictEqual((await o.bob.req('PUT', `${o.R}/rules/project/${o.project.id}`, { rules: { approvalMode: 'autonomous' } })).status, 403, 'not Bob’s project');
  assert.strictEqual((await o.alice.req('PUT', `${o.R}/rules/project/${o.project.id}`, { rules: { nonsense: true } })).status, 400);
  const hist = await o.alice.get(`${o.R}/rules/project/${o.project.id}/history`);
  assert.ok(hist.history.length >= 1, 'versions are kept');
  const presets = (await o.alice.get(`${o.R}/presets`)).presets;
  for (const name of ['Project Manager', 'Developer', 'Python Scripter', 'Code Reviewer', 'QA Tester', 'Researcher', 'Designer', 'Technical Writer', 'Security Reviewer']) assert.ok(presets.some((p) => p.name === name), name);
});

test('approval modes change discretionary gates only; merges in Autonomous still need a passing review', { timeout: 150_000 }, async (t) => {
  // Autonomous: reviewer approval is enough to merge, no human asked.
  const auto = await office(t, { approval: 'autonomous' });
  const seenAuto = [];
  await auto.alice.post(`${auto.P}/start`);
  await waitFor(async () => {
    const s = await auto.alice.get(`${auto.R}/state`);
    for (const a of s.approvals.filter((x) => x.status === 'pending' && x.kind === 'plan')) await auto.alice.post(`${auto.R}/approvals/${a.id}`, { decision: 'approved' });
    for (const a of s.approvals) seenAuto.push(a.kind);
    const g = await auto.alice.get(`${auto.P}/git`);
    return g.merges.filter((m) => m.status === 'merged').length >= 2;
  }, { timeout: 90_000, what: 'autonomous merges' });
  assert.ok(!seenAuto.includes('merge'), 'Autonomous: no human merge approval');
  const merged = (await auto.alice.get(`${auto.P}/git`)).merges.find((m) => m.authorName === 'Boris');
  assert.ok(merged.comments.some((c) => c.verdict === 'approve'), 'but the review still happened');

  // Manual: even pushing a branch waits for the agent's owner, then continues from where it stopped.
  const manual = await office(t, { approval: 'manual' });
  await manual.alice.post(`${manual.P}/start`);
  const kinds = [];
  await waitFor(async () => {
    for (const [p, who] of [[manual.alice, 'a'], [manual.bob, 'b']]) {
      const s = await p.get(`${manual.R}/state`);
      void who;
      for (const a of s.approvals.filter((x) => x.status === 'pending' && x.approverId === s.me.id)) {
        kinds.push(a.detail?.tool ?? a.kind);
        await p.post(`${manual.R}/approvals/${a.id}`, { decision: 'approved' });
      }
    }
    const g = await manual.alice.get(`${manual.P}/git`);
    return g.merges.filter((m) => m.status === 'merged').length >= 1;
  }, { timeout: 90_000, what: 'manual merge' });
  assert.ok(kinds.includes('repo_sync'), `Manual: pushing asked first (asked: ${kinds.join(', ')})`);
  assert.ok(kinds.includes('merge'), 'Manual: merging asked first');
});

test('a contract change reaches only the linked project, whose agent adapts on its own branch', { timeout: 120_000 }, async (t) => {
  // Website repo: when the bot's src/bot.js changes on main, the app project must adapt.
  const o = await office(t, { approval: 'autonomous' });
  const mk = async (p, name, role, skills, extra = {}) => (await p.post(`${o.R}/agents`, { name, role, skills, provider: 'scripted', model: 'scripted', tools: TOOLS, budgetUsd: 20, ...extra })).agent;
  const lead = await mk(o.bob, 'Lena', 'Lead', ['planning'], { isManager: true });
  const integrator = await mk(o.bob, 'Ivan', 'Integration Developer', ['api', 'integration']);
  const appReviewer = await mk(o.alice, 'Vera', 'Code Reviewer', ['review']);
  const { project: app } = await o.bob.post(`${o.R}/projects`, { name: 'App', goal: 'Desktop app that uses the bot.', managerAgentId: lead.id });
  const A = `${o.R}/projects/${app.id}`;
  await o.bob.post(`${A}/grants`, { agentId: lead.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  await o.bob.post(`${A}/grants`, { agentId: integrator.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  await o.alice.post(`${A}/join`);
  await o.alice.post(`${A}/grants`, { agentId: appReviewer.id, budgetUsd: 10, requiresApproval: false, tools: TOOLS });
  const appRepo = await o.bob.post(`${A}/repos`, { name: 'app' });
  await o.bob.req('PUT', `${o.R}/rules/project/${app.id}`, { rules: { approvalMode: 'autonomous' } });
  assert.strictEqual((await o.alice.post(`${o.R}/contracts`, { dependentProjectId: app.id, providerRepoId: o.repo.id, contractPath: 'src/bot.js' })).status, 403, 'only the dependent project’s creator links it');
  assert.strictEqual((await o.bob.post(`${o.R}/contracts`, { dependentProjectId: app.id, providerRepoId: o.repo.id, contractPath: 'src/bot.js' })).status, 200);
  await o.bob.req('PUT', `${o.R}/rules/project/${app.id}`, { rules: { approvalMode: 'autonomous' } });
  // The app project goes active so it can take the adaptation work.
  const startApp = await o.bob.post(`${A}/tasks`, { title: 'Set up the app', agentId: lead.id });
  assert.strictEqual(startApp.status, 200);

  await o.alice.post(`${o.P}/start`);
  const done = await waitFor(async () => {
    await approveAll(o.alice, o.R);
    await approveAll(o.bob, o.R);
    const g = await o.bob.get(`${A}/git`);
    return g.merges.find((m) => m.authorName === 'Ivan' && m.status === 'merged') ? g : null;
  }, { timeout: 100_000, what: 'the adaptation merged' });
  // The app project may have finished before the contract changed. Late work reopened it, and
  // once settled it is summarised again and completed, not left hanging.
  await waitFor(async () => (await o.bob.get(A)).project.status === 'completed', { timeout: 60_000, what: 'the app project completing again' });
  const tasks = (await o.bob.get(A)).tasks;
  const adapt = tasks.find((x) => x.title.startsWith('Adapt to bot contract'));
  assert.ok(adapt, 'the dependent project got a targeted task');
  assert.match(adapt.description, /src\/bot\.js/);
  assert.strictEqual(adapt.assignedAgentName, 'Ivan');
  const mr = done.merges.find((m) => m.authorName === 'Ivan');
  assert.match(mr.branch, /^agent\/ivan\//, 'it worked on its own branch');
  assert.strictEqual(mr.tests, 'passed');
  assert.strictEqual(mr.repoName, appRepo.repo.name);
  // The provider project was not given any task about its own contract.
  assert.ok(!(await o.alice.get(o.P)).tasks.some((x) => x.title.startsWith('Adapt to')));
});
