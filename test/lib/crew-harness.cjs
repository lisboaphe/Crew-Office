// Test harness for the multiplayer office: a real server.cjs child process, players with
// cookie jars, open realtime streams (presence), and in-process workers.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createConnection } = require('../../lib/crew-worker/worker.cjs');
const { createLocalTools } = require('../../lib/crew-worker/local-tools.cjs');
const { createVault } = require('../../lib/crew-worker/vault.cjs');

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
    async stop() { if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); } },
  };
}

function player(url) {
  let cookie = '';
  const streams = [];
  async function req(method, p, body) {
    const res = await fetch(url + p, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-Crew': '1', 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  return {
    req,
    async text(p) { const res = await fetch(url + p, { headers: cookie ? { Cookie: cookie } : {} }); return { status: res.status, text: await res.text() }; },
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    patch: (p, b) => req('PATCH', p, b ?? {}),
    del: (p) => req('DELETE', p),
    /** Open the room's realtime stream: this is the player "being in the office". */
    async enter(roomId) {
      const ac = new AbortController();
      const events = [];
      const res = await fetch(`${url}/api/crew/rooms/${roomId}/events`, { headers: { Cookie: cookie }, signal: ac.signal });
      (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, i); buf = buf.slice(i + 2);
              const ev = frame.match(/^event: (.+)$/m)?.[1];
              const data = frame.match(/^data: (.+)$/m)?.[1];
              if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
            }
          }
        } catch {}
      })();
      const s = { events, leave: () => ac.abort() };
      streams.push(s);
      return s;
    },
    leaveAll() { for (const s of streams) s.leave(); },
  };
}

function startWorker({ hostUrl, token, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-worker-')), secrets = {} }) {
  const vault = createVault(dir);
  for (const [p, v] of Object.entries(secrets)) vault.set(p, 'apiKey', v);
  const conn = createConnection({ hostUrl, token, vault, dataDir: dir, concurrency: 4, log: () => {}, localToolsFor: (host) => createLocalTools({ dataDir: dir, host }) });
  conn.start();
  return { conn, dir, stop: () => conn.stop() };
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
