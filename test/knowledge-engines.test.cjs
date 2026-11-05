// The real Graphify and the real Mem0, where they are installed. Everything else about them is tested
// with stand-ins in crew-knowledge.test.cjs; this is what shows the stand-ins tell the truth.
//
// CREW_TEST_ENGINES=1 turns a missing engine into a failure rather than a skip, so a run that set out
// to test them (.github/workflows/knowledge-engines.yml) cannot quietly test nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { makeCrew, room, agent } = require('./lib/crew-unit.cjs');
const { waitFor } = require('./lib/crew-harness.cjs');

const required = process.env.CREW_TEST_ENGINES === '1';
const works = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true }).status === 0; } catch { return false; } };
const hasGraphify = works(process.env.CREW_GRAPHIFY_CMD || 'graphify', ['--version']);
const python = [process.env.CREW_PYTHON, 'python3', 'python'].filter(Boolean).find((p) => works(p, ['-c', 'import mem0, fastembed']));
const skipGraphify = hasGraphify || required ? false : 'Graphify is not installed here';
const skipMem0 = python || required ? false : 'Mem0 and fastembed are not installed here';
const MODEL = process.env.CREW_TEST_EMBEDDING_MODEL || 'BAAI/bge-small-en-v1.5';
const TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'git'];

function setup(t) {
  const { crew, close, dataDir } = makeCrew();
  t.after(close);
  const r = room(crew);
  const a = agent(crew, r.room.id, r.alice.id, 'Paige', 'PM', { isManager: true, tools: TOOLS });
  const { id } = crew.work.createProject(r.room.id, r.alice.id, { name: 'Web', goal: 'g', managerAgentId: a.id });
  crew.work.joinProject(r.room.id, r.bob.id, id);
  return { crew, dataDir, ...r, a, p: crew.work.getProject(id) };
}

function commitFiles(crew, repo, branch, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-br-'));
  const bare = crew.git.gitDir(repo);
  execFileSync('git', ['clone', '--quiet', bare, dir]);
  execFileSync('git', ['config', 'user.email', 'a@x'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir });
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
  execFileSync('git', ['add', '-A', '-f'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'files'], { cwd: dir });
  execFileSync('git', ['--git-dir', bare, 'fetch', '--quiet', dir, `HEAD:refs/heads/${branch}`]);
}

test('real Graphify maps merged code, code-only, and rebuilds after a merge', { skip: skipGraphify, timeout: 240_000 }, async (t) => {
  const { crew, room: rm, alice, p } = setup(t);
  const repo = crew.git.get(crew.git.create(rm.id, alice.id, p.id, { name: 'web' }).id);
  const graphs = crew.knowledge.graphs;
  assert.strictEqual((await graphs.refresh()).installed, true);
  commitFiles(crew, repo, 'agent/paige/one', {
    'src/db.js': 'function connectDatabase() { return 1; }\nmodule.exports = { connectDatabase };\n',
    'src/server.js': "const { connectDatabase } = require('./db');\nfunction startServer() { return connectDatabase(); }\nmodule.exports = { startServer };\n",
    '.env': 'DATABASE_URL=postgres://user:hunter2@host/db\n',
  });
  crew.git.merge(repo, 'agent/paige/one', { by: {}, message: 'one' });
  crew.knowledge.setSettings(p, alice.id, { graphify: true });
  await waitFor(() => ['ready', 'failed'].includes(graphs.info(repo).state), { what: 'the first build', timeout: 180_000 });
  assert.strictEqual(graphs.info(repo).state, 'ready', graphs.info(repo).error);

  const g = graphs.read(repo.id);
  assert.ok(g.nodes.some((n) => /startServer/.test(n.label)), `labels: ${g.nodes.map((n) => n.label).join(', ')}`);
  assert.ok(g.nodes.some((n) => /connectDatabase/.test(n.label)));
  assert.ok(g.edges.length > 0);
  const text = JSON.stringify(g);
  assert.ok(!text.includes('hunter2') && !text.includes('DATABASE_URL') && !text.includes('.env'), 'the secret file was never read');
  assert.ok(!text.includes(os.tmpdir().replace(/\\/g, '/')), 'no path from this computer');
  const server = g.nodes.find((n) => /startServer/.test(n.label));
  assert.strictEqual(server.file, 'src/server.js');
  assert.ok(graphs.query(repo.id, 'startServer').matches.length > 0);
  assert.strictEqual(graphs.info(repo).commit, crew.git.branchHead(repo, 'main'));

  // A merge moves it on, and something deleted leaves the graph.
  commitFiles(crew, repo, 'agent/paige/two', { 'src/extra.js': 'function brandNewThing() { return 2; }\nmodule.exports = { brandNewThing };\n' });
  crew.git.merge(repo, 'agent/paige/two', { by: {}, message: 'two' });
  await waitFor(() => graphs.info(repo).state === 'ready' && graphs.info(repo).commit === crew.git.branchHead(repo, 'main'), { what: 'the rebuild', timeout: 180_000 });
  assert.ok(graphs.read(repo.id).nodes.some((n) => /brandNewThing/.test(n.label)));
});

test('real Mem0 stores locally, finds by meaning, keeps scopes apart, and forgets', { skip: skipMem0, timeout: 600_000 }, async (t) => {
  if (python) process.env.CREW_PYTHON = python;
  const { crew, dataDir, room: rm, alice, bob, p } = setup(t);
  const k = crew.knowledge;
  k.setMem0Model({ provider: 'fastembed', model: MODEL });
  k.setSettings(p, alice.id, { mem0: true });
  const status = (await k.checkEngines()).mem0;
  assert.strictEqual(status.ready, true, status.reason);

  const shared = k.add(rm.id, k.person(alice.id), { scope: 'project', projectId: p.id, title: 'Payments', body: 'Customers pay by credit card through the checkout service.' });
  const other = k.add(rm.id, k.person(alice.id), { scope: 'project', projectId: p.id, title: 'Weather', body: 'It often rains in the mountains during spring.' });
  const hers = k.add(rm.id, k.person(alice.id), { scope: 'user', projectId: p.id, title: 'Alice only', body: 'My own note about billing and invoices.' });
  await waitFor(() => crew.db.get('SELECT COUNT(*) AS n FROM memory WHERE mem0_id IS NOT NULL').n === 3, { what: 'all three in Mem0', timeout: 500_000 });
  assert.ok(fs.existsSync(path.join(dataDir, 'knowledge', 'mem0')), 'on this computer');

  // No word of this question appears in the right memory: only meaning can find it first.
  const found = await k.search(rm.id, k.person(bob.id), { query: 'how do people settle their bills?', projectId: p.id, limit: 5 });
  assert.strictEqual(found.engine, 'mem0', found.note);
  assert.strictEqual(found.memories[0].id, shared.id, `first was: ${found.memories[0]?.title}`);
  assert.ok(!found.memories.some((r) => r.id === hers.id), 'Bob never gets Alice’s own');
  const herOwn = await k.search(rm.id, k.person(alice.id), { query: 'invoices', projectId: p.id, limit: 5 });
  assert.ok(herOwn.memories.some((r) => r.id === hers.id), 'Alice does');

  // Before the edit, nothing about this memory is near these words. If the new text was not embedded,
  // one of the others ranks first. It has to wait for the edit to arrive, which is asynchronous.
  const newText = 'Deliveries go out by bicycle courier every morning.';
  k.update(rm.id, alice.id, other.id, { title: 'Deliveries', body: newText });
  let moved = null;
  await waitFor(async () => {
    moved = await k.search(rm.id, k.person(alice.id), { query: `Deliveries ${newText}`, projectId: p.id, limit: 1 });
    return moved.memories[0]?.id === other.id;
  }, { what: `the edit to reach Mem0 (first was: ${moved?.memories[0]?.title})`, timeout: 30_000 });
  assert.strictEqual(moved.engine, 'mem0', moved.note);

  k.remove(rm.id, alice.id, shared.id);
  await new Promise((resolve) => { setTimeout(resolve, 2000); });
  const after = await k.search(rm.id, k.person(alice.id), { query: 'how do people settle their bills?', projectId: p.id, limit: 5 });
  assert.ok(!after.memories.some((r) => r.id === shared.id), 'removed is removed');
  k.stop();
});
