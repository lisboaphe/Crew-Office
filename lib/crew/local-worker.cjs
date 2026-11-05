// The worker on the computer that hosts the office, run for its owner with no terminal.
//
// This is a convenience of the host's own app. It changes nothing about where work runs: the
// worker is still the owner's separate process with the owner's sign-ins, and the token below
// goes straight to it rather than through a page. A player on another computer runs their own.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, '..', '..', 'bin', 'crew-worker.cjs');

function createLocalWorker(crew) {
  let child = null;
  const port = () => Number(process.env.CREW_WORKER_PORT || 8790);
  const base = () => `http://127.0.0.1:${port()}`;
  const hostUrl = () => `http://localhost:${crew.port()}`;

  async function running() {
    try { return (await fetch(`${base()}/status`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }

  function launch(args = []) {
    const dir = process.env.CREW_WORKER_DIR || path.join(os.homedir(), '.crew-worker');
    fs.mkdirSync(dir, { recursive: true });
    const out = fs.openSync(path.join(dir, 'worker.log'), 'a');
    // From its own folder: a worker sitting in the app's folder would block an update.
    child = spawn(process.execPath, [WORKER, ...args], { cwd: dir, stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    child.on('exit', () => { child = null; });
  }

  async function waitUntilUp() {
    for (let i = 0; i < 40; i++) {
      if (await running()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** Make a worker for this office, and put it to work on this computer. */
  async function startFor(roomId, userId, { name = 'This computer', alwaysOn = false } = {}) {
    const worker = crew.workers.mint(roomId, userId, { name, alwaysOn });
    if (await running()) {
      const res = await fetch(`${base()}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: JSON.stringify({ host: hostUrl(), token: worker.token }) });
      if (!res.ok) throw new Error('The worker already running here would not take this office.');
    } else {
      launch(['--host', hostUrl(), '--token', worker.token]);
      if (!await waitUntilUp()) throw new Error('The worker did not start. See worker.log in its folder.');
    }
    return { worker: { id: worker.id, name: worker.name }, page: base() };
  }

  /** The app is opening, and this computer's worker has offices it remembers. */
  async function startRemembered() {
    if (await running()) return;
    const dir = process.env.CREW_WORKER_DIR || path.join(os.homedir(), '.crew-worker');
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'), 'utf8'));
      if (config.connections?.length) launch();
    } catch { /* never had a worker here */ }
  }

  /** Only one this office started: a worker somebody ran by hand is theirs to stop. */
  function stop() { try { child?.kill(); } catch { /* already gone */ } }

  return { startFor, startRemembered, stop, running };
}

module.exports = { createLocalWorker };
