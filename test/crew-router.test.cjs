// Backup AIs, the token saver and the free-only connection. Providers are stand-ins answering with
// the errors the real ones document; everything on this side of them is the real worker.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startHost, player, startWorker, waitFor } = require('./lib/crew-harness.cjs');
const { nextProvider, reportedLimit, mayBeBackup, resetForTests } = require('../lib/crew-worker/router.cjs');
const { compactResult, compactHistory, compactText } = require('../lib/crew-worker/token-saver.cjs');
const { createProvider } = require('../lib/crew-worker/providers.cjs');
const { createBudget } = require('../lib/crew-worker/budget.cjs');
const { createQuota } = require('../lib/crew-worker/quota.cjs');
const { setQuotaSink } = require('../lib/crew-worker/cli-providers.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-r-'));
const vaultWith = (creds) => ({ get: () => creds, getSecret: () => null, set: () => {} });

test('routing stays inside what the owner listed, and cannot loop', () => {
  resetForTests();
  const budget = createBudget(tmp());
  assert.strictEqual(mayBeBackup('openai'), false, 'a paid API is never a backup');
  assert.strictEqual(mayBeBackup('anthropic'), false);
  assert.strictEqual(mayBeBackup('claude-handoff'), false, 'nor is what needs a person');
  assert.strictEqual(mayBeBackup('chatgpt-plan'), true);

  const alone = { provider: 'chatgpt-plan', fallbacks: [] };
  const triedAlone = new Set();
  assert.strictEqual(nextProvider(alone, triedAlone, budget), 'chatgpt-plan');
  triedAlone.add('chatgpt-plan');
  assert.strictEqual(nextProvider(alone, triedAlone, budget), null, 'with no backups, a limit is the end of the road');

  // A stale list naming a paid API, from before any check, still cannot reach it.
  const stale = { provider: 'chatgpt-plan', fallbacks: ['openai', 'anthropic', 'claude-handoff', 'local'] };
  const tried = new Set(['chatgpt-plan']);
  assert.strictEqual(nextProvider(stale, tried, budget), 'local');
  tried.add('local');
  assert.strictEqual(nextProvider(stale, tried, budget), null, 'each once, and then it stops');

  reportedLimit('chatgpt-plan');
  assert.strictEqual(nextProvider(stale, new Set(), budget), 'local', 'no request is spent on an AI that just said stop');
  assert.strictEqual(nextProvider(alone, new Set(), budget), 'chatgpt-plan', 'unless it is the only one: its answer is the pause');
  resetForTests();
});

test('a limit moves the task to the owner’s backup, once, and never to a paid API', { timeout: 60_000 }, async (t) => {
  resetForTests();
  let plan = 0;
  const stand = http.createServer((req, res) => {
    plan++;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached.' } }));
  });
  await new Promise((r) => stand.listen(0, '127.0.0.1', r));
  const host = await startHost();
  const ana = player(host.url);
  let worker = null;
  const was = process.env.CREW_OPENAI_API_BASE;
  process.env.CREW_OPENAI_API_BASE = `http://127.0.0.1:${stand.address().port}/v1`;
  t.after(async () => { ana.leaveAll(); worker?.stop(); await host.stop(); stand.close(); if (was === undefined) delete process.env.CREW_OPENAI_API_BASE; else process.env.CREW_OPENAI_API_BASE = was; resetForTests(); });

  await ana.post('/api/crew/register', { username: 'ana', password: 'ana-pass-12', displayName: 'Ana' });
  const { room } = await ana.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  const R = `/api/crew/rooms/${room.id}`;
  await ana.enter(room.id);
  const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'exec'];
  const lead = (await ana.post(`${R}/agents`, { name: 'Paige', role: 'Project Manager', provider: 'scripted', model: 'scripted', tools: TOOLS })).agent;
  const dev = (await ana.post(`${R}/agents`, { name: 'Bea', role: 'Backend Developer', provider: 'chatgpt-plan', model: 'default', tools: TOOLS })).agent;

  const P = `${R}/agents/${dev.id}/profile`;
  assert.strictEqual((await ana.req('PUT', P, { fallbacks: ['openai'] })).status, 400, 'the host refuses a paid backup');
  assert.strictEqual((await ana.req('PUT', P, { fallbacks: ['anthropic'] })).status, 400);
  assert.strictEqual((await ana.req('PUT', P, { fallbacks: ['claude-handoff'] })).status, 400);
  assert.strictEqual((await ana.req('PUT', P, { fallbacks: ['scripted'] })).status, 200);

  const dir = tmp();
  const { createVault } = require('../lib/crew-worker/vault.cjs');
  const vault = createVault(dir);
  vault.setSecret('chatgptPlan', { accessToken: 'stand-in', refreshToken: 'x', expiresAt: Date.now() + 3_600_000, scopes: 'offline_access resource.invoke chatgpt.tokens.use.direct' });
  const { worker: w } = await ana.post(`${R}/workers`, { name: 'PC' });
  worker = startWorker({ hostUrl: host.url, token: w.token, dir });
  await waitFor(async () => (await ana.get(`${R}/state`)).agents.every((a) => a.available), { what: 'agents available' });

  const graph = { nodes: [{ id: 'l', type: 'lead', config: { agentId: lead.id } }, { id: 'w', type: 'worker', config: { agentId: dev.id } }, { id: 't', type: 'task', config: { title: 'Build the backend' } }], edges: [{ from: 'w', to: 't' }] };
  const { playbook } = await ana.post(`${R}/playbooks`, { name: 'Go', graph, policy: { approvals: false, requireReview: false } });
  const { run } = await ana.post(`${R}/playbooks/${playbook.id}/run`, { goal: 'Build it.' });
  const done = await waitFor(async () => { const x = (await ana.get(`${R}/runs/${run.id}`)).run; return x.tasks.t.status === 'completed' ? x : null; }, { timeout: 40_000, what: 'the task to finish on the backup' });
  assert.ok(done.deliverables.some((d) => d.path === 'server.js'), 'the backup really did the work');
  assert.ok(plan >= 1 && plan <= 2, `the limited AI was asked once for this job, not hammered (asked ${plan} times)`);

  const { jobs } = await ana.get(`${R}/agents/${dev.id}`);
  const job = jobs.find((j) => j.type === 'task');
  const { logs } = await ana.get(`${R}/jobs/${job.id}/logs`);
  assert.ok(logs.some((l) => /Moving to Scripted/.test(l.text) && /as this agent’s owner allowed/.test(l.text)), 'and the move is on the record');
});

test('the safe defaults: paid API off, saver on, and the free connection not treated as paid', () => {
  resetForTests();
  const budget = createBudget(tmp());
  assert.strictEqual(budget.status().tokenSaver, true, 'saver on by default');
  assert.strictEqual(budget.status().neverPaidApi, true, 'paid API off by default');
  assert.deepStrictEqual(budget.billingBlock('openrouter-free'), null, 'the free connection is not a paid one');
  assert.ok(budget.billingBlock('openai'), 'and paid ones stay blocked');
});

test('the token saver leaves a trail, keeps errors, and never touches a file just read', () => {
  const long = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 'FAIL tests/api.test.js: expected 200' : `line ${i}`)).join('\n');
  const out = compactText(long);
  assert.ok(out.length < long.length / 3, 'it does get shorter');
  assert.match(out, /FAIL tests\/api\.test\.js/, 'the one line that matters survives from the middle');
  assert.match(out, /line 0\b/);
  assert.match(out, /line 999\b/);
  assert.match(out, /lines left out to save tokens/, 'and it says so');

  assert.strictEqual(compactText('\x1b[32mok\x1b[0m'), 'ok');
  assert.match(compactText(Array(50).fill('same').join('\n')), /same {2}\[repeated 50 times\]/);
  assert.strictEqual(compactText('a\na\nb'), 'a\na\nb', 'two in a row costs less than the note');

  const file = { content: long };
  assert.deepStrictEqual(compactResult('read_file', file), { result: file, saved: 0 }, 'a file may be about to be edited');
  const cmd = compactResult('run_command', { stdout: long, exitCode: 1 });
  assert.ok(cmd.saved > 0);
  assert.strictEqual(cmd.result.exitCode, 1);

  const transcript = [{ role: 'user', text: 'go' }];
  for (let i = 0; i < 10; i++) transcript.push({ role: 'assistant', text: '', toolCalls: [] }, { role: 'tool', results: [{ id: `c${i}`, name: 'read_file', content: 'x'.repeat(5000) }] });
  const before = JSON.stringify(transcript);
  const history = compactHistory(transcript);
  assert.strictEqual(JSON.stringify(transcript), before, 'the saved transcript keeps everything');
  const tools = history.transcript.filter((e) => e.role === 'tool');
  assert.match(tools[0].results[0].content, /Older result shortened/);
  assert.strictEqual(tools.at(-1).results[0].content.length, 5000, 'recent results are whole');
  assert.ok(history.saved > 0);
});

test('the free connection cannot spend, and its quota is OpenRouter’s own figure', { timeout: 20_000 }, async (t) => {
  const seen = [];
  let limited = false;
  const stand = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/key') return res.end(JSON.stringify({ data: { free_model_daily_requests: { used: 30, limit: 50 } } }));
      if (limited) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Free model limit reached.' } })); }
      return res.end(JSON.stringify({ model: 'x:free', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => stand.listen(0, '127.0.0.1', r));
  process.env.CREW_OPENROUTER_BASE = `http://127.0.0.1:${stand.address().port}/api/v1`;
  const dir = tmp();
  const quota = createQuota(dir);
  setQuotaSink((p, r) => quota.record(p, r));
  t.after(() => { stand.close(); delete process.env.CREW_OPENROUTER_BASE; setQuotaSink(() => {}); });

  const budget = createBudget(dir);
  const ad = createProvider('openrouter-free', vaultWith({ apiKey: 'sk-or-stand-in' }), budget);
  const call = (model) => ad.complete({ system: 's', transcript: [{ role: 'user', text: 'hi' }], tools: [], model });

  await assert.rejects(call('anthropic/claude-opus'), /not a free model/, 'a paid model is refused before anything is sent');
  await assert.rejects(call('openai/gpt-5'), /not a free model/);
  assert.strictEqual(seen.length, 0);

  const r = await call('openrouter/free');
  assert.strictEqual(r.text, 'ok');
  const sent = seen.find((s) => s.url.endsWith('/chat/completions'));
  assert.deepStrictEqual(sent.body.provider.max_price, { prompt: 0, completion: 0 }, 'a price cap of zero goes with it');
  assert.ok(!sent.body.models, 'and no list of other models it could fall through to');

  await waitFor(() => quota.read('openrouter-free'), { timeout: 3000, what: 'the quota reading' });
  const reading = quota.read('openrouter-free');
  assert.strictEqual(reading.windows['free requests today'].usedPercent, 60, '30 of 50 is what OpenRouter said');
  assert.strictEqual(reading.source, 'Reported by OpenRouter');

  limited = true;
  await assert.rejects(call('x/y:free'), (e) => e.limit === true, 'its limit is treated as a limit, so it can pause or move on');
  assert.ok(!JSON.stringify(quota.all()).includes('sk-or-stand-in'), 'the key is not in any usage record');
});
