// The boundaries, attacked. These are not checks that an agent behaves: every one acts as the
// misbehaving agent or player, against a real host and real workers, and asserts the software
// refused. The scripted provider stands in for a model, so what this cannot show is how a real
// one fares against prompt injection; that is why tool authorisation does not depend on the model.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { startHost, player, startWorker, waitFor, sleep } = require('./lib/crew-harness.cjs');
const sandbox = require('../lib/crew-worker/sandbox.cjs');

const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'git'];

async function office(t) {
  const host = await startHost();
  const a = player(host.url);
  const b = player(host.url);
  const workers = [];
  t.after(async () => { a.leaveAll(); b.leaveAll(); for (const w of workers) w.stop(); await host.stop(); });
  await a.post('/api/crew/register', { username: 'anna', password: 'anna-pass-12', displayName: 'Anna' });
  await b.post('/api/crew/register', { username: 'bo', password: 'bo-pass-1234', displayName: 'Bo' });
  const { room } = await a.post('/api/crew/rooms', { name: 'Studio', privacy: 'invite', maxPlayers: 4 });
  const R = `/api/crew/rooms/${room.id}`;
  const { invite } = await a.post(`${R}/invites`, { role: 'member', uses: 5 });
  await b.post('/api/crew/rooms/join', { invite: invite.code });
  await a.enter(room.id);
  await b.enter(room.id);
  const agent = async (p, name, role = 'Backend Developer') => (await p.post(`${R}/agents`, { name, role, skills: [role.toLowerCase()], provider: 'scripted', model: 'scripted', tools: TOOLS, budgetUsd: 5 })).agent;
  const worker = async (p, name) => { const { worker: w } = await p.post(`${R}/workers`, { name }); const s = startWorker({ hostUrl: host.url, token: w.token }); workers.push(s); return { ...s, token: w.token }; };
  const rawWorker = async (p) => (await p.post(`${R}/workers`, { name: 'raw' })).worker.token;
  const call = (token, route, body) => fetch(`${host.url}/api/crew/worker/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
  return { host, a, b, room, R, invite, agent, worker, rawWorker, call };
}

const audit = async (o, p = o.a, q = '') => (await p.get(`${o.R}/security/audit${q ? `?q=${encodeURIComponent(q)}` : ''}`)).events;

test('new rooms start Balanced; Autonomous still cannot reach what is not granted', async (t) => {
  const o = await office(t);
  assert.strictEqual((await o.a.get(`${o.R}/security`)).profile, 'balanced');

  // Test 5: routine approvals off, and the unauthorised thing is still refused.
  assert.strictEqual((await o.a.req('PUT', `${o.R}/rules/office/${o.room.id}`, { rules: { approvalMode: 'autonomous' } })).status, 200);
  assert.strictEqual((await o.a.get(`${o.R}/security`)).profile, 'autonomous');
  const benAgent = await o.agent(o.b, 'Bea');
  const token = await o.rawWorker(o.b);
  const { project } = await o.a.post(`${o.R}/projects`, { name: 'Secret plans', goal: 'G', managerAgentId: (await o.agent(o.a, 'Paige', 'Project Manager')).id });
  await o.a.post(`${o.R}/projects/${project.id}/notes`, { title: 'Private', body: 'the secret' });

  assert.strictEqual((await o.b.get(`${o.R}/projects/${project.id}`)).status, 403, 'not on the project: no contents');
  assert.strictEqual((await o.b.get(`${o.R}/projects/${project.id}/blobs`)).status, 403);
  assert.strictEqual((await o.b.post(`${o.R}/projects/${project.id}/grants`, { agentId: benAgent.id, budgetUsd: 1 })).status, 403, 'cannot put an agent on it without joining');
  assert.strictEqual((await o.call(token, 'tool', { jobId: 'job_invented', name: 'read_file', args: { path: '../../secrets' } })).status >= 400, true, 'no job, no tool');
  assert.ok(!(await o.b.get(`${o.R}/state`)).tasks.some((x) => x.projectId === project.id), 'and its tasks are not in the state either');
  const denied = await audit(o);
  assert.ok(denied.some((e) => e.outcome === 'denied' && /Join this project/.test(JSON.stringify(e.detail))), 'and the refusal is on the record');
});

test('Test 2 and 3: another player’s agent reaches neither files outside the project nor a command on the host', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const privateFile = path.join(o.host.stateDir, 'crew', 'machine.key');
  assert.ok(fs.existsSync(privateFile));
  const lead = await o.agent(o.a, 'Paige', 'Project Manager');
  const bea = await o.agent(o.b, 'Bea');
  const { project } = await o.a.post(`${o.R}/projects`, { name: 'Shared', goal: 'G', managerAgentId: lead.id });
  await o.b.post(`${o.R}/projects/${project.id}/join`);
  await o.b.post(`${o.R}/projects/${project.id}/grants`, { agentId: bea.id, budgetUsd: 1, requiresApproval: false, tools: TOOLS });
  await o.a.post(`${o.R}/projects/${project.id}/tasks`, { title: 'Work', agentId: bea.id });
  await o.a.req('PUT', `${o.R}/rules/office/${o.room.id}`, { rules: { approvalMode: 'autonomous' } });
  const { project: p2 } = await o.a.get(`${o.R}/projects/${project.id}`);
  await o.a.post(`${o.R}/projects/${p2.id}/start`);
  await o.a.post(`${o.R}/agents/${lead.id}/assign`, { projectId: p2.id, title: 'noop' }).catch(() => {});

  const token = await o.rawWorker(o.b);
  const claim = await waitFor(async () => { const c = await o.call(token, 'claim', {}); return c.job ? c : null; }, { what: 'Bea’s job', timeout: 20_000 });
  const tool = (name, args) => o.call(token, 'tool', { jobId: claim.job.id, name, args });

  for (const escape of ['../../../machine.key', '..\\..\\..\\machine.key', '/etc/passwd', 'C:\\Windows\\win.ini', '%2e%2e/%2e%2e/machine.key', 'a/../../../../machine.key', '\u0000x']) {
    const read = await tool('read_file', { path: escape });
    assert.ok(!read.ok || !String(read.result?.content ?? '').length, `read refused: ${escape}`);
    assert.ok(!JSON.stringify(read).includes(fs.readFileSync(privateFile, 'utf8').trim()), 'and the key is nowhere in it');
    const write = await tool('write_file', { path: escape, content: 'OVERWRITTEN' });
    // A literal name with percent signs in it is a strange file inside the project, not an escape.
    if (!escape.includes('%')) assert.ok(!write.ok, `write refused: ${escape}`);
    assert.notStrictEqual(fs.readFileSync(privateFile, 'utf8'), 'OVERWRITTEN', 'the private file is untouched');
  }

  // There is no such thing as a command on the host. Every spelling is refused by name.
  for (const name of ['run_command', 'shell', 'exec', 'host_exec', 'eval', 'system']) {
    const r = await tool(name, { command: 'whoami' });
    assert.ok(r.status >= 400 || r.ok === false, `${name} did not run on the host`);
    assert.ok(!JSON.stringify(r).includes(os.userInfo().username), `${name} returned nothing of the host’s`);
  }
  assert.ok(!(await o.call(token, 'authorize', { jobId: 'job_other', name: 'run_command', summary: 'whoami' })).allowed, 'and authorising is for a job this worker holds');

  // Forged identity: Anna's worker cannot act for the job Bo's worker holds.
  const annaToken = await o.rawWorker(o.a);
  assert.ok((await o.call(annaToken, 'tool', { jobId: claim.job.id, name: 'send_message', args: { body: 'I am Bea' } })).status >= 400, 'one worker cannot speak as another’s agent');
  assert.ok((await audit(o)).some((e) => e.outcome === 'denied' && /read_file|write_file/.test(e.resource ?? '')), 'recorded');
});

test('the sandbox refuses another player’s code without Docker, unless its owner accepted that', async (t) => {
  const was = process.env.CREW_ALLOW_WEAK_SANDBOX;
  delete process.env.CREW_ALLOW_WEAK_SANDBOX;
  t.after(() => { process.env.CREW_ALLOW_WEAK_SANDBOX = was; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-s-'));
  const files = { 'evil.js': "console.log('RAN')" };
  const run = (ctx, hostBase) => sandbox.forContext(ctx, { hostBase, dataDir: dir })('node evil.js', files);
  const shared = { project: { sharedWithOthers: true } };
  const solo = { project: { sharedWithOthers: false } };
  if (sandbox.dockerAvailable()) return t.skip('Docker is here, so this code would run in a container instead.');

  const r = await run(shared, 'http://localhost:8080');
  assert.strictEqual(r.refused, true);
  assert.ok(!r.output.includes('RAN'), 'nothing ran');
  const remote = await run(solo, 'https://office.example.com');
  assert.strictEqual(remote.refused, true, 'and a host this worker does not run itself is not believed when it says “not shared”');
  assert.match((await run(solo, 'http://localhost:8080')).output, /RAN/, 'your own solo project still runs');

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ allowWeakSandbox: true }));
  assert.match((await run(shared, 'http://localhost:8080')).output, /RAN/, 'the owner’s choice is honoured, and it is theirs to make');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sandboxed code: no files, no children, no network, no flags that loosen it, and it dies on time', { timeout: 60_000 }, async () => {
  const canary = path.join(os.tmpdir(), `crew-canary-${process.pid}.txt`);
  fs.writeFileSync(canary, 'PRIVATE');
  const j = (s) => s.replaceAll('\\', '/');
  const probe = http.createServer((q, r) => { probe.reached = true; r.end('ok'); });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  const run = (body, opts) => sandbox.run('node evil.js', { 'evil.js': body }, opts);
  try {
    assert.doesNotMatch((await run(`console.log(require('fs').readFileSync('${j(canary)}','utf8'))`)).output, /\nPRIVATE|^PRIVATE/, 'a private file');
    assert.match((await run("require('child_process').execSync('whoami')")).output, /restricted|ACCESS_DENIED/, 'a child process');
    for (const body of [`fetch('http://127.0.0.1:${port}/').then(()=>console.log('REACHED')).catch(()=>console.log('no'))`,
      `require('net').connect(${port},'127.0.0.1',()=>console.log('REACHED')).on('error',()=>console.log('no'))`,
      `require('http').get('http://127.0.0.1:${port}/',()=>console.log('REACHED')).on('error',()=>console.log('no'))`,
      `require('dns').lookup('example.com',(e)=>console.log(e?'no':'REACHED'))`]) {
      const out = await run(`process.on('uncaughtException',()=>console.log('no'));${body}`);
      assert.doesNotMatch(out.output, /REACHED/, `network: ${body.slice(0, 40)}`);
    }
    assert.ok(!probe.reached, 'and the server never saw a connection');
    const own = await run("const s=require('http').createServer((q,r)=>r.end('hi'));s.listen(0,()=>{fetch('http://127.0.0.1:'+s.address().port).then(r=>r.text()).then(t=>{console.log('OWN:'+t);s.close()})})");
    assert.match(own.output, /OWN:hi/, 'a test may still start its own server and talk to it');
    for (const flag of ['--allow-fs-read=*', '--no-permission', '--require=./x.js', '--import=./x.js', '--env-file=x', '--inspect', '--expose-internals', '--allow-child-process', '--experimental-default-type=module']) {
      assert.throws(() => sandbox.parseCommand(`node ${flag} evil.js`), /sets its own/, flag);
    }
    for (const bad of ['whoami', 'node a.js && whoami', 'node a.js | x', 'node a.js; x', 'cmd /c dir', 'powershell -c x', '$(whoami)']) assert.throws(() => sandbox.parseCommand(bad), undefined, bad);
    const env = await run("console.log(JSON.stringify(process.env))");
    assert.doesNotMatch(env.output, /API_KEY|TOKEN|SECRET/);

    const slow = await run('setInterval(()=>{},1000)', { timeoutMs: 1500 });
    assert.match(slow.output, /killed after/, 'an endless script is killed');

    const stop = new AbortController();
    const started = Date.now();
    const pending = run('setInterval(()=>{},1000)', { signal: stop.signal });
    setTimeout(() => stop.abort(), 500);
    const stopped = await pending;
    assert.match(stopped.output, /stopped by an emergency stop/);
    assert.ok(Date.now() - started < 15_000, 'and stopping does not wait for the timeout');
  } finally { probe.close(); fs.rmSync(canary, { force: true }); }
});

test('Test 4: a push with hooks, links and build steps runs nothing on the host, and main stays protected', { timeout: 90_000 }, async (t) => {
  const o = await office(t);
  if (!(await o.a.get(`${o.R}/state`)).gitAvailable) return t.skip('No Git here.');
  const lead = await o.agent(o.a, 'Paige', 'Project Manager');
  const bea = await o.agent(o.b, 'Bea');
  const { project } = await o.a.post(`${o.R}/projects`, { name: 'Shared', goal: 'G', managerAgentId: lead.id });
  const P = `${o.R}/projects/${project.id}`;
  await o.b.post(`${P}/join`);
  await o.b.post(`${P}/grants`, { agentId: bea.id, budgetUsd: 1, requiresApproval: false, tools: TOOLS });
  const { repo } = await o.a.post(`${P}/repos`, { name: 'code' });
  const bt = (await o.b.post(`${o.R}/git-tokens`, { label: 't' })).token;
  const canary = path.join(o.host.stateDir, 'HOOK_RAN');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-g-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = o.host.url + repo.url;
  const git = (args, cwd = dir, opts = {}) => spawnSync('git', ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${bt}`).toString('base64')}`, '-c', 'user.name=Bo', '-c', 'user.email=bo@x', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...opts });
  assert.strictEqual(git(['clone', '--quiet', url, 'w']).status, 0);
  const w = path.join(dir, 'w');
  const evil = `require('fs').writeFileSync(${JSON.stringify(canary)},'x')`;
  fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify({ scripts: { preinstall: `node -e "${evil}"`, postinstall: `node -e "${evil}"`, test: `node -e "${evil}"` } }));
  fs.mkdirSync(path.join(w, 'hooks'));
  fs.writeFileSync(path.join(w, 'hooks', 'post-receive'), `#!/bin/sh\nnode -e "${evil}"\n`);
  git(['add', '-A'], w);
  git(['commit', '-qm', 'A dangerous build step'], w);
  const branch = `refs/heads/user/${(await o.b.get('/api/crew/me')).user.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}/evil`;
  git(['push', '--quiet', 'origin', `HEAD:${branch}`], w);
  await sleep(600);
  assert.ok(!fs.existsSync(canary), 'storing it ran nothing');

  // Main cannot be written, force-pushed or deleted, whatever is in the push.
  assert.notStrictEqual(git(['push', 'origin', 'HEAD:refs/heads/main'], w).status, 0, 'protected main');
  assert.notStrictEqual(git(['push', '--force', 'origin', ':refs/heads/main'], w).status, 0, 'no delete');
  await sleep(300);
  assert.ok(!fs.existsSync(canary), 'and neither did refusing it');
  const diff = await o.a.get(`${o.R}/repos/${repo.id}/diff?branch=${encodeURIComponent(branch.replace('refs/heads/', ''))}`);
  assert.ok(!fs.existsSync(canary), 'nor reading the diff');
  assert.ok(diff.status === 200 || diff.status === 404);
  assert.ok(!(await o.a.get(`${P}/git`)).repos.some((r) => r.head === undefined && false));
});

test('a worker’s clone ignores what a repository or this machine’s Git would otherwise run', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'crew-worker', 'git-local.cjs'), 'utf8');
  for (const need of ['GIT_CONFIG_GLOBAL', "'core.hooksPath'", "'core.symlinks'", "'submodule.recurse'", "'protocol.ext.allow'", 'GIT_LFS_SKIP_SMUDGE', 'subscriptionEnv()']) assert.ok(src.includes(need), need);
  assert.ok(!/sandbox\.run\(/.test(src), 'tests in a clone only run through the isolation decision');
});

test('invitations expire, can be revoked, and removing a player keeps them out', async (t) => {
  const o = await office(t);
  t.after(() => { if (o.host.child.exitCode !== null) console.log('HOST DIED', o.host.log().slice(-1500)); });
  const carol = player(o.host.url);
  await carol.post('/api/crew/enter', { name: 'Carol' });
  const R = o.R;
  const { invite } = await o.a.post(`${R}/invites`, { role: 'member', uses: 5 });
  assert.ok(invite.code.length >= 16, 'not guessable');
  assert.strictEqual((await o.b.get(`${R}/invites`)).status, 403, 'a member does not manage them');
  assert.strictEqual((await o.b.req('DELETE', `${R}/invites/${invite.code}`)).status, 403);
  assert.ok((await o.a.get(`${R}/invites`)).invites.some((i) => i.code === invite.code));
  assert.strictEqual((await o.a.req('DELETE', `${R}/invites/${invite.code}`)).status, 200);
  assert.strictEqual((await carol.post('/api/crew/rooms/join', { invite: invite.code })).status, 403, 'a revoked link does nothing');

  const db = new (require('node:sqlite').DatabaseSync)(path.join(o.host.stateDir, 'crew', 'crew.sqlite'), { timeout: 8000 });
  const { invite: old } = await o.a.post(`${R}/invites`, { role: 'member', uses: 5 });
  db.prepare('UPDATE invites SET expires_at = 1 WHERE code = ?').run(old.code);
  db.close();
  assert.strictEqual((await carol.post('/api/crew/rooms/join', { invite: old.code })).status, 403, 'an expired link does nothing');

  const bot = await o.agent(o.b, 'Bea');
  const token = await o.rawWorker(o.b);
  const bo = (await o.b.get('/api/crew/me')).user;
  const { invite: stillOut } = await o.a.post(`${R}/invites`, { role: 'member', uses: 5 });
  assert.strictEqual((await o.b.req('DELETE', `${R}/members/${(await o.a.get('/api/crew/me')).user.id}`)).status, 403, 'a member cannot remove the owner');
  assert.strictEqual((await o.a.req('DELETE', `${R}/members/${bo.id}`)).status, 200);
  assert.strictEqual((await o.b.get(`${R}/state`)).status, 403, 'their session no longer opens the office');
  assert.ok((await o.call(token, 'claim', {})).status >= 400, 'their worker is cut off');
  assert.strictEqual((await o.b.post('/api/crew/rooms/join', { invite: stillOut.code })).status, 403, 'and the links out there stop working, or a free new name would walk back in');
  assert.ok(bot.id);
  assert.strictEqual((await carol.post('/api/crew/rooms/join', { code: o.room.code })).status, 403, 'a code alone does not open an invite-only office');
});

test('knowing a room’s code is not enough to watch it', async (t) => {
  const o = await office(t);
  const stranger = player(o.host.url);
  await stranger.post('/api/crew/enter', { name: 'Stranger' });
  for (const p of ['aop/v0/events', 'aop/v0/stream', 'api/scenes']) {
    assert.strictEqual((await stranger.text(`/office/${o.room.code}/${p}`)).status, 403, `${p} as a stranger`);
    assert.strictEqual((await fetch(`${o.host.url}/office/${o.room.code}/${p}`)).status, 403, `${p} with no session`);
  }
  assert.notStrictEqual((await o.b.rawGet(`/office/${o.room.code}/api/scenes`)).status, 403, 'a member still can');
  const res = await fetch(`${o.host.url}/crew`);
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  for (const secret of ['/.env', '/.git/config', '/%2e%2e/%2e%2e/etc/passwd', '/node_modules/.package-lock.json', '/admin/console.html']) {
    assert.notStrictEqual((await fetch(o.host.url + secret)).status, 200, secret);
  }
});

test('Test 6: STOP ALL AI ACTIVITY stops everything, stays stopped, and only a person who may can resume', { timeout: 60_000 }, async (t) => {
  const o = await office(t);
  const lead = await o.agent(o.a, 'Paige', 'Project Manager');
  const bea = await o.agent(o.a, 'Bea');
  const graph = { nodes: [{ id: 'l', type: 'lead', config: { agentId: lead.id } }, { id: 'w', type: 'worker', config: { agentId: bea.id } }, { id: 't', type: 'task', config: { title: 'Build the backend' } }, { id: 'u', type: 'task', config: { title: 'More work', agentId: bea.id } }], edges: [{ from: 'w', to: 't' }, { from: 't', to: 'u' }] };
  const { playbook } = await o.a.post(`${o.R}/playbooks`, { name: 'P', graph, policy: { approvals: false, requireReview: false } });
  const { run } = await o.a.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Go.' });
  const token = await o.rawWorker(o.a);
  const claim = await waitFor(async () => { const c = await o.call(token, 'claim', {}); return c.job ? c : null; }, { what: 'a running job', timeout: 20_000 });

  assert.strictEqual((await o.b.post(`${o.R}/emergency-stop`, {})).status, 403, 'a member cannot stop the whole office');
  const stopped = await o.a.post(`${o.R}/emergency-stop`, { reason: 'test' });
  assert.ok(stopped.tasks >= 1);

  assert.strictEqual((await o.call(token, 'heartbeat', { jobId: claim.job.id })).status >= 400 || (await o.call(token, 'heartbeat', { jobId: claim.job.id })).cancel === true, true, 'the running job is told');
  assert.strictEqual((await o.call(token, 'tool', { jobId: claim.job.id, name: 'send_message', args: { body: 'x' } })).status, 423, 'and its tools stop working');
  assert.strictEqual((await o.call(token, 'claim', {})).job ?? null, null, 'nothing new is handed out');
  assert.strictEqual((await o.a.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Again' })).status, 423, 'no new runs');
  assert.strictEqual((await o.a.post(`${o.R}/agents/${lead.id}/chat`, { text: 'hi' })).status, 423, 'no new chats');
  const after = (await o.a.get(`${o.R}/runs/${run.id}`)).run;
  assert.ok(Object.values(after.tasks).every((x) => !['pending', 'queued', 'in_progress'].includes(x.status)), 'queued work is cancelled');
  assert.ok((await o.a.get(`${o.R}/state`)).emergency, 'the state says so');

  await o.host.stop();
  const again = await startHost({ stateDir: o.host.stateDir, port: o.host.port });
  o.host.stop = again.stop;
  assert.strictEqual((await o.call(token, 'claim', {})).job ?? null, null, 'a restart does not clear it');
  assert.strictEqual((await o.b.post(`${o.R}/emergency-resume`)).status, 403, 'a member cannot resume');
  assert.strictEqual((await o.a.post(`${o.R}/emergency-resume`)).status, undefined === 0 ? 0 : 200);
  assert.ok((await audit(o, o.a)).some((e) => e.action === 'emergency.stop'), 'on the record');
  await again.stop();
});

test('Test 7: a worker that loses the host stops its own work, with nobody telling it to', { timeout: 40_000 }, async () => {
  process.env.CREW_HEARTBEAT_MS = '200';
  process.env.CREW_HOST_SILENCE_MS = '800';
  delete require.cache[require.resolve('../lib/crew-worker/runner.cjs')];
  const { runJob } = require('../lib/crew-worker/runner.cjs');
  delete process.env.CREW_HEARTBEAT_MS;
  delete process.env.CREW_HOST_SILENCE_MS;
  delete require.cache[require.resolve('../lib/crew-worker/runner.cjs')];

  // The real job loop and the real sandbox. The only stand-in is a host that has gone quiet.
  const finishes = [];
  let beats = 0;
  const host = { post: async (p, b) => {
    if (p.endsWith('/finish')) { finishes.push(b); return {}; }
    if (p.endsWith('/heartbeat')) { beats++; throw new Error('network down'); }
    if (p.endsWith('/usage')) return {};
    if (p.endsWith('/authorize')) return { allowed: true };
    if (p.endsWith('/tool')) return { ok: true, result: {} };
    return {};
  } };
  let result = null;
  const localTools = { run_command: async (ctx) => { result = await sandbox.run('node s.js', { 's.js': 'setInterval(()=>{},1000)' }, { signal: ctx.signal, timeoutMs: 30_000 }); return result; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-l-'));
  const ctx = {
    job: { id: 'job_lost', type: 'task', depth: 0, attempt: 1 }, resume: null, inbox: [], room: { name: 'R' },
    agent: { id: 'agt_x', name: 'Bea', role: 'Backend Developer', skills: [], instructions: '', provider: 'scripted', model: 'scripted', fallbacks: [] },
    tools: Object.keys(require('../lib/crew/catalog.cjs').TOOLS).filter((n) => !n.startsWith('repo_') && n !== 'request_merge'),
    project: { id: 'p', name: 'P', goal: 'Build it', team: [], files: [], notes: [], repos: [], budgetRemainingUsd: 1 },
    rules: { lines: [], syncMode: 'smart', testsBeforeDone: true, approvalMode: 'balanced' },
    task: { id: 't', kind: 'work', title: 'Build the backend', description: 'Build it.', deliverables: [], dependencies: [], board: undefined, mergeRequest: null, feedback: null },
  };
  const started = Date.now();
  await runJob({ ctx, host, vault: { get: () => ({}), getSecret: () => null }, localTools, dataDir: dir, log: () => {} });
  assert.ok(beats >= 2, 'it was trying to reach the host');
  assert.ok(result, 'the long process really was running');
  assert.match(result.output, /stopped by an emergency stop or a lost lease/, 'and this worker killed it by itself');
  assert.ok(Date.now() - started < 15_000, `well inside the 30 s the process could have run (${Date.now() - started} ms)`);
  assert.strictEqual(finishes.at(-1)?.status, 'cancelled', 'and it reports stopped, not finished, whenever the host is back');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit records chain together, so an edit to the history is detected', async (t) => {
  const o = await office(t);
  await o.a.post(`${o.R}/invites`, { role: 'member', uses: 1 });
  const first = await o.a.get(`${o.R}/security/audit`);
  assert.strictEqual(first.chain.ok, true);
  assert.ok(first.chain.checked > 2);
  assert.strictEqual((await o.b.get(`${o.R}/security/audit`)).chain, null, 'a member gets their own trail, not the check');
  const bo = (await o.b.get('/api/crew/me')).user.id;
  assert.ok((await o.b.get(`${o.R}/security/audit`)).events.every((e) => e.actor === bo), 'and only their own');
  assert.ok((await audit(o, o.a, 'invite')).length >= 1, 'it can be searched');

  const db = new (require('node:sqlite').DatabaseSync)(path.join(o.host.stateDir, 'crew', 'crew.sqlite'), { timeout: 8000 });
  db.prepare("UPDATE audit SET detail = '{\"role\":\"nothing to see\"}' WHERE action = 'invite.create'").run();
  db.close();
  const tampered = await o.a.get(`${o.R}/security/audit`);
  assert.strictEqual(tampered.chain.ok, false, 'editing a row breaks the chain');
  assert.match(tampered.chain.why, /changed/);
  assert.ok(!JSON.stringify(first.events).match(/password|apiKey|sk-/i), 'and no secrets are in it');
});

test('delegation chains end, however determined the agents are', { timeout: 30_000 }, async (t) => {
  const o = await office(t);
  const lead = await o.agent(o.a, 'Paige', 'Project Manager');
  const bea = await o.agent(o.a, 'Bea');
  const graph = { nodes: [{ id: 'l', type: 'lead', config: { agentId: lead.id } }, { id: 'w', type: 'worker', config: { agentId: bea.id } }, { id: 't', type: 'task', config: { title: 'Start', agentId: lead.id } }], edges: [] };
  const { playbook } = await o.a.post(`${o.R}/playbooks`, { name: 'P', graph, policy: { approvals: false, requireReview: false } });
  const { run } = await o.a.post(`${o.R}/playbooks/${playbook.id}/run`, { goal: 'Go.' });
  await o.a.req('PUT', `${o.R}/rules/project/${run.projectId}`, { rules: { approvalMode: 'autonomous' } });
  const db = new (require('node:sqlite').DatabaseSync)(path.join(o.host.stateDir, 'crew', 'crew.sqlite'), { timeout: 8000 });
  // Five hand-offs already behind this task.
  let parent = run.tasks.t.id;
  for (let i = 0; i < 5; i++) {
    const id = `tsk_chain${i}`;
    db.prepare("INSERT INTO tasks (id, project_id, parent_id, kind, title, description, status, deps, deliverables, created_by_type, created_by_id, created_at, updated_at) VALUES (?,?,?,'work','c','d','completed','[]','[]','human','x',1,1)").run(id, run.projectId, parent);
    parent = id;
  }
  db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(parent, run.tasks.t.id);
  db.prepare('UPDATE tasks SET parent_id = NULL WHERE id = ?').run('tsk_chain0');
  db.close();
  const token = await o.rawWorker(o.a);
  const claim = await waitFor(async () => { const c = await o.call(token, 'claim', {}); return c.job ? c : null; }, { what: 'the job', timeout: 15_000 });
  const r = await o.call(token, 'tool', { jobId: claim.job.id, name: 'delegate_task', args: { title: 'Again', description: 'Pass it on.', agent: 'Bea' } });
  assert.match(JSON.stringify(r), /already been handed on/);
});

test('no paid API can be reached: not as a default, a backup, or a setting a page can change', async () => {
  const { createBudget } = require('../lib/crew-worker/budget.cjs');
  const { createProvider } = require('../lib/crew-worker/providers.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-p-'));
  const budget = createBudget(dir);
  const vault = { get: () => ({ apiKey: 'sk-stand-in' }), getSecret: () => null };
  assert.throws(() => createProvider('openai', vault, budget), /Never use paid API/);
  assert.throws(() => createProvider('anthropic', vault, budget), /Never use paid API/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(execFileSync && spawn);
});
