// Playbooks, agent settings and provider-reported usage, against a real host, real workers and
// the scripted provider: fixed scripts rather than AI, with everything below the model real.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startHost, player, startWorker, waitFor } = require('./lib/crew-harness.cjs');
const { createQuota, fromCodexEvent, fromClaudeEvent } = require('../lib/crew-worker/quota.cjs');
const { createBudget } = require('../lib/crew-worker/budget.cjs');

const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec'];

async function office(t) {
  const host = await startHost();
  const ana = player(host.url);
  const ben = player(host.url);
  const workers = [];
  t.after(async () => { ana.leaveAll(); ben.leaveAll(); for (const w of workers) w.stop(); await host.stop(); });
  await ana.post('/api/crew/register', { username: 'ana', password: 'ana-pass-12', displayName: 'Ana' });
  await ben.post('/api/crew/register', { username: 'ben', password: 'ben-pass-12', displayName: 'Ben' });
  const { room } = await ana.post('/api/crew/rooms', { name: 'Studio', privacy: 'lan', maxPlayers: 4 });
  await ben.post('/api/crew/rooms/join', { code: room.code });
  const R = `/api/crew/rooms/${room.id}`;
  await ana.enter(room.id);
  await ben.enter(room.id);
  const mk = async (p, name, role) => (await p.post(`${R}/agents`, { name, role, skills: [role.toLowerCase()], provider: 'scripted', model: 'scripted', tools: TOOLS, budgetUsd: 5 })).agent;
  const startFor = async (p, name) => {
    const { worker } = await p.post(`${R}/workers`, { name });
    workers.push(startWorker({ hostUrl: host.url, token: worker.token }));
  };
  return { host, ana, ben, R, room, mk, startFor };
}

const graphOf = ({ lead, dev, reviewer }) => ({
  nodes: [
    { id: 'l', type: 'lead', x: 0, y: 0, config: { agentId: lead } },
    { id: 'w', type: 'worker', x: 0, y: 100, config: { agentId: dev } },
    { id: 't', type: 'task', x: 200, y: 100, config: { title: 'Build the backend', description: 'Build it.' } },
    { id: 'r', type: 'worker', x: 200, y: 0, config: { agentId: reviewer } },
    { id: 'v', type: 'review', x: 400, y: 100, config: { title: 'Security review' } },
    { id: 'a', type: 'approval', x: 600, y: 100, config: { title: 'Sign it off' } },
    { id: 'c', type: 'completion', x: 800, y: 100, config: {} },
  ],
  edges: [{ from: 'w', to: 't' }, { from: 't', to: 'v' }, { from: 'r', to: 'v' }, { from: 'v', to: 'a' }, { from: 'a', to: 'c' }],
});

test('a playbook run: real tasks in order, a person signs off, and it ends with the real result', { timeout: 120_000 }, async (t) => {
  const o = await office(t);
  const lead = await o.mk(o.ana, 'Paige', 'Project Manager');
  const dev = await o.mk(o.ana, 'Bea', 'Backend Developer');
  const reviewer = await o.mk(o.ana, 'Rita', 'Security Reviewer');
  await o.startFor(o.ana, 'PC');
  await waitFor(async () => (await o.ana.get(`${o.R}/state`)).agents.every((a) => a.available), { what: 'agents available' });

  const { playbook } = await o.ana.post(`${o.R}/playbooks`, { name: 'Ship it', graph: graphOf({ lead: lead.id, dev: dev.id, reviewer: reviewer.id }) });
  assert.strictEqual((await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, {})).status, 400, 'a run needs a goal');
  const { run } = await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Build a task API.' });
  assert.strictEqual(run.tasks.t.assignedAgentName ?? 'Bea', 'Bea');
  assert.deepStrictEqual(run.tasks.v.deps, [run.tasks.t.id], 'the review waits for the build');

  const get = async () => (await o.ana.get(`${o.R}/runs/${run.id}`)).run;
  const waiting = await waitFor(async () => { const r = await get(); return r.tasks.a.status === 'awaiting_approval' ? r : null; }, { timeout: 90_000, what: 'the approval step' });
  assert.strictEqual(waiting.tasks.t.status, 'completed');
  assert.strictEqual(waiting.tasks.v.status, 'completed');
  assert.strictEqual(waiting.tasks.c.status, 'pending', 'nothing after the approval has moved');
  assert.ok(waiting.deliverables.some((d) => d.path === 'server.js'), 'the files are the ones the agent really wrote');

  const { approvals } = await o.ana.get(`${o.R}/state`);
  const gate = approvals.find((a) => a.kind === 'gate' && a.status === 'pending');
  assert.ok(gate, 'the approval reached the person who started the run');
  assert.strictEqual((await o.ben.post(`${o.R}/approvals/${gate.id}`, { decision: 'approved' })).status, 403, 'and only them');
  await o.ana.post(`${o.R}/approvals/${gate.id}`, { decision: 'approved' });

  const done = await waitFor(async () => { const r = await get(); return r.status === 'completed' ? r : null; }, { timeout: 60_000, what: 'the run to finish' });
  assert.strictEqual(done.tasks.c.status, 'completed');
  assert.ok(done.summary, 'the lead wrote the final summary');
  assert.ok(done.tokens > 0, 'usage is what the worker reported');
});

test('a condition skips the branch it should, and running it again is the same playbook', { timeout: 120_000 }, async (t) => {
  const o = await office(t);
  const dev = await o.mk(o.ana, 'Bea', 'Backend Developer');
  await o.startFor(o.ana, 'PC');
  await waitFor(async () => (await o.ana.get(`${o.R}/state`)).agents.every((a) => a.available), { what: 'agents available' });
  const graph = {
    nodes: [
      { id: 'w', type: 'worker', config: { agentId: dev.id } },
      { id: 't', type: 'task', config: { title: 'First attempt' } },
      { id: 'f', type: 'condition', config: { when: 'any_failed', title: 'Did it fail?' } },
      { id: 'b', type: 'task', config: { title: 'Rescue', agentId: dev.id } },
    ],
    edges: [{ from: 'w', to: 't' }, { from: 't', to: 'f' }, { from: 'f', to: 'b' }],
  };
  const { playbook } = await o.ana.post(`${o.R}/playbooks`, { name: 'Rescue', graph, policy: { approvals: false, requireReview: false } });
  const { run } = await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Try.' });
  const r = await waitFor(async () => { const x = (await o.ana.get(`${o.R}/runs/${run.id}`)).run; return x.tasks.f.status === 'cancelled' ? x : null; }, { timeout: 90_000, what: 'the condition to skip' });
  assert.strictEqual(r.tasks.t.status, 'completed', 'nothing failed');
  assert.match(r.tasks.f.resultSummary, /skipped/);
  await waitFor(async () => (await o.ana.get(`${o.R}/runs/${run.id}`)).run.tasks.b.status === 'blocked', { what: 'the rescue to stay off' });

  // Cancel the first attempt of a second run: this time the rescue is needed.
  const { run: second } = await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Try again.' });
  await o.ana.post(`${o.R}/tasks/${second.tasks.t.id}/cancel`);
  const passed = await waitFor(async () => { const x = (await o.ana.get(`${o.R}/runs/${second.id}`)).run; return x.tasks.f.status === 'completed' ? x : null; }, { what: 'the condition to pass' });
  assert.notStrictEqual(passed.tasks.b.status, 'blocked');
});

test('what cannot run says why, and another player’s agent waits for its owner to lend it', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const mine = await o.mk(o.ana, 'Paige', 'Project Manager');
  const theirs = await o.mk(o.ben, 'Bo', 'Backend Developer');
  const loop = { nodes: [{ id: 'a', type: 'task', config: {} }, { id: 'b', type: 'task', config: {} }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
  const bad = await o.ana.post(`${o.R}/playbooks`, { name: 'Loop', graph: loop });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.error, /loop/);

  const { playbook: empty } = await o.ana.post(`${o.R}/playbooks`, { templateId: 'build-review' });
  const refused = await o.ana.post(`${o.R}/playbooks/${empty.id}/run`, { goal: 'x' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.error, /Choose an agent/);

  assert.strictEqual((await o.ben.post(`${o.R}/playbooks/${empty.id}/run`, { goal: 'x' })).status, 400);
  assert.strictEqual((await player(o.host.url).get(`${o.R}/playbooks`)).status, 401);

  const graph = { nodes: [{ id: 'l', type: 'lead', config: { agentId: mine.id } }, { id: 'w', type: 'worker', config: { agentId: theirs.id } }, { id: 't', type: 'task', config: { title: 'Their part' } }], edges: [{ from: 'w', to: 't' }] };
  const { playbook } = await o.ana.post(`${o.R}/playbooks`, { name: 'Together', graph });
  const { run } = await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Work together.' });
  assert.strictEqual(run.agents.w.granted, false, 'starting a run cannot lend somebody else’s agent');
  assert.strictEqual(run.tasks.t.assignedAgentId, null);
  const benState = await o.ben.get(`${o.R}/state`);
  assert.ok(benState.notifications.some((n) => /wants Bo/.test(n.text)), 'its owner is asked');

  await o.ben.post(`${o.R}/projects/${run.projectId}/grants`, { agentId: theirs.id, budgetUsd: 2, requiresApproval: false, tools: TOOLS });
  await waitFor(async () => (await o.ana.get(`${o.R}/runs/${run.id}`)).run.tasks.t.assignedAgentId === theirs.id, { what: 'the work to go to the lent agent' });
});

test('agent settings persist, stay private, reach the agent, and are enforced', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const lead = await o.mk(o.ana, 'Paige', 'Project Manager');
  const other = await o.mk(o.ana, 'Ola', 'Writer');
  const P = `${o.R}/agents/${lead.id}/profile`;
  const saved = await o.ana.req('PUT', P, { definitionOfDone: 'All tests pass and the README says how to run it.', planning: 'List your steps first.', orchestrationRole: 'reviewer', delegationTargets: [lead.id] });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual((await o.ana.get(P)).profile.definitionOfDone, 'All tests pass and the README says how to run it.', 'it is there when reopened');
  assert.strictEqual((await o.ben.get(P)).status, 403, 'and it is the owner’s alone');
  assert.strictEqual((await o.ana.req('PUT', P, { orchestrationRole: 'emperor' })).status, 400);
  assert.strictEqual((await o.ana.req('PUT', P, { delegationTargets: ['agt_nonexistent'] })).status, 400);

  const rules = await o.ana.req('PUT', `${o.R}/rules/agent/${lead.id}`, { rules: { progressReports: true } });
  assert.strictEqual(rules.status, 200);
  assert.strictEqual((await o.ana.get(P)).rules.progressReports.value, true);

  // Be a worker for one claim, and read what this agent would actually be told.
  const { worker } = await o.ana.post(`${o.R}/workers`, { name: 'Raw' });
  const { project } = await o.ana.post(`${o.R}/projects`, { name: 'P', goal: 'G', managerAgentId: lead.id });
  await o.ana.post(`${o.R}/projects/${project.id}/grants`, { agentId: other.id, budgetUsd: 1, requiresApproval: false, tools: TOOLS });
  await o.ana.post(`${o.R}/projects/${project.id}/start`);
  const claim = await (await fetch(`${o.host.url}/api/crew/worker/claim`, { method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.match(claim.context.agent.instructions, /Definition of Done:\nAll tests pass/, 'it is in the agent’s standing instructions');
  assert.match(claim.context.agent.instructions, /Before you start:\nList your steps/);
});

test('an agent cannot delegate to anyone its owner has ruled out', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const lead = await o.mk(o.ana, 'Paige', 'Project Manager');
  const allowed = await o.mk(o.ana, 'Ada', 'Writer');
  const barred = await o.mk(o.ana, 'Zed', 'Writer');
  await o.ana.req('PUT', `${o.R}/agents/${lead.id}/profile`, { delegationTargets: [allowed.id] });
  const { worker } = await o.ana.post(`${o.R}/workers`, { name: 'Raw' });
  // A playbook gives the lead an ordinary work task straight away, which is where delegating happens.
  const graph = {
    nodes: [{ id: 'l', type: 'lead', config: { agentId: lead.id } }, { id: 'a', type: 'worker', config: { agentId: allowed.id } }, { id: 'z', type: 'worker', config: { agentId: barred.id } }, { id: 't', type: 'task', config: { title: 'Lead this', agentId: lead.id } }],
    edges: [],
  };
  const { playbook } = await o.ana.post(`${o.R}/playbooks`, { name: 'Lead', graph, policy: { approvals: false, requireReview: false } });
  await o.ana.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Get it written.' });
  const call = (p, body) => fetch(`${o.host.url}/api/crew/worker/${p}`, { method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const claim = await waitFor(async () => { const c = await call('claim', {}); return c.job ? c : null; }, { what: 'a job for the lead' });
  assert.ok(claim.context.tools.includes('delegate_task'), 'the lead may delegate at all');
  const tool = (agent, title = 'Write it') => call('tool', { jobId: claim.job.id, name: 'delegate_task', args: { title, description: 'Please write it.', agent } });
  const refused = await tool('Zed');
  assert.match(JSON.stringify(refused), /does not let you delegate to Zed/);
  const accepted = await tool('Ada');
  assert.doesNotMatch(JSON.stringify(accepted), /does not let you|error/i, 'the one it may use still works');
  const { tasks } = await o.ana.get(`${o.R}/state`);
  assert.ok(tasks.some((x) => x.title === 'Write it' && x.assignedAgentId === allowed.id), 'and the work really went to them');
  // With nobody named, the office picks, and only among those allowed.
  await tool(undefined, 'Writer task');
  assert.ok((await o.ana.get(`${o.R}/state`)).tasks.some((x) => x.title === 'Writer task' && x.assignedAgentId === allowed.id));
  assert.ok(!tasks.some((x) => x.assignedAgentId === barred.id), 'and none went to the one ruled out');
});

test('the worker finds an official tool, or says plainly that it is missing', { timeout: 30_000 }, async () => {
  const { findTool } = require('../lib/crew-worker/setup.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cli-'));
  const write = (name, body) => {
    const win = process.platform === 'win32';
    const f = path.join(dir, win ? `${name}.cmd` : name);
    fs.writeFileSync(f, win ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  };
  const was = process.env.CREW_CODEX_CLI;
  try {
    process.env.CREW_CODEX_CLI = path.join(dir, 'no-such-tool');
    assert.strictEqual((await findTool('codex')).installed, false);
    process.env.CREW_CODEX_CLI = write('stub', process.platform === 'win32' ? 'if "%1"=="--version" (echo stub 1.2.3) else (echo Not logged in & exit /b 1)' : 'if [ "$1" = "--version" ]; then echo stub 1.2.3; else echo Not logged in; exit 1; fi');
    const out = await findTool('codex');
    assert.strictEqual(out.installed, true);
    assert.match(out.version, /1\.2\.3/);
    assert.strictEqual(out.signedIn, false, 'the tool’s own answer');
    assert.ok(!JSON.stringify(out).includes('Not logged in'), 'nothing the tool prints about the account is kept');
  } finally {
    if (was === undefined) delete process.env.CREW_CODEX_CLI; else process.env.CREW_CODEX_CLI = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage percentages come only from what the provider reported', () => {
  const codex = fromCodexEvent({ payload: { rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 4102444800 }, secondary: { used_percent: 12.5, window_minutes: 10080, resets_at: 4102444800 } } } });
  assert.deepStrictEqual(Object.keys(codex.windows), ['session', 'weekly']);
  assert.strictEqual(codex.windows.session.usedPercent, 42);
  const claude = fromClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: '2100-01-01T00:00:00Z' } } } });
  assert.strictEqual(Math.round(claude.windows.session.usedPercent), 80);
  // What does not parse is dropped, never turned into a number.
  assert.strictEqual(fromCodexEvent({ usage: { input_tokens: 500000 } }), null, 'tokens are not an allowance');
  assert.strictEqual(fromCodexEvent({ rate_limits: { primary: { used_percent: 'lots', window_minutes: 300 } } }), null);
  assert.strictEqual(fromCodexEvent({ rate_limits: { primary: { used_percent: 400, window_minutes: 300 } } }), null);
  assert.strictEqual(fromClaudeEvent({ type: 'other' }), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-q-'));
  let at = Date.parse('2099-01-01T00:00:00Z');
  const warnings = [];
  const quota = createQuota(dir, { now: () => at, onWarning: (w) => warnings.push(w) });
  assert.strictEqual(quota.read('codex-cli'), null, 'no reading means unavailable, not zero');
  assert.strictEqual(quota.atOrOver('codex-cli', 50), null);
  quota.record('codex-cli', codex);
  assert.deepStrictEqual(warnings, [], '42% has crossed nothing');
  quota.record('codex-cli', { ...codex, windows: { session: { usedPercent: 80, resetsAt: codex.windows.session.resetsAt } } });
  assert.deepStrictEqual(warnings.map((w) => w.percent), [75], 'the highest line crossed, once');
  quota.record('codex-cli', { ...codex, windows: { session: { usedPercent: 81, resetsAt: codex.windows.session.resetsAt } } });
  assert.strictEqual(warnings.length, 1, 'and it does not repeat');

  const budget = createBudget(dir, { now: () => at });
  budget.useQuota(quota);
  budget.update({ provider: { name: 'codex-cli', pauseAtPercent: 75 } });
  assert.deepStrictEqual(budget.blockedProviders(['codex-cli', 'chatgpt-plan']), ['codex-cli'], 'the owner’s line holds against a real reading, and only there');
  at += 7 * 3600_000;
  assert.deepStrictEqual(budget.blockedProviders(['codex-cli']), [], 'an old reading stops anything no longer');
  assert.strictEqual(quota.read('codex-cli').stale, true, 'and says it is old');
  fs.rmSync(dir, { recursive: true, force: true });
});

function raw(port, { method = 'GET', path: p = '/status', host = '127.0.0.1', origin, body, crew = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Host: `${host}:${port}`, ...(origin ? { Origin: origin } : {}), ...(crew ? { 'X-Crew': '1' } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('only this computer’s own app can reach the worker; a remote office page never can', { timeout: 40_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-w-'));
  const port = 8800 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'crew-worker.cjs')], { env: { ...process.env, CREW_WORKER_DIR: dir, CREW_WORKER_PORT: String(port) }, stdio: 'ignore' });
  t.after(() => { child.kill(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 500); });
  await waitFor(async () => { try { return (await raw(port)).status === 200; } catch { return false; } }, { what: 'the worker page' });

  const friend = await raw(port, { origin: 'http://192.168.1.20:8080' });
  assert.strictEqual(friend.status, 403, 'a friend’s office page cannot read this');
  const turnOff = await raw(port, { method: 'POST', path: '/settings', origin: 'http://192.168.1.20:8080', body: { neverPaidApi: false } });
  assert.strictEqual(turnOff.status, 403, 'and above all cannot turn off “Never use paid API”');
  assert.strictEqual((await raw(port, { host: 'evil.example.com' })).status, 403, 'nor can a rebound hostname');
  assert.strictEqual((await raw(port, { method: 'POST', path: '/settings', crew: false, body: { neverPaidApi: false } })).status, 403);
  assert.strictEqual(JSON.parse((await raw(port)).body).budget.neverPaidApi, true, 'still on');

  const app = await raw(port, { origin: 'http://localhost:8080' });
  assert.strictEqual(app.status, 200);
  assert.strictEqual(app.headers['access-control-allow-origin'], 'http://localhost:8080');

  const { cards, neverPaidApi } = JSON.parse((await raw(port, { path: '/setup/connections' })).body);
  assert.strictEqual(neverPaidApi, true);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.strictEqual(by['chatgpt-plan'].status, 'signin', 'not signed in, and it says so');
  assert.strictEqual(by.openai.status, 'unavailable', 'paid stays off');
  assert.ok(!by.openai.canTest, 'and cannot even be tested while off');
  assert.strictEqual(by['openrouter-free'].canTest, false, 'nothing to test without a key');
  assert.ok(by['claude-handoff'].notice.includes('Anthropic'), 'Anthropic’s restriction is stated');
  assert.deepStrictEqual([...new Set(cards.map((c) => c.group))], ['subscription', 'local', 'free', 'paid']);

  const usage = JSON.parse((await raw(port, { path: '/usage' })).body);
  assert.deepStrictEqual(usage.reported, {}, 'no invented figures');
});
