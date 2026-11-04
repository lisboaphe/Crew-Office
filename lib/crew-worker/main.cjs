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
const { pendingHandoffs } = require('./handoff.cjs');
const { PROVIDERS } = require('../crew/catalog.cjs');

const dataDir = process.env.CREW_WORKER_DIR || path.join(os.homedir(), '.crew-worker');
const configFile = path.join(dataDir, 'worker.json');
const vault = createVault(dataDir);
const budget = createBudget(dataDir);
const providerStatus = createProviderStatus({ vault, budget });
const chatgpt = createChatgptPlan(vault);
const crash = createCrashLog({ dir: path.join(dataDir, 'crash-logs'), version: require('../../package.json').version, component: 'worker' });

const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return { connections: [] }; } };
const writeConfig = (c) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 }); };

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
    console.log('No room to connect to yet. In the office, open Dashboard → Workers → “Connect a worker”, then run the command it shows.');
  }
  const concurrency = Number(process.env.CREW_WORKER_CONCURRENCY || 3);
  const live = connections.map((c) => createConnection({
    hostUrl: c.host, token: c.token, vault, budget, providerStatus, dataDir, concurrency, crash,
    localToolsFor: (host) => createLocalTools({ dataDir, host }),
  }));
  for (const c of live) c.start();
  settingsPage(live);
  const stop = () => { for (const c of live) c.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** The worker's own page: sign-ins and keys in, status out. Loopback only; secrets are never displayed. */
function settingsPage(live) {
  const port = Number(process.env.CREW_WORKER_PORT || 8790);
  const page = path.join(__dirname, 'settings-page.html');
  providerStatus.refreshInstalled().catch(() => {});

  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // A web page elsewhere must not be able to drive this: no custom header without a
      // preflight we never answer, and the Host must be this machine.
      if (req.method === 'POST' && (req.headers['x-crew'] !== '1' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ''))) return send(res, 403, { error: 'Forbidden' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        body = raw ? JSON.parse(raw) : {};
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const states = providerStatus.all(Object.keys(PROVIDERS));
        const providers = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { ...v, label: PROVIDERS[k].label, billing: PROVIDERS[k].billing }]));
        return send(res, 200, { vault: vault.status(), connections: live.map((c) => c.status), crashLogs: crash.list().slice(0, 10), budget: budget.status(), providers, chatgpt: chatgpt.status(), handoffs: pendingHandoffs(dataDir) });
      }
      if (req.method === 'POST' && url.pathname === '/keys') {
        if (body.apiKey !== undefined) vault.set(body.provider, 'apiKey', String(body.apiKey).trim());
        if (body.baseUrl !== undefined) vault.set(body.provider, 'baseUrl', String(body.baseUrl).trim());
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/settings') {
        const st = budget.update(body);
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
      if (req.method === 'POST' && url.pathname === '/chatgpt/logout') { chatgpt.signOut(); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/handoff/done') {
        let lastError = 'No connected office knows this task.';
        for (const c of live) {
          try { await c.host.post('/api/crew/worker/resume', { jobId: body.jobId, kind: 'handoff' }); c.claimNow(); return send(res, 200, { ok: true }); } catch (err) { lastError = err.message; }
        }
        return send(res, 409, { error: lastError });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      return res.end(fs.readFileSync(page));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  server.on('error', (err) => console.log(`[worker] settings page off (${err.message})`));
  server.listen(port, '127.0.0.1', () => console.log(`[worker] settings page: http://127.0.0.1:${port}  (your sign-ins and keys stay on this machine)`));
}

main().catch((err) => { crash.record('worker main', err); process.exit(1); });
