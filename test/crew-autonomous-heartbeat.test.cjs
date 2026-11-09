// An autonomous Claude Code run keeps its hold on the job for as long as it works. It once sent no
// heartbeat at all, so every autonomous task longer than the lease was taken back by the office
// after its work was done, and the work was refused.

'use strict';

// Before the runner loads: it reads these once.
process.env.CREW_HEARTBEAT_MS = '50';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJob } = require('../lib/crew-worker/runner.cjs');

/** A stand-in for `claude` that works for `ms` milliseconds, then reports a finished result. */
function slowClaude(dir, ms) {
  const script = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(script, `
process.stdin.resume();
process.stdin.on('end', () => {});
setTimeout(() => {
  require('fs').writeFileSync('.crew/RESULT.md', 'Built it. Tests: ran them.');
  process.stdout.write(JSON.stringify({ type: 'result', result: 'finished', is_error: false }) + '\\n');
  process.exit(0);
}, ${ms});`);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}

function setup(t, { workMs, onHeartbeat = () => ({ ok: true }) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp_rovo_hb-'));
  const before = process.env.CREW_CLAUDE_CLI;
  process.env.CREW_CLAUDE_CLI = slowClaude(dir, workMs);
  t.after(() => {
    if (before === undefined) delete process.env.CREW_CLAUDE_CLI; else process.env.CREW_CLAUDE_CLI = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const seen = { heartbeats: 0, finished: null };
  const host = {
    async post(p, body) {
      if (p === '/api/crew/worker/heartbeat') { seen.heartbeats += 1; return onHeartbeat(seen.heartbeats); }
      if (p === '/api/crew/worker/finish') { seen.finished = body; return { ok: true }; }
      return { ok: true, result: { files: [] } };
    },
  };
  const ctx = {
    job: { id: 'job_hb', type: 'task' },
    agent: { id: 'agt_al', name: 'Al', role: 'Developer', skills: [], instructions: '', provider: 'claude-cli', model: 'default', freedom: { mode: 'autonomous', reach: 'project' } },
    room: { name: 'Office' },
    project: { id: 'prj_1', name: 'Cults', goal: 'A cult strategy game', repos: [], team: [] },
    tools: ['complete_task'],
    task: { kind: 'work', title: 'Godot foundation' },
  };
  const budget = { status: () => ({ autonomous: 'project' }), billingBlock: () => null };
  return { dir, host, ctx, budget, seen };
}

test('an autonomous run keeps telling the office it is working, for as long as it works', async (t) => {
  const { dir, host, ctx, budget, seen } = setup(t, { workMs: 600 });
  await runJob({ ctx, host, budget, localTools: { projectsDir: path.join(dir, 'Projects') }, dataDir: dir });
  assert.ok(seen.heartbeats >= 4, `it checked in ${seen.heartbeats} times during a run of 600 ms, every 50 ms`);
  const after = seen.heartbeats;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.heartbeats, after, 'and stops once the run is over');
});

test('when the office takes the job back, the autonomous run stops', async (t) => {
  const { dir, host, ctx, budget, seen } = setup(t, {
    workMs: 20_000,
    onHeartbeat: (n) => { if (n >= 2) throw Object.assign(new Error('This worker does not hold that job'), { status: 409 }); return { ok: true }; },
  });
  const started = Date.now();
  await runJob({ ctx, host, budget, localTools: { projectsDir: path.join(dir, 'Projects') }, dataDir: dir });
  assert.ok(Date.now() - started < 10_000, 'it did not run on to the end of a 20 s job');
  assert.notEqual(seen.finished?.status, 'done');
});
