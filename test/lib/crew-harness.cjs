// Test harness for the multiplayer office: a real server.cjs child process, players with
// cookie jars, open realtime streams (presence), and in-process workers.

'use strict';

// The tests' two players share this computer and run each other's code, so they accept the weaker
// sandbox on purpose. test/crew-security.test.cjs turns this off to check the refusal itself.
process.env.CREW_ALLOW_WEAK_SANDBOX ??= '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { player, startWorker } = require('../../lib/crew/demo-kit.cjs');

const ROOT = path.join(__dirname, '..', '..');

async function startHost({ stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-host-')), port = 8300 + Math.floor(Math.random() * 600), env = {} } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs'), String(port)], {
    cwd: ROOT, env: { ...process.env, ROVING_OFFICE_STATE_DIR: stateDir, CREW_LAN: '0', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${url}/api/crew/host-info`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited:\n${out}`);
    await sleep(100);
  }
  return {
    url, stateDir, port, child, log: () => out,
    // A process ended by a signal has a null exitCode for ever, so that alone would wait for an
    // exit that has already happened.
    async stop() { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 60_000, every = 250, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

module.exports = { startHost, player, startWorker, waitFor, sleep };
