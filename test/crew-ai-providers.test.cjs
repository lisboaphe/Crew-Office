// The AI connections: what may run, what reaches a service, and what comes back. Requests go to a
// real HTTP server standing in for each service, so this proves what this app sends and refuses,
// not that any given service behaves as documented. test/live-ai-providers.cjs is what talks to the
// real ones, by hand, because it needs the network and sometimes the owner's key.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createConnections, DEFS } = require('../lib/crew-worker/ai-connections.cjs');
const { createBudget } = require('../lib/crew-worker/budget.cjs');
const { createVault } = require('../lib/crew-worker/vault.cjs');
const { createProvider } = require('../lib/crew-worker/providers.cjs');
const { createProviderStatus } = require('../lib/crew-worker/provider-status.cjs');
const { createQuota } = require('../lib/crew-worker/quota.cjs');
const { setQuotaSink } = require('../lib/crew-worker/cli-providers.cjs');
const { nextProvider, resetForTests } = require('../lib/crew-worker/router.cjs');
const { createUpdater } = require('../lib/crew/update.cjs');
const { PROVIDERS } = require('../lib/crew/catalog.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ai-'));
const SECRET = 'not-a-real-key-0123456789abcdef';
const ask = { system: 's', transcript: [{ role: 'user', text: 'hi' }], tools: [] };

function setup(provider, { key = true, extra = {} } = {}) {
  const dir = tmp();
  const vault = createVault(dir, { platform: 'none' });
  if (key) vault.set(provider, 'apiKey', SECRET);
  for (const [k, v] of Object.entries(extra)) vault.set(provider, k, v);
  const budget = createBudget(dir);
  const connections = createConnections(dir, { vault });
  budget.useConnections(connections);
  return { dir, vault, budget, connections };
}

async function standIn(t, provider, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      handler(req, res, seen.at(-1));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const name = `CREW_AI_BASE_${provider.replace(/-/g, '_').toUpperCase()}`;
  process.env[name] = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(() => { server.closeAllConnections(); server.close(); delete process.env[name]; });
  return seen;
}
const answer = (res, content = 'ok', extra = {}) => res.end(JSON.stringify({ model: 'm', choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));

test('every required service exists, on both sides, with no paid default', () => {
  for (const id of ['cloudflare', 'gemini', 'mistral', 'zai', 'openrouter-free', 'nvidia', 'ollama-cloud', 'kiro', 'opencode']) {
    assert.ok(DEFS[id], `${id} is defined on the worker`);
    assert.ok(PROVIDERS[id], `${id} is known to the host`);
    assert.notEqual(PROVIDERS[id].billing, 'paid');
  }
  assert.equal(createBudget(tmp()).status().neverPaidApi, true, 'paid use is off by default');
});

test('a service that cannot say whether billing is on sends nothing until its owner has checked', async (t) => {
  for (const id of ['cloudflare', 'gemini', 'mistral', 'ollama-cloud', 'nvidia']) {
    const seen = await standIn(t, id, (req, res) => answer(res));
    const { vault, budget, connections } = setup(id, id === 'cloudflare' ? { extra: { accountId: 'acct' } } : {});
    assert.ok(budget.billingBlock(id), `${id} starts blocked`);
    assert.deepEqual(budget.blockedProviders([id]), [id], `${id} claims no jobs`);
    assert.throws(() => createProvider(id, vault, budget), /verification required|trial/i);
    // Reached by another path entirely, the request still does not leave.
    const inner = createProvider(id, vault, { billingBlock: () => null, status: () => ({ neverPaidApi: true }), connections: () => connections });
    await assert.rejects(inner.complete({ ...ask, model: 'anything' }), (e) => e.signIn === true);
    assert.equal(seen.length, 0, `${id} received nothing`);

    connections.verify(id, Object.keys(DEFS[id].verify)[0]);
    const r = await createProvider(id, vault, budget).complete({ ...ask, model: 'anything' });
    assert.equal(r.text, 'ok');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, `Bearer ${SECRET}`, 'its own key, only to itself');
  }
});

test('free and paid are told apart per model, and no setting reaches a paid one by accident', async (t) => {
  const seen = await standIn(t, 'zai', (req, res) => answer(res));
  const { vault, budget, connections } = setup('zai');
  assert.equal(connections.classOf('zai', 'glm-4.7-flash'), 'free');
  assert.equal(connections.classOf('zai', 'GLM-4.5-Flash'), 'free');
  assert.equal(connections.classOf('zai', 'glm-5'), 'paid');
  const ai = createProvider('zai', vault, budget);
  await assert.rejects(ai.complete({ ...ask, model: 'glm-5' }), /paid model/);
  assert.equal(seen.length, 0, 'a paid model is refused before anything is sent');
  assert.throws(() => connections.choose('zai', 'glm-5', { neverPaid: true }), /paid model/);

  budget.update({ neverPaidApi: false });
  await assert.rejects(ai.complete({ ...ask, model: 'glm-5' }), /not allowed paid models/, 'turning off the global switch alone is not enough');
  assert.equal(seen.length, 0);
  connections.allowPaid('zai', true);
  assert.equal((await ai.complete({ ...ask, model: 'glm-5' })).text, 'ok', 'both, on purpose, and only then');

  budget.update({ neverPaidApi: true });
  await assert.rejects(ai.complete({ ...ask, model: 'glm-5' }), /paid model/, 'turning the switch back on wins');
  assert.equal((await ai.complete({ ...ask, model: 'glm-4.7-flash' })).text, 'ok');
});

test('OpenCode’s own figure decides, and a model whose cost is unknown does not run', () => {
  const { connections } = setup('opencode', { key: false });
  assert.match(connections.block('opencode', 'never-heard-of-it', { neverPaid: true }), /has not said what/);
  const rows = [{ id: 'free-one', usage: 'promo', tools: true }, { id: 'costs', usage: 'paid', tools: true }, { id: 'odd', usage: 'unknown', tools: null }];
  const c = createConnections(tmp(), { cliModels: async () => rows });
  return c.discover('opencode').then((list) => {
    const by = Object.fromEntries(list.models.map((m) => [m.id, m]));
    assert.equal(by['free-one'].blocked, null);
    assert.equal(by.costs.usage, 'paid');
    assert.match(by.costs.blocked, /paid model/);
    assert.match(by.odd.blocked, /has not said what/);
  });
});

test('Backup AIs: a connection nobody confirmed is passed over, and the job pauses rather than spends', () => {
  resetForTests();
  const { budget, connections } = setup('gemini');
  const agent = { provider: 'gemini', fallbacks: ['mistral', 'zai'] };
  const tried = new Set();
  const first = nextProvider(agent, tried, budget);
  assert.equal(first, 'zai', 'unconfirmed Gemini and Mistral are skipped; Z.ai still has free models');
  connections.verify('gemini', 'free');
  assert.equal(nextProvider(agent, new Set(), budget), 'gemini');
});

test('what comes back: tools, limits, a bad key, a leaked key, and rate limits as stated', async (t) => {
  let mode = 'tools';
  const seen = await standIn(t, 'gemini', (req, res, r) => {
    if (mode === 'tools') return answer(res, '', { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] });
    if (mode === 'limit') { res.statusCode = 429; res.setHeader('Retry-After', '60'); return res.end(JSON.stringify({ error: { message: 'Quota exceeded' } })); }
    if (mode === 'credit') { res.statusCode = 402; return res.end(JSON.stringify({ error: { message: 'No balance' } })); }
    if (mode === 'badkey') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: `bad key ${SECRET}` } })); }
    if (mode === 'leak') { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: `failed for key ${SECRET}` } })); }
    if (mode === 'notools') {
      if (r.body.tools?.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'This model does not support tools' } })); }
      return answer(res, '{"say":"done","tool_calls":[{"name":"read_file","input":{"path":"b.txt"}}]}');
    }
    res.setHeader('x-ratelimit-limit-requests', '20');
    res.setHeader('x-ratelimit-remaining-requests', '5');
    res.setHeader('x-ratelimit-reset-requests', '30s');
    return answer(res);
  });
  const { dir, vault, budget, connections } = setup('gemini');
  connections.verify('gemini', 'free');
  const quota = createQuota(dir);
  setQuotaSink((p, r) => quota.record(p, r));
  t.after(() => setQuotaSink(() => {}));
  const ai = createProvider('gemini', vault, budget);
  const go = (m) => { mode = m; return ai.complete({ ...ask, model: 'gemini-x', tools: ['read_file'] }); };

  const tools = await go('tools');
  assert.deepEqual(tools.toolCalls.map((c) => [c.name, c.input.path]), [['read_file', 'a.txt']]);
  await assert.rejects(go('limit'), (e) => e.limit === true, 'a limit pauses');
  await assert.rejects(go('credit'), (e) => e.limit === true, 'no balance is treated as a limit too, never retried');
  await assert.rejects(go('badkey'), (e) => e.signIn === true && !e.message.includes(SECRET));
  await assert.rejects(go('leak'), (e) => !e.message.includes(SECRET) && e.message.includes('[hidden]'), 'a key echoed by a service does not reach a log');

  const fallback = await go('notools');
  assert.equal(fallback.text, 'done');
  assert.equal(fallback.toolCalls[0].name, 'read_file', 'a model with no tools works through plain text');
  assert.equal(connections.toolsOf('gemini', 'gemini-x'), false, 'and that is remembered from its own answer');
  assert.equal(seen.at(-1).body.tools, undefined, 'without asking it for tools again');

  await go('rate');
  const reading = quota.read('gemini');
  assert.equal(reading.windows['requests in this rate window'].usedPercent, 75);
  assert.ok(reading.windows['requests in this rate window'].resetsAt > Date.now());
  assert.match(reading.source, /Reported by Google Gemini/);
});

test('cancelling stops a request that is already on its way', async (t) => {
  await standIn(t, 'gemini', () => { /* never answers */ });
  const { vault, budget, connections } = setup('gemini');
  connections.verify('gemini', 'free');
  const stop = new AbortController();
  const pending = createProvider('gemini', vault, budget).complete({ ...ask, model: 'x', signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  const started = Date.now();
  await assert.rejects(pending, /Stopped/);
  assert.ok(Date.now() - started < 3000);
});

test('a model is the owner’s choice: none chosen means asking, never guessing', async (t) => {
  await standIn(t, 'gemini', (req, res) => answer(res));
  const { vault, budget, connections } = setup('gemini');
  connections.verify('gemini', 'free');
  const ai = createProvider('gemini', vault, budget);
  await assert.rejects(ai.complete({ ...ask, model: 'default' }), (e) => /Choose a model/.test(e.message) && e.signIn);
  connections.choose('gemini', 'gemini-x', { neverPaid: true });
  const seen = await ai.complete({ ...ask, model: 'default' });
  assert.equal(seen.text, 'ok');
});

test('capabilities are what a service reported, and nothing is filled in', async (t) => {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  const replies = {
    'ai/models/search': { result: [{ name: '@cf/x/one', properties: [{ property_id: 'function_calling', value: 'true' }, { property_id: 'context_window', value: '8192' }] }, { name: '@cf/x/two', properties: [] }] },
    'v1beta/models': { models: [{ name: 'models/gem', displayName: 'Gem', inputTokenLimit: 1000, supportedGenerationMethods: ['generateContent'], thinking: true }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] },
    'mistral.ai': [{ id: 'm1', capabilities: { completion_chat: true, function_calling: true }, max_context_length: 32768 }, { id: 'm2', capabilities: { completion_chat: false } }],
    'openrouter.ai': { data: [{ id: 'a:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 100 }, { id: 'b', pricing: { prompt: '0.1', completion: '0.1' } }] },
    'ollama.com': { models: [{ name: 'gemma:31b' }] },
    'nvidia.com': { data: [{ id: 'nv/one' }] },
  };
  global.fetch = async (url) => {
    const hit = Object.entries(replies).find(([k]) => String(url).includes(k));
    return new Response(JSON.stringify(hit?.[1] ?? { error: 'nope' }), { status: hit ? 200 : 500 });
  };
  const vault = { get: () => ({ apiKey: 'k', accountId: 'a' }) };
  const c = createConnections(tmp(), { vault });
  const of = async (p) => Object.fromEntries((await c.discover(p)).models.map((m) => [m.id, m]));

  const cf = await of('cloudflare');
  assert.equal(cf['@cf/x/one'].tools, true);
  assert.equal(cf['@cf/x/one'].context, 8192);
  assert.equal(cf['@cf/x/two'].tools, null, 'not reported stays not reported');
  assert.equal(cf['@cf/x/two'].coding, 'Not reported');
  assert.equal(cf['@cf/x/one'].usage, 'unknown', 'and its cost is unknown until confirmed');

  const gem = await of('gemini');
  assert.deepEqual(Object.keys(gem), ['gem'], 'only what can answer a chat');
  assert.equal(gem.gem.context, 1000);
  assert.equal(gem.gem.reasoning, true);

  const mis = await of('mistral');
  assert.deepEqual(Object.keys(mis), ['m1']);
  assert.equal(mis.m1.tools, true);

  const or = await of('openrouter-free');
  assert.deepEqual(Object.keys(or), ['a:free'], 'priced models are not offered');
  assert.equal(or['a:free'].usage, 'free');

  assert.equal((await of('ollama-cloud'))['gemma:31b'].context, null);
  assert.equal((await of('nvidia'))['nv/one'].tools, null);

  // When a service will not list, Z.ai's pricing page is what's shown: free models, marked as such.
  const zai = await c.discover('zai');
  assert.deepEqual(zai.models.map((m) => m.id).sort(), ['glm-4.5-flash', 'glm-4.7-flash']);
  assert.match(zai.source, /pricing page/);
});

test('the room hears a state and a reason, never a key or an account fact', async () => {
  const { dir, vault, budget, connections } = setup('gemini');
  const status = createProviderStatus({ vault, budget, dataDir: dir });
  await status.refreshInstalled();
  const blocked = JSON.stringify(status.all(Object.keys(PROVIDERS)));
  assert.ok(!blocked.includes(SECRET));
  connections.verify('gemini', 'free');
  connections.choose('gemini', 'gemini-x', { neverPaid: true });
  const open = status.all(['gemini']).gemini;
  assert.equal(open.state, 'Connected');
  assert.ok(!JSON.stringify(open).includes(SECRET));
  assert.deepEqual(Object.keys(open).sort(), ['reason', 'state', 'tools']);
});

test('a test connection is held to the same rule: it can never be how a charge happens', async (t) => {
  const seen = await standIn(t, 'zai', (req, res) => answer(res));
  const { dir, vault, budget } = setup('zai');
  const status = createProviderStatus({ vault, budget, dataDir: dir });
  const refused = await status.test('zai', 'glm-5');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /paid model/);
  assert.equal(seen.length, 0);
  assert.equal((await status.test('zai', 'glm-4.7-flash')).ok, true);
  assert.equal(seen[0].body.model, 'glm-4.7-flash');
});

test('saved keys survive restarts, and an old key file moves to the operating system', { skip: process.platform !== 'win32' && 'uses DPAPI, which only Windows has' }, () => {
  const dir = tmp();
  // A vault made the old way.
  const plain = createVault(dir, { platform: 'none' });
  plain.set('gemini', 'apiKey', SECRET);
  plain.setSecret('chatgptPlan', { accessToken: 'kept' });
  assert.ok(fs.existsSync(path.join(dir, 'vault.key')));

  const moved = createVault(dir);
  assert.equal(moved.get('gemini').apiKey, SECRET, 'nothing saved is lost');
  assert.equal(moved.getSecret('chatgptPlan').accessToken, 'kept', 'a ChatGPT sign-in comes along');
  assert.equal(moved.storage(), 'Windows DPAPI');
  assert.ok(!fs.existsSync(path.join(dir, 'vault.key')), 'the plain key is gone');
  assert.ok(fs.existsSync(path.join(dir, 'vault.key.protected')));

  const again = createVault(dir);
  assert.equal(again.get('gemini').apiKey, SECRET, 'and it opens after a restart');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).toString().includes(SECRET), `${f} does not hold the key in clear`);

  again.remove('gemini');
  assert.equal(createVault(dir).get('gemini').apiKey, undefined, 'disconnecting deletes it');

  fs.writeFileSync(path.join(dir, 'vault.key.protected'), Buffer.from('garbage').toString('base64'));
  assert.throws(() => createVault(dir).get('gemini'), /Could not open/, 'a key it cannot open is an error, never silently replaced');
});

test('updates from a private repository use the person’s own sign-in, and only for GitHub', async (t) => {
  const zip = Buffer.from('pretend zip');
  const sum = crypto.createHash('sha256').update(zip).digest('hex');
  let isPublic = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
    const allowed = isPublic || req.headers.authorization === 'Bearer own-token';
    if (!allowed) { res.statusCode = 404; return res.end('{}'); }
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.endsWith('/releases/latest')) return res.end(JSON.stringify({ tag_name: 'build-7', html_url: `${base}/r`, assets: [{ name: 'CrewOffice.zip', url: `${base}/asset/1` }, { name: 'CrewOffice.zip.sha256', url: `${base}/asset/2` }] }));
    if (req.url === '/asset/1') { assert.equal(req.headers.accept, 'application/octet-stream'); return res.end(zip); }
    if (req.url === '/asset/2') return res.end(`${sum}  CrewOffice.zip`);
    res.statusCode = 404; return res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = tmp();
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({ build: 3, repo: 'me/crew', commit: 'abc' }));
  fs.mkdirSync(path.join(root, 'installer', 'windows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'installer', 'windows', 'install.ps1'), '# stand-in');
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  const signedOut = createUpdater({ root, apiBase, platform: 'win32', getToken: async () => null });
  const out = await signedOut.status({ force: true });
  assert.equal(out.needsSignIn, true, 'it says so, rather than claiming there is no update');
  assert.equal(out.available, false);

  let launched = null;
  const signedIn = createUpdater({ root, apiBase, platform: 'win32', dataDir: tmp(), getToken: async () => 'own-token', launchInstaller: (a) => { launched = a; } });
  const s = await signedIn.status({ force: true });
  assert.equal(s.available, true);
  assert.equal(s.latest.build, 7);
  assert.ok(!JSON.stringify(s).includes('own-token'), 'the token never reaches the page');
  assert.equal(requests.find((r) => r.url.endsWith('/latest')).auth, undefined, 'asked anonymously first');
  await signedIn.install();
  assert.ok(launched.zipFile, 'downloaded, verified and handed to the installer');
  assert.equal(fs.readFileSync(launched.zipFile).toString(), 'pretend zip');

  isPublic = true;
  requests.length = 0;
  const anon = createUpdater({ root, apiBase, platform: 'win32', getToken: async () => { throw new Error('should not be asked'); } });
  assert.equal((await anon.status({ force: true })).available, true, 'a public repository needs no sign-in at all');
  assert.ok(requests.every((r) => !r.auth));
});
