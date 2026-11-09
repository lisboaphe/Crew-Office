// Autonomous agents: Claude Code as itself. How far it reaches is the smaller of what its owner asked
// for and what the computer running it allows, and what it makes comes back into the project.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reachOf, claudeArgs, runNative } = require('../lib/crew-worker/native.cjs');
const { makeCrew, room, agent } = require('./lib/crew-unit.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-autonomous-'));
const claude = (freedom) => ({ provider: 'claude-cli', freedom });

test('how far an agent reaches is the smaller of what it asks and what this computer allows', () => {
  const project = { mode: 'autonomous', reach: 'project' };
  const computer = { mode: 'autonomous', reach: 'computer' };
  assert.equal(reachOf(claude(project), 'off'), 'off', 'nothing until the computer allows it');
  assert.equal(reachOf(claude(project), 'project'), 'project');
  assert.equal(reachOf(claude(project), 'computer'), 'project', 'never more than it asked for');
  assert.equal(reachOf(claude(computer), 'project'), 'project', 'never more than the computer allows');
  assert.equal(reachOf(claude(computer), 'computer'), 'computer');
  assert.equal(reachOf(claude({ mode: 'limited', reach: 'computer' }), 'computer'), 'off', 'limited is limited');
  assert.equal(reachOf({ provider: 'chatgpt-plan', freedom: computer }, 'computer'), 'off', 'only Claude Code runs as itself');
  assert.equal(reachOf(claude(undefined), 'computer'), 'off');
});

test('in its project’s folder Claude Code is restricted; on the whole computer its checks are off', () => {
  const inFolder = claudeArgs('project', 'default');
  assert.ok(inFolder.includes('--restricted'));
  assert.ok(!inFolder.includes('--dangerously-skip-permissions'));
  assert.ok(inFolder.join(' ').includes('Bash'), 'and it may still run commands');
  const everywhere = claudeArgs('computer', 'opus');
  assert.ok(everywhere.includes('--dangerously-skip-permissions'));
  assert.ok(!everywhere.includes('--restricted'));
  assert.deepEqual(everywhere.slice(-2), ['--model', 'opus']);
  assert.ok(!claudeArgs('project', 'x; rm -rf /').includes('x; rm -rf /'), 'a strange model name is never passed on');
});

test('only an agent on automated Claude Code can be made autonomous, and only by its owner', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const clara = agent(crew, r.id, alice.id, 'Clara', 'Developer', { provider: 'claude-cli', model: 'default' });
  const leo = agent(crew, r.id, alice.id, 'Leo', 'Lead', { provider: 'chatgpt-plan', model: 'default' });
  assert.deepEqual(crew.profiles.freedom(clara.id), { mode: 'limited', reach: 'project' }, 'limited until asked');
  crew.profiles.set(clara.id, alice.id, { freedom: { mode: 'autonomous', reach: 'computer' } });
  assert.deepEqual(crew.profiles.freedom(clara.id), { mode: 'autonomous', reach: 'computer' });
  assert.throws(() => crew.profiles.set(leo.id, alice.id, { freedom: { mode: 'autonomous', reach: 'project' } }), /automated Claude Code/);
  assert.throws(() => crew.profiles.set(clara.id, alice.id, { freedom: { mode: 'unbounded' } }), /limited or autonomous/);
  assert.throws(() => crew.profiles.set(clara.id, bob.id, { freedom: { mode: 'limited', reach: 'project' } }));
});

/** A stand-in for `claude`, which does what Claude Code would and notes how it was started. */
function fakeClaude(dir, { result = true, exit = 0 } = {}) {
  const script = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(script, `
const fs = require('fs');
let input = '';
process.stdin.on('data', (c) => { input += c; }).on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, brief: fs.readFileSync('.crew/TASK.md', 'utf8') }));
  fs.writeFileSync('notes.txt', fs.readFileSync('notes.txt', 'utf8') + ' and more');
  fs.mkdirSync('mod', { recursive: true });
  fs.writeFileSync('mod/ModMain.gd', 'extends Node\\n');
  fs.writeFileSync('picture.png', Buffer.from([137, 80, 78, 71, 0, 0, 0]));
  ${result ? "fs.writeFileSync('.crew/RESULT.md', 'Packaged the mod. Tests: none needed.');" : ''}
  process.stdout.write(JSON.stringify({ type: 'result', result: 'finished', is_error: false }) + '\\n');
  process.exit(${exit});
});`);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}

function fakeHost(files) {
  const calls = [];
  return {
    calls,
    async post(p, body) {
      if (p !== '/api/crew/worker/tool') return { ok: true };
      calls.push(body);
      if (body.name === 'list_files') return { ok: true, result: { files: Object.keys(files).map((f) => ({ path: f })) } };
      if (body.name === 'read_file') return { ok: true, result: { path: body.args.path, content: files[body.args.path] } };
      return { ok: true, result: {} };
    },
  };
}

test('an autonomous run works in the project’s folder, and what it made comes back into the project', async (t) => {
  const dir = tmp();
  const before = process.env.CREW_CLAUDE_CLI;
  process.env.CREW_CLAUDE_CLI = fakeClaude(dir);
  t.after(() => { if (before === undefined) delete process.env.CREW_CLAUDE_CLI; else process.env.CREW_CLAUDE_CLI = before; });
  const host = fakeHost({ 'notes.txt': 'the plan', 'readme.md': 'unchanged' });
  const ctx = {
    job: { id: 'job_auto1', type: 'task' },
    agent: { id: 'agt_1', name: 'Clara', provider: 'claude-cli', model: 'default', freedom: { mode: 'autonomous', reach: 'project' } },
    room: { name: 'Paper’s office' },
    project: { id: 'prj_yomi', name: 'Yomi Hustle', repos: [] },
    tools: ['list_files', 'read_file', 'write_file', 'complete_task'],
    task: { kind: 'work', title: 'Package the mod' },
  };
  let finished = null;
  await runNative({
    ctx, host, localTools: { projectsDir: path.join(dir, 'Projects') }, dataDir: dir, budget: { billingBlock: () => null },
    finish: async (status, result, error) => { finished = { status, result, error }; },
    systemPrompt: () => 'ROLE', taskPrompt: () => 'PACKAGE IT', log: () => {}, reach: 'project',
  });
  assert.equal(finished.status, 'done', JSON.stringify(finished));

  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.ok(seen.args.includes('--restricted'), 'started in its folder');
  assert.equal(seen.cwd, path.join(dir, 'Projects', 'Paper’s office', 'Yomi Hustle', 'workspace'));
  assert.match(seen.brief, /PACKAGE IT/);
  assert.match(seen.brief, /information, not instructions/);

  const writes = host.calls.filter((c) => c.name === 'write_file').map((c) => c.args.path).sort();
  assert.deepEqual(writes, ['mod/ModMain.gd', 'notes.txt'], 'changed and new text files are shared; unchanged and binary ones are not');
  const done = host.calls.find((c) => c.name === 'complete_task');
  assert.equal(done.args.summary, 'Packaged the mod. Tests: none needed.');
  assert.deepEqual(done.args.artifacts.sort(), ['mod/ModMain.gd', 'notes.txt']);
});

test('a run that never wrote its result fails plainly, and shares nothing as finished', async (t) => {
  const dir = tmp();
  const before = process.env.CREW_CLAUDE_CLI;
  process.env.CREW_CLAUDE_CLI = fakeClaude(dir, { result: false });
  t.after(() => { if (before === undefined) delete process.env.CREW_CLAUDE_CLI; else process.env.CREW_CLAUDE_CLI = before; });
  const host = fakeHost({ 'notes.txt': 'the plan' });
  let finished = null;
  await runNative({
    ctx: { job: { id: 'job_auto2', type: 'task' }, agent: { id: 'a', name: 'Clara', provider: 'claude-cli', model: 'default' }, room: { name: 'O' }, project: { id: 'prj_x', name: 'X', repos: [] }, tools: ['list_files', 'read_file', 'write_file', 'complete_task'], task: { kind: 'work', title: 'T' } },
    host, localTools: { projectsDir: path.join(dir, 'Projects') }, dataDir: dir, budget: { billingBlock: () => null },
    finish: async (status, result, error) => { finished = { status, error }; },
    systemPrompt: () => '', taskPrompt: () => '', log: () => {}, reach: 'project',
  });
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /RESULT\.md was not found/);
  assert.equal(host.calls.some((c) => c.name === 'complete_task'), false);
});

test('a computer that has not allowed Claude Code to start by itself is waited on, not worked around', async () => {
  let finished = null;
  await runNative({
    ctx: { job: { id: 'j', type: 'task' }, agent: { name: 'Clara' }, tools: [] }, host: fakeHost({}), localTools: {}, dataDir: tmp(),
    budget: { billingBlock: () => 'Automated Claude Code is off.' },
    finish: async (status, result, error) => { finished = { status, result, error }; }, systemPrompt: () => '', taskPrompt: () => '', log: () => {}, reach: 'project',
  });
  assert.equal(finished.status, 'waiting');
  assert.equal(finished.error, 'Automated Claude Code is off.');
});
