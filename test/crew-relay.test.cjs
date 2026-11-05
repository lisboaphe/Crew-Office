// Internet multiplayer through a real relay: separate relay and host processes, real sockets, and a
// friend who only ever talks to the relay's address. All on one computer, so this proves the
// protocol and the permissions. It says nothing about real routers, CGNAT or real latency; that
// needs two connections, and docs/security/SECURITY_TESTS.md lists it as not yet done.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { startHost, player, startWorker, waitFor, sleep } = require('./lib/crew-harness.cjs');

const KEY = 'relay-test-key-0123456789';

async function startRelay(t, port = 8900 + Math.floor(Math.random() * 90), env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'crew-relay.cjs'), String(port)], { env: { ...process.env, CREW_RELAY_KEY: KEY, ...env }, stdio: 'ignore' });
  const relay = { port, url: `http://127.0.0.1:${port}`, child, stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); }) };
  t.after(() => relay.stop());
  await waitFor(async () => { try { return (await fetch(`${relay.url}/_relay/health`)).ok; } catch { return false; } }, { what: 'the relay', timeout: 8000 });
  return relay;
}

/** The host's owner: paired by the key file, like the app's own window. */
async function ownerOf(host) {
  const key = fs.readFileSync(path.join(host.stateDir, 'crew', 'machine.key'), 'utf8').trim();
  const res = await fetch(`${host.url}/api/crew/this-computer/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: JSON.stringify({ key }) });
  const machine = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crew_machine='));
  const call = async (method, p, body) => {
    const r = await fetch(host.url + p, { method, headers: { 'Content-Type': 'application/json', 'X-Crew': '1', Cookie: call.cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crew_session='));
    if (set) call.cookie = `${machine}; ${set}`;
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  call.cookie = machine;
  return call;
}

async function setUp(t) {
  const relay = await startRelay(t);
  const host = await startHost();
  t.after(() => host.stop());
  const owner = await ownerOf(host);
  await owner('POST', '/api/crew/enter', { name: 'Host' });
  assert.strictEqual((await owner('GET', '/api/crew/internet')).state, 'off', 'says local until it really is not');
  await owner('PUT', '/api/crew/internet', { url: relay.url, key: KEY });
  await waitFor(async () => (await owner('GET', '/api/crew/internet')).state === 'online', { what: 'the tunnel', timeout: 8000 });
  const { room } = await owner('POST', '/api/crew/rooms', { name: 'Internet office', privacy: 'invite', maxPlayers: 4 });
  const { invite } = await owner('POST', `/api/crew/rooms/${room.id}/invites`, { role: 'member', uses: 5 });
  return { relay, host, owner, room, invite, R: `/api/crew/rooms/${room.id}` };
}

test('a friend who only knows the relay joins, and their agent does real work through it', { timeout: 90_000 }, async (t) => {
  const o = await setUp(t);
  const friend = player(o.relay.url);
  t.after(() => friend.leaveAll());
  const page = await friend.text(`/crew/join?invite=${o.invite.code}`);
  assert.strictEqual(page.status, 200, 'the invitation link opens');
  assert.strictEqual((await friend.post('/api/crew/enter', { name: 'Friend' })).status, 200);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { code: o.room.code })).status, 403, 'the code alone is not enough');
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { invite: o.invite.code })).status, 200);
  const live = await friend.enter(o.room.id);
  await waitFor(() => live.events.length > 0, { what: 'live events through the relay', timeout: 5000 });

  // The friend's real worker, on the relay's address, with Git through it too.
  const { worker } = await friend.post(`${o.R}/workers`, { name: 'Friend PC' });
  const w = startWorker({ hostUrl: o.relay.url, token: worker.token });
  t.after(() => w.stop());
  const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'exec'];
  const lead = (await o.owner('POST', `${o.R}/agents`, { name: 'Paige', role: 'Project Manager', provider: 'scripted', model: 'scripted', tools: TOOLS })).agent;
  const bea = (await friend.post(`${o.R}/agents`, { name: 'Bea', role: 'Backend Developer', provider: 'scripted', model: 'scripted', tools: TOOLS })).agent;
  await waitFor(async () => (await friend.get(`${o.R}/state`)).agents.find((a) => a.id === bea.id)?.available, { what: 'the agent to come online', timeout: 15_000 });

  const { project } = await o.owner('POST', `${o.R}/projects`, { name: 'Shared', goal: 'Build it', managerAgentId: lead.id });
  await friend.post(`${o.R}/projects/${project.id}/join`);
  await friend.post(`${o.R}/projects/${project.id}/grants`, { agentId: bea.id, budgetUsd: 2, requiresApproval: false, tools: TOOLS });
  const { task } = await friend.post(`${o.R}/projects/${project.id}/tasks`, { title: 'Build the backend', description: 'Build it.', agentId: bea.id });
  await o.owner('PUT', `/api/crew/rooms/${o.room.id}/rules/project/${project.id}`, { rules: { approvalMode: 'autonomous', requireReview: false } });
  await o.owner('POST', `${o.R}/projects/${project.id}/start`);
  assert.ok(task);
  await waitFor(async () => (await friend.get(`${o.R}/projects/${project.id}`)).tasks?.find((x) => x.id === task.id)?.status === 'completed', { what: 'the task to finish through the relay', timeout: 45_000 });
  const file = await friend.text(`${o.R}/projects/${project.id}/files/server.js`);
  assert.strictEqual(file.status, 200, 'the file the friend’s agent wrote is on the host');
  assert.ok(file.text.length > 100);

  // Git, through the same address.
  const { repo } = await o.owner('POST', `${o.R}/projects/${project.id}/repos`, { name: 'code' });
  const token = (await friend.post(`${o.R}/git-tokens`, { label: 't' })).token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-rg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args, cwd = dir) => spawnSync('git', ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}`, '-c', 'user.name=F', '-c', 'user.email=f@x', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  const clone = git(['clone', '--quiet', `${o.relay.url}${repo.url}`, 'w']);
  assert.strictEqual(clone.status, 0, clone.stderr);
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE((Math.random() * 2 ** 32) >>> 0, i);
  fs.writeFileSync(path.join(dir, 'w', 'data.bin'), big);
  git(['add', '-A'], path.join(dir, 'w'));
  git(['commit', '-qm', 'Data'], path.join(dir, 'w'));
  const me = (await friend.get('/api/crew/me')).user.id;
  const push = git(['push', '--quiet', 'origin', `HEAD:refs/heads/user/${me.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}/data`], path.join(dir, 'w'));
  assert.strictEqual(push.status, 0, `a 3 MB push through the relay: ${push.stderr}`);
  assert.notStrictEqual(git(['push', 'origin', 'HEAD:refs/heads/main'], path.join(dir, 'w')).status, 0, 'and main is as protected from here as anywhere');
});

test('through the relay only the office is there, and it never counts as this computer', { timeout: 40_000 }, async (t) => {
  const o = await setUp(t);
  const get = (p, headers = {}) => fetch(o.relay.url + p, { headers, redirect: 'manual' });
  for (const p of ['/api/health', '/offices', '/home.html', '/aop/v0/events', '/admin', '/api/crew/lan-rooms', '/.env', '/package.json', '/lib/crew/auth.cjs', '/test/crew-relay.test.cjs', '/docs/index.html']) {
    assert.strictEqual((await get(p)).status, 404, p);
  }
  assert.strictEqual((await fetch(`${o.relay.url}/api/offices`, { method: 'POST', headers: { 'X-Crew': '1' } })).status, 404, 'no minting offices from outside');

  const visitor = player(o.relay.url);
  await visitor.post('/api/crew/enter', { name: 'Visitor' });
  assert.strictEqual((await visitor.post('/api/crew/rooms', { name: 'Mine', privacy: 'invite' })).status, 404, 'no making rooms on someone’s computer');
  assert.deepStrictEqual(await (await get('/api/crew/this-computer')).json(), { owner: false });
  assert.strictEqual((await visitor.get('/api/crew/update')).available, false);
  assert.strictEqual((await visitor.post('/api/crew/update/install')).status, 403);

  // The machine key is the host's real one, and a visitor who somehow had it still is not local.
  const key = fs.readFileSync(path.join(o.host.stateDir, 'crew', 'machine.key'), 'utf8').trim();
  assert.strictEqual((await visitor.post('/api/crew/this-computer/pair', { key })).status, 403, 'the key does not work from outside');
  const spoof = await fetch(`${o.relay.url}/api/crew/this-computer`, { headers: { Cookie: `crew_machine=${key}`, Host: 'localhost', 'X-Crew-Relay': 'guess', 'X-Crew-Client-Ip': '127.0.0.1' } });
  assert.deepStrictEqual(await spoof.json(), { owner: false }, 'nor do forged headers or a forged Host');

  // And a program on the host's own computer cannot claim to be the tunnel without its secret.
  const stranger = await fetch(`${o.host.url}/api/crew/this-computer`, { headers: { 'X-Crew-Relay': 'a'.repeat(64) } });
  assert.deepStrictEqual(await stranger.json(), { owner: false });
  const statusBody = await (await fetch(`${o.host.url}/api/crew/host-info`, { headers: { 'X-Crew-Relay': 'a'.repeat(64) } })).json();
  assert.strictEqual(statusBody.viaRelay, false);
  assert.ok(!JSON.stringify(await (await get('/api/crew/host-info')).json()).includes(KEY), 'and the relay key is nowhere');
});

test('losing the relay is reported, retried, and recovered with the same address', { timeout: 60_000 }, async (t) => {
  const relayPort = 8900 + Math.floor(Math.random() * 90);
  const relay = await startRelay(t, relayPort);
  const host = await startHost();
  t.after(() => host.stop());
  const owner = await ownerOf(host);
  await owner('POST', '/api/crew/enter', { name: 'Host' });

  const wrong = await owner('PUT', '/api/crew/internet', { url: relay.url, key: 'not-the-key' });
  assert.notStrictEqual(wrong.state, 'online');
  const refused = await waitFor(async () => { const s = await owner('GET', '/api/crew/internet'); return s.state === 'unavailable' ? s : null; }, { what: 'the refusal', timeout: 6000 });
  assert.match(refused.reason, /key is wrong/);
  assert.strictEqual(refused.url, null, 'and no link is offered');

  await owner('PUT', '/api/crew/internet', { url: relay.url, key: KEY });
  const up = await waitFor(async () => { const s = await owner('GET', '/api/crew/internet'); return s.state === 'online' ? s : null; }, { what: 'the tunnel', timeout: 8000 });
  assert.ok(up.url);

  await relay.stop();
  const down = await waitFor(async () => { const s = await owner('GET', '/api/crew/internet'); return s.state !== 'online' ? s : null; }, { what: 'the host to notice', timeout: 8000 });
  assert.ok(['reconnecting', 'unavailable'].includes(down.state), 'never still says online');
  assert.strictEqual(down.url, null);

  const back = await startRelay(t, relayPort);
  await waitFor(async () => (await owner('GET', '/api/crew/internet')).state === 'online', { what: 'recovery', timeout: 40_000 });
  assert.strictEqual((await fetch(`${back.url}/crew`)).status, 200, 'and the same address works again');
});

test('when the host goes, visitors are told, and it comes back on the same link', { timeout: 40_000 }, async (t) => {
  const o = await setUp(t);
  assert.strictEqual((await fetch(`${o.relay.url}/crew`)).status, 200);
  const stateDir = o.host.stateDir;
  const port = o.host.port;
  await o.host.stop();
  const off = await waitFor(async () => { const r = await fetch(`${o.relay.url}/crew`, { headers: { Accept: 'text/html' } }); return r.status === 503 ? r : null; }, { what: 'the offline page', timeout: 8000 });
  assert.match(await off.text(), /not online right now/);
  const again = await startHost({ stateDir, port });
  t.after(() => again.stop());
  await waitFor(async () => (await fetch(`${o.relay.url}/crew`)).status === 200, { what: 'the host to dial back in', timeout: 15_000 });
  const friend = player(o.relay.url);
  await friend.post('/api/crew/enter', { name: 'Friend' });
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { invite: o.invite.code })).status, 200, 'the invitation still works, and its office is intact');
});

function rawHost(port, hostname, p = '/crew') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: hostname } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

test('with a domain, each office has its own address, so one cannot read another’s cookies', { timeout: 40_000 }, async (t) => {
  const relay = await startRelay(t, undefined, { CREW_RELAY_DOMAIN: 'relay.test' });
  // relay.test has no DNS behind it, so the host's check of its own address dials the relay directly.
  const host = await startHost({ env: { CREW_RELAY_PROBE_VIA: '127.0.0.1' } });
  t.after(() => host.stop());
  const owner = await ownerOf(host);
  await owner('POST', '/api/crew/enter', { name: 'Host' });
  await owner('PUT', '/api/crew/internet', { url: relay.url, key: KEY });
  const s = await waitFor(async () => { const x = await owner('GET', '/api/crew/internet'); return x.state === 'online' ? x : null; }, { what: 'the tunnel', timeout: 8000 });
  const name = new URL(s.url).hostname;
  assert.match(name, /^[a-z0-9]{20,}\.relay\.test$/, 'a long unguessable name');
  assert.strictEqual(await rawHost(relay.port, name), 200);
  assert.strictEqual(await rawHost(relay.port, 'someoneelse.relay.test'), 503);
  assert.strictEqual(await rawHost(relay.port, 'relay.test'), 503);
});

test('the relay refuses to run open by accident, turns away the wrong key, and rate-limits', { timeout: 30_000 }, async (t) => {
  const none = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'crew-relay.cjs'), '8999'], { env: { ...process.env, CREW_RELAY_KEY: '', CREW_RELAY_OPEN: '' }, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(none.status, 1);
  assert.match(none.stderr, /set CREW_RELAY_KEY/);

  const relay = await startRelay(t, undefined, { CREW_RELAY_RATE: '10' });
  const statuses = [];
  for (let i = 0; i < 14; i++) statuses.push((await fetch(`${relay.url}/x`)).status);
  assert.ok(statuses.includes(429), 'too many from one address');
  const up = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: '/_relay/connect', headers: { Connection: 'Upgrade', Upgrade: 'crew-relay', 'X-Crew-Relay-Key': 'wrong' } });
    req.on('response', (r) => { r.resume(); resolve(r.statusCode); });
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve('closed'));
    req.end();
  });
  assert.strictEqual(up, 401);
  assert.ok(sleep);
});
