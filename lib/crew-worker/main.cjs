// The agent worker (entry point; bin/crew-worker.cjs and the Docker image both start here):
// runs YOUR agents, on YOUR machine, with YOUR API keys.
//
//   node bin/crew-worker.cjs --host http://192.168.1.20:8080 --token wk_…   connect (and remember it)
//   node bin/crew-worker.cjs                                                 run every remembered connection
//   node bin/crew-worker.cjs set-key anthropic|openai|local                  store a key (read from stdin)
//   node bin/crew-worker.cjs set-url openai|local <base url>                 e.g. http://127.0.0.1:11434/v1 for Ollama
//   node bin/crew-worker.cjs forget <host>                                   drop a remembered connection
//
// While it runs, http://127.0.0.1:8790 (CREW_WORKER_PORT) is a settings page for keys
// and connections. It listens on loopback only. Data lives in ~/.crew-worker
// (CREW_WORKER_DIR): the encrypted key vault, agents' private memory, job checkpoints,
// and crash logs.

'use strict';

// Settings from a .env beside the app, if there is one (see .env.example). Values
// already in the environment win.
try { process.loadEnvFile(require('path').join(__dirname, '..', '..', '.env')); } catch { /* no .env */ }

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createVault } = require('./vault.cjs');
const { createConnection } = require('./worker.cjs');
const { createLocalTools } = require('./local-tools.cjs');
const { createCrashLog } = require('../crew/crash.cjs');
const { createBudget } = require('./budget.cjs');
const { createProviderStatus } = require('./provider-status.cjs');
const { createChatgptPlan } = require('./chatgpt-plan.cjs');
const { pendingHandoffs, removeHandoff } = require('./handoff.cjs');
const { projectsRoot } = require('./project-folders.cjs');
const { PROVIDERS } = require('../crew/catalog.cjs');
const { createSetup } = require('./setup.cjs');
const { createQuota } = require('./quota.cjs');
const { setQuotaSink } = require('./cli-providers.cjs');
const { createConnections } = require('./ai-connections.cjs');
const { opencodeModels, kiroModels } = require('./cli-providers.cjs');

const dataDir = process.env.CREW_WORKER_DIR || path.join(os.homedir(), '.crew-worker');
const configFile = path.join(dataDir, 'worker.json');
const vault = createVault(dataDir);
// The fingerprint of the settings that decide what agents may do lives in the vault, whose key the
// operating system keeps for this user, so a settings file changed behind the worker's back is noticed.
const budget = createBudget(dataDir, { seal: { get: () => vault.getSecret('settingsSeal'), set: (v) => vault.setSecret('settingsSeal', v) } });
const { autonomousWorking } = require('./native.cjs');
const { GUARDED } = require('./budget.cjs');

/** Tells the owner, in every office this worker is in, that something about it changed. */
function tellOwner(text) {
  console.log(`[worker] ${text}`);
  for (const c of liveConnections) if (c.status.connected) c.host.post('/api/crew/worker/notice', { text }).catch(() => {});
}
const SETTING_NAMES = { neverPaidApi: 'Never use paid API', allowClaudeAutomation: 'Start Claude Code automatically', autonomous: 'Autonomous agents on this computer', allowWeakSandbox: 'Weaker sandbox', localStop: 'Agents stopped on this computer' };
if (budget.tampered()?.length) console.log(`[worker] the settings file was changed outside the worker; the safe settings were put back: ${budget.tampered().join(', ')}`);
const providerStatus = createProviderStatus({ vault, budget, dataDir });
const chatgpt = createChatgptPlan(vault);
// A warning its owner asked for is the one thing about usage that reaches a host, and only to them.
const liveConnections = [];
const quota = createQuota(dataDir, {
  onWarning: (w) => { for (const c of liveConnections) c.host.post('/api/crew/worker/notice', { text: `${PROVIDERS[w.provider]?.label ?? w.provider} has used ${Math.round(w.usedPercent)}% of its ${w.window} limit, as the provider reports it.` }).catch(() => {}); },
});
budget.useQuota(quota);
const connections = createConnections(dataDir, { vault, cliModels: (p) => (p === 'opencode' ? opencodeModels() : kiroModels()) });
budget.useConnections(connections);
setQuotaSink((provider, reading) => quota.record(provider, reading, budget.status().providers[provider]?.warnAt));
const setup = createSetup({ providerStatus, vault, budget, quota, connections });
const crash = createCrashLog({ dir: path.join(dataDir, 'crash-logs'), version: require('../../package.json').version, component: 'worker' });

const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return { connections: [] }; } };
const writeConfig = (c) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 }); };

/** Drops a connection from the saved list, so the next start does not try it again. */
function forgetConnection(host, token) {
  const c = readConfig();
  c.connections = c.connections.filter((x) => x.host !== host || x.token !== token);
  writeConfig(c);
}

function remember(host, token) {
  const c = readConfig();
  c.connections = c.connections.filter((x) => x.host !== host || x.token !== token);
  c.connections.push({ host, token });
  writeConfig(c);
}

async function readStdin(prompt) {
  process.stderr.write(prompt);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'set-key') {
    const provider = args[1];
    const value = await readStdin(`Paste the ${provider} API key, then press Enter and Ctrl-D (Ctrl-Z Enter on Windows): `);
    vault.set(provider, 'apiKey', value);
    console.log(`Saved the ${provider} key in ${dataDir} (encrypted).`);
    return;
  }
  if (args[0] === 'set-url') { vault.set(args[1], 'baseUrl', args[2]); console.log(`Saved ${args[1]} base URL.`); return; }
  if (args[0] === 'forget') {
    const c = readConfig();
    c.connections = c.connections.filter((x) => x.host !== args[1]);
    writeConfig(c);
    console.log('Forgotten.');
    return;
  }

  crash.install();
  const value = (name) => { const i = args.indexOf(name); if (i >= 0) return args[i + 1] ?? null; const eq = args.find((a) => a.startsWith(`${name}=`)); return eq ? eq.slice(name.length + 1) : null; };
  const hostArg = value('--host');
  const tokenArg = value('--token') ?? process.env.CREW_WORKER_TOKEN;
  if (hostArg && tokenArg) remember(hostArg, tokenArg);
  const connections = hostArg && tokenArg ? [{ host: hostArg, token: tokenArg }] : readConfig().connections;
  if (!connections.length) {
    console.log('No room to connect to yet. In the office, open Dashboard → My Crew → “Add a worker”, then run the command it shows.');
  }
  const concurrency = Number(process.env.CREW_WORKER_CONCURRENCY || 3);
  const live = liveConnections;
  const connect = (c) => {
    const conn = createConnection({
      hostUrl: c.host, token: c.token, vault, budget, providerStatus, dataDir, concurrency, crash, isLocallyStopped: () => budget.status().localStop,
      localToolsFor: (host) => createLocalTools({ dataDir, host, projectsDir: projectsRoot(dataDir) }),
      // Once each run: a settings file found changed behind the worker's back is news to its owner.
      onConnected: (host) => {
        const changed = budget.tampered();
        if (changed?.length) host.post('/api/crew/worker/notice', { text: `Your worker's settings file was changed outside the worker, so its safe settings were put back: ${changed.map((k) => SETTING_NAMES[k] ?? k).join(', ')}. Change them again on the worker's page if you meant to.` }).catch(() => {});
      },
      onRefused: () => {
        forgetConnection(c.host, c.token);
        const i = live.indexOf(conn);
        if (i >= 0) live.splice(i, 1);
      },
    });
    return conn;
  };
  live.push(...connections.map(connect));
  for (const c of live) c.start();
  // A running worker takes on another office without a restart.
  settingsPage(live, (hostUrl, token) => {
    remember(hostUrl, token);
    const c = connect({ host: hostUrl, token });
    live.push(c);
    c.start();
    return c.status;
  });
  const stop = () => { for (const c of live) c.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** The worker's own page: sign-ins and keys in, status out. Loopback only; secrets are never displayed. */
function settingsPage(live, addConnection) {
  const port = Number(process.env.CREW_WORKER_PORT || 8790);
  const page = path.join(__dirname, 'settings-page.html');
  providerStatus.refreshInstalled().catch(() => {});

  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const uiFiles = { 'common.js': 'text/javascript', 'connections.js': 'text/javascript', 'crew.css': 'text/css' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // The Host must be this machine, whatever the method: that stops a web page rebinding
      // its own hostname onto this port.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden' });
      // Only the app on this computer may read or drive this from another port. Not a remote
      // office's page: that is code from someone else's machine, and it could turn off
      // "Never use paid API". Players on a remote host use this worker's own page instead.
      const origin = req.headers.origin;
      if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Crew');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          res.writeHead(204);
          return res.end();
        }
      } else if (origin) return send(res, 403, { error: 'Forbidden' });
      // No custom header without a preflight, which is answered only above.
      if (req.method === 'POST' && req.headers['x-crew'] !== '1') return send(res, 403, { error: 'Forbidden' });
      if (req.method === 'GET' && url.pathname.startsWith('/ui/')) {
        const name = url.pathname.slice(4);
        if (!uiFiles[name]) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': `${uiFiles[name]}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(__dirname, '..', '..', 'crew', name)));
      }
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        body = raw ? JSON.parse(raw) : {};
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const states = providerStatus.all(Object.keys(PROVIDERS));
        const providers = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { ...v, label: PROVIDERS[k].label, billing: PROVIDERS[k].billing }]));
        return send(res, 200, { vault: vault.status(), connections: live.map((c) => c.status), crashLogs: crash.list().slice(0, 10), budget: budget.status(), providers, chatgpt: chatgpt.status(), handoffs: pendingHandoffs(dataDir), projectsRoot: projectsRoot(dataDir) });
      }
      if (req.method === 'GET' && url.pathname === '/setup/connections') return send(res, 200, await setup.connections());
      if (req.method === 'GET' && url.pathname === '/usage') {
        const b = budget.status();
        return send(res, 200, { reported: quota.all(), local: b.providers, neverPaidApi: b.neverPaidApi, tokenSaver: b.tokenSaver, savedChars: b.savedChars, keyStore: vault.storage() });
      }
      if (req.method === 'GET' && url.pathname === '/agent-memory') {
        const id = String(url.searchParams.get('agent') ?? '');
        if (!/^agt_[\w-]+$/.test(id)) return send(res, 400, { error: 'Bad agent.' });
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-memory', `${id}.json`), 'utf8')); } catch { /* none yet */ }
        return send(res, 200, { memory: Object.entries(mem).slice(-30).map(([key, v]) => ({ key, value: String(v.value ?? '') })) });
      }
      if (req.method === 'GET' && url.pathname === '/ai/models') {
        const provider = String(url.searchParams.get('provider'));
        const neverPaid = budget.status().neverPaidApi;
        if (!connections.def(provider)) return send(res, 404, { error: 'Unknown AI connection.' });
        if (url.searchParams.has('refresh')) await connections.discover(provider);
        return send(res, 200, connections.models(provider, { neverPaid }));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/ai/')) {
        const provider = String(body.provider);
        const d = connections.def(provider);
        if (!d) return send(res, 404, { error: 'Unknown AI connection.' });
        const neverPaid = budget.status().neverPaidApi;
        const changed = () => { providerStatus.forget(provider); for (const c of live) { c.reportProviders(); c.claimNow(); } };
        if (url.pathname === '/ai/connect') {
          for (const f of d.fields) if (body[f.name] !== undefined && String(body[f.name]).trim()) vault.set(provider, f.name, String(body[f.name]).trim());
          changed();
          // Listing proves the key where a service checks it there, and spends nothing.
          try { await connections.discover(provider); return send(res, 200, { ok: true, ...connections.models(provider, { neverPaid }) }); }
          catch (err) { return send(res, 200, { ok: false, reason: err.message }); }
        }
        if (url.pathname === '/ai/verify') { connections.verify(provider, String(body.class)); changed(); return send(res, 200, { ok: true }); }
        if (url.pathname === '/ai/unverify') { connections.unverify(provider); changed(); return send(res, 200, { ok: true }); }
        if (url.pathname === '/ai/choose') { connections.choose(provider, String(body.model), { neverPaid }); for (const c of live) c.reportProviders(); return send(res, 200, { ok: true }); }
        if (url.pathname === '/ai/allow-paid') {
          if (body.allowed && neverPaid) return send(res, 400, { error: 'Turn off “Never use paid API” first.' });
          if (body.allowed && autonomousWorking()) return send(res, 423, { error: 'Not while an autonomous agent is working. Try again when it has finished.' });
          connections.allowPaid(provider, Boolean(body.allowed));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/ai/disconnect') {
          vault.remove(provider);
          connections.disconnect(provider);
          changed();
          return send(res, 200, { ok: true, cli: Boolean(d.cli) });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'POST' && url.pathname === '/setup/install') return send(res, 200, await setup.install(String(body.tool)));
      if (req.method === 'POST' && url.pathname === '/setup/signin') return send(res, 200, setup.signIn(String(body.tool)));
      if (req.method === 'POST' && url.pathname === '/setup/local') {
        const r = setup.useLocal(String(body.runtime));
        for (const c of live) c.reportProviders();
        return send(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/connect') {
        if (!/^https?:\/\//.test(String(body.host)) || !/^wk_[\w-]+$/.test(String(body.token))) return send(res, 400, { error: 'That is not an office address and worker token.' });
        return send(res, 200, { status: addConnection(body.host, body.token) });
      }
      // The owner's own stop, which needs no host and survives a restart of this worker.
      if (req.method === 'POST' && url.pathname === '/stop') {
        budget.update({ localStop: body.stopped !== false });
        if (body.stopped !== false) for (const c of live) c.stopRunning('stopped on this computer');
        else for (const c of live) c.claimNow();
        return send(res, 200, { stopped: budget.status().localStop });
      }
      if (req.method === 'GET' && url.pathname === '/sandbox') return send(res, 200, { docker: require('./sandbox.cjs').dockerAvailable(), allowWeakSandbox: budget.status().allowWeakSandbox, localStop: budget.status().localStop });
      if (req.method === 'POST' && url.pathname === '/keys') {
        if (body.apiKey !== undefined) vault.set(body.provider, 'apiKey', String(body.apiKey).trim());
        if (body.baseUrl !== undefined) vault.set(body.provider, 'baseUrl', String(body.baseUrl).trim());
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/settings') {
        // Nothing that lets agents do more may change while an autonomous agent is working: it
        // could be the one asking. Turning things down always works.
        const before = { ...budget.settings() };
        let st;
        try { st = budget.update(body, { locked: autonomousWorking() > 0 }); } catch (err) {
          if (err.status === 423) { tellOwner(`A change to your worker's settings was refused: ${err.message}`); return send(res, 423, { error: err.message }); }
          throw err;
        }
        const changed = GUARDED.filter((k) => before[k] !== budget.settings()[k]);
        if (changed.length) tellOwner(`Your worker's settings changed: ${changed.map((k) => `${SETTING_NAMES[k] ?? k} is now ${JSON.stringify(budget.settings()[k])}`).join('; ')}.`);
        for (const c of live) { c.reportProviders(); c.claimNow(); }
        return send(res, 200, st);
      }
      if (req.method === 'POST' && url.pathname === '/test') {
        const r = await providerStatus.test(String(body.provider), body.model);
        for (const c of live) c.reportProviders();
        return send(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/chatgpt/login') {
        const { url: signIn, done } = chatgpt.startLogin();
        done.then(() => { for (const c of live) c.reportProviders(); }).catch(() => {});
        return send(res, 200, { url: signIn });
      }
      if (req.method === 'POST' && url.pathname === '/chatgpt/logout') { chatgpt.signOut(); providerStatus.forget('chatgpt-plan'); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/handoff/done') {
        const answers = [];
        for (const c of live.filter((x) => x.status.connected)) {
          try { await c.host.post('/api/crew/worker/resume', { jobId: body.jobId, kind: 'handoff' }); c.claimNow(); return send(res, 200, { ok: true }); } catch (err) { answers.push(err); }
        }
        // Every office this worker is in said it has no such task, or none is connected to ask.
        const gone = answers.length && answers.every((e) => e.status === 404);
        const error = !answers.length ? 'No office is connected right now. Start the office this task came from, then press Done again.'
          : gone ? 'None of your offices has this task any more: its office or project was deleted, or the task was cancelled. Press Remove to take it off this list.'
            : answers.find((e) => e.status !== 404)?.message ?? answers[0].message;
        return send(res, 409, { error, gone: Boolean(gone) });
      }
      if (req.method === 'POST' && url.pathname === '/handoff/remove') {
        return removeHandoff(dataDir, String(body.jobId ?? '')) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such handoff.' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      return res.end(fs.readFileSync(page));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  server.on('error', (err) => console.log(`[worker] settings page off (${err.message})`));
  server.listen(port, '127.0.0.1', () => console.log(`[worker] settings page: http://127.0.0.1:${port}  (your sign-ins and keys stay on this machine)`));
}

main().catch((err) => { crash.record('worker main', err); process.exit(1); });
