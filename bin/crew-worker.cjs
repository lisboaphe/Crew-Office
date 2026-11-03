#!/usr/bin/env node
// The agent worker: runs YOUR agents, on YOUR machine, with YOUR API keys.
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createVault } = require('../lib/crew-worker/vault.cjs');
const { createConnection } = require('../lib/crew-worker/worker.cjs');
const { createLocalTools } = require('../lib/crew-worker/local-tools.cjs');
const { createCrashLog } = require('../lib/crew/crash.cjs');
const { flags } = require('./lib/cli-flags.cjs');

const dataDir = process.env.CREW_WORKER_DIR || path.join(os.homedir(), '.crew-worker');
const configFile = path.join(dataDir, 'worker.json');
const vault = createVault(dataDir);
const crash = createCrashLog({ dir: path.join(dataDir, 'crash-logs'), version: require('../package.json').version, component: 'worker' });

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
  const { value } = flags(args);
  const hostArg = value('--host');
  const tokenArg = value('--token') ?? process.env.CREW_WORKER_TOKEN;
  if (hostArg && tokenArg) remember(hostArg, tokenArg);
  const connections = hostArg && tokenArg ? [{ host: hostArg, token: tokenArg }] : readConfig().connections;
  if (!connections.length) {
    console.log('No room to connect to yet. In the office, open Dashboard → Workers → “Connect a worker”, then run the command it shows.');
  }
  const concurrency = Number(process.env.CREW_WORKER_CONCURRENCY || 3);
  const live = connections.map((c) => createConnection({
    hostUrl: c.host, token: c.token, vault, dataDir, concurrency, crash,
    localToolsFor: (host) => createLocalTools({ dataDir, host }),
  }));
  for (const c of live) c.start();
  settingsPage(live);
  const stop = () => { for (const c of live) c.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** The worker's own page: keys in, status out. Loopback only; keys are never displayed. */
function settingsPage(live) {
  const port = Number(process.env.CREW_WORKER_PORT || 8790);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/keys') {
      if (req.headers['x-crew'] !== '1') { res.writeHead(403); return res.end(); }
      let body = '';
      for await (const c of req) body += c;
      try {
        const b = JSON.parse(body);
        if (b.apiKey !== undefined) vault.set(b.provider, 'apiKey', String(b.apiKey).trim());
        if (b.baseUrl !== undefined) vault.set(b.provider, 'baseUrl', String(b.baseUrl).trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, vault: vault.status() }));
      } catch (err) { res.writeHead(400); return res.end(err.message); }
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ vault: vault.status(), connections: live.map((c) => c.status), crashLogs: crash.list().slice(0, 10) }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
    res.end(PAGE);
  });
  server.on('error', (err) => console.log(`[worker] settings page off (${err.message})`));
  server.listen(port, '127.0.0.1', () => console.log(`[worker] settings page: http://127.0.0.1:${port}  (keys stay on this machine)`));
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent worker</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#f5f6f8;color:#1c2230}section{background:#fff;border-radius:12px;padding:16px 20px;margin:16px 0;box-shadow:0 1px 3px #0001}
input{padding:8px;border:1px solid #c8cdd6;border-radius:6px;width:100%;box-sizing:border-box}button{padding:8px 14px;border:0;border-radius:6px;background:#3d6fd6;color:#fff;cursor:pointer;margin-top:6px}.ok{color:#2a8a4a}.no{color:#b04030}code{background:#eef0f4;padding:1px 5px;border-radius:4px}label{display:block;margin-top:10px;font-weight:600}</style></head>
<body><h1>Agent worker</h1><p>This process runs your AI agents on this computer. Your API keys are stored here, encrypted, and are only ever sent to the AI provider — never to the office host or other players.</p>
<section><h2>Connections</h2><div id="conns">…</div></section>
<section><h2>Provider keys</h2><div id="vault"></div>
<label>Anthropic API key</label><input id="anthropic" type="password" autocomplete="off" placeholder="sk-ant-…"><button onclick="save('anthropic','apiKey')">Save</button>
<label>OpenAI API key</label><input id="openai" type="password" autocomplete="off" placeholder="sk-…"><button onclick="save('openai','apiKey')">Save</button>
<label>Local model server (OpenAI-compatible)</label><input id="localurl" placeholder="http://127.0.0.1:11434/v1 (Ollama)"><button onclick="save('local','baseUrl','localurl')">Save</button></section>
<script>
async function load(){const s=await (await fetch('/status')).json();
document.getElementById('vault').innerHTML=Object.entries(s.vault).map(([p,v])=>'<div>'+p+': '+(v.apiKey?'<span class=ok>key set</span>':'<span class=no>no key</span>')+(v.baseUrl?' · '+v.baseUrl:'')+(v.fromEnv?' (from environment)':'')+'</div>').join('');
document.getElementById('conns').innerHTML=s.connections.length?s.connections.map(c=>'<div><b>'+(c.room?c.room.name:c.host)+'</b> — '+(c.connected?'<span class=ok>connected</span>':'<span class=no>not connected</span>')+' · running '+c.running+' · finished '+c.completed+(c.lastError?' · <span class=no>'+c.lastError+'</span>':'')+'</div>').join(''):'No connections. Start with <code>--host</code> and <code>--token</code> from the office.';}
async function save(p,f,id){const el=document.getElementById(id||p);await fetch('/keys',{method:'POST',headers:{'Content-Type':'application/json','X-Crew':'1'},body:JSON.stringify({provider:p,[f]:el.value})});el.value='';load();}
load();setInterval(load,4000);</script></body></html>`;

main().catch((err) => { crash.record('worker main', err); process.exit(1); });
