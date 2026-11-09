// A worker's connection to one room host: authenticate, listen for nudges, claim jobs for
// its owner's agents, run them, and keep going across disconnects.
//
// The worker initiates every connection — the host never dials in — so a worker behind a
// home router, a laptop on café Wi-Fi or a VPN client needs no open port of its own. Only
// the room host must be reachable.

'use strict';

const health = require('./health.cjs');
const { runJob } = require('./runner.cjs');
const { PROVIDERS } = require('../crew/catalog.cjs');

const PROVIDER_NAMES = Object.keys(PROVIDERS);

function createHostClient(hostUrl, token) {
  const base = hostUrl.replace(/\/+$/, '');
  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(200_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
  }
  async function putRaw(path, bytes, headers = {}) {
    const res = await fetch(base + path, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...headers }, body: bytes, signal: AbortSignal.timeout(120_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
  }
  return { base, token, get: (p) => request('GET', p), post: (p, b) => request('POST', p, b ?? {}), putRaw };
}

function createConnection({ isLocallyStopped = () => false, hostUrl, token, vault, budget = null, providerStatus = null, localToolsFor, dataDir, concurrency = 3, log = console.log, crash, onRefused = null }) {
  const host = createHostClient(hostUrl, token);
  const localTools = localToolsFor(host);
  let running = 0;
  let stopped = false;
  let claiming = false;
  let identity = null;
  let poll = null;
  let streamAbort = null;
  const runningJobs = new Set();
  const status = { host: host.base, connected: false, room: null, user: null, running: 0, lastError: null, completed: 0 };

  // The office no longer knows this worker's token: it was removed there, or the office is gone.
  // That never comes right by waiting, so the connection ends instead of retrying for ever.
  const isRefusal = (err) => err.status === 401 && /worker token/i.test(err.message);
  function refused(err) {
    status.connected = false;
    status.refused = true;
    status.lastError = err.message;
    log(`[worker] ${host.base} no longer knows this worker (${err.message}); forgetting this connection.`);
    stop();
    onRefused?.();
  }

  async function start() {
    try {
      identity = await host.get('/api/crew/worker/whoami');
      status.room = identity.room;
      status.user = identity.user;
      status.connected = true;
      status.lastError = null;
      log(`[worker] connected to “${identity.room.name}” (${identity.room.code}) at ${host.base} as ${identity.user.displayName}${identity.alwaysOn ? ' — always-on' : ''}`);
      log(`[worker] agents served here: ${identity.agents.map((a) => `${a.name} (${a.provider}/${a.model})`).join(', ') || 'none yet'}`);
      reportProviders();
      setInterval(reportProviders, 60_000).unref?.();
    } catch (err) {
      if (isRefusal(err)) { refused(err); return; }
      status.connected = false;
      status.lastError = err.message;
      log(`[worker] cannot reach ${host.base}: ${err.message}. Retrying in 10 s.`);
      if (!stopped) setTimeout(start, 10_000).unref?.();
      return;
    }
    listen();
    poll = setInterval(claimLoop, 5000);
    claimLoop();
  }

  /** The room learns each connection's state and nothing else about it. */
  const sentStates = {};
  async function reportProviders() {
    if (!providerStatus || stopped) return;
    try {
      await providerStatus.refreshInstalled();
      const providers = providerStatus.all(PROVIDER_NAMES);
      await host.post('/api/crew/worker/providers', { providers });
      for (const [k, v] of Object.entries(providers)) sentStates[k] = v.state;
    } catch { /* the next round will do */ }
  }
  // An AI that starts or stops working during a task is told now, not at the next minute's report.
  const stopHearing = health.listen((provider) => {
    if (!providerStatus || stopped || !status.connected) return;
    if (providerStatus.state(provider).state !== sentStates[provider]) reportProviders();
  });

  /** The host's nudge stream. It also keeps this worker marked online. */
  async function listen() {
    while (!stopped) {
      try {
        streamAbort = new AbortController();
        const res = await fetch(`${host.base}/api/crew/worker/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: streamAbort.signal });
        if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
        status.connected = true;
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^event: jobs/m.test(frame)) claimLoop();
            if (/^event: stop/m.test(frame)) stopRunning('emergency stop from the office');
          }
        }
      } catch (err) {
        if (stopped) return;
        status.connected = false;
        status.lastError = err.message;
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async function claimLoop() {
    if (claiming || stopped || isLocallyStopped()) return;
    claiming = true;
    try {
      while (running < concurrency && !stopped) {
        const got = await host.post('/api/crew/worker/claim', { blockedProviders: budget ? budget.blockedProviders(PROVIDER_NAMES) : [] });
        if (!got.job) break;
        running++;
        status.running = running;
        log(`[worker] ${got.context.agent.name}: ${got.job.type}${got.context.task ? ` “${got.context.task.title}”` : ''}`);
        const control = new AbortController();
        runningJobs.add(control);
        runJob({ ctx: got.context, host, vault, budget, localTools, dataDir, log, stop: control })
          .catch((err) => crash?.record('runJob', err))
          .finally(() => { runningJobs.delete(control); running--; status.running = running; status.completed++; claimLoop(); });
      }
      status.connected = true;
    } catch (err) {
      status.lastError = err.message;
      if (isRefusal(err)) refused(err);
      else if (err.status === 401 || err.status === 403) { log(`[worker] ${host.base} refused this worker: ${err.message}`); stop(); }
    } finally {
      claiming = false;
    }
  }

  /** Stops what is running now: sandboxes die, and each job ends at its next step. */
  function stopRunning(why) {
    log(`[worker] stopping ${runningJobs.size} running job(s): ${why}`);
    for (const c of runningJobs) c.abort(why);
  }

  function stop() {
    stopped = true;
    stopHearing();
    stopRunning('this worker is stopping');
    if (poll) clearInterval(poll);
    streamAbort?.abort();
  }

  return { start, stop, stopRunning, status, host, claimNow: claimLoop, reportProviders };
}

module.exports = { createConnection, createHostClient };
