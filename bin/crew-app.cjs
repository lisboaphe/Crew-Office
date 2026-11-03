#!/usr/bin/env node
// What the desktop shortcut runs: start the office host and open the lobby in the browser.
//
//   node bin/crew-app.cjs            host for your network (friends can join)
//   node bin/crew-app.cjs --private  this computer only
//
// If a Crew Office host is already running on the port, it just opens the browser, so
// double-clicking the shortcut twice does not start two servers.

'use strict';

const { spawn } = require('child_process');

try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* no .env */ }
const PORT = Number(process.env.PORT) || 8080;
const lobby = `http://localhost:${PORT}/crew`;

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { console.log(`Open ${url} in your browser.`); }
}

async function running() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/api/crew/host-info`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

(async () => {
  if (await running()) {
    console.log(`Crew Office is already running — opening ${lobby}`);
    openBrowser(lobby);
    return;
  }
  if (process.argv.includes('--private')) process.env.HOST = process.env.HOST || '127.0.0.1';
  process.env.PORT = String(PORT);
  console.log('Starting Crew Office… (keep this window open while you play; close it to stop the office)');
  require('./crew-host.cjs');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await running()) { openBrowser(lobby); return; }
  }
  console.log(`The office did not answer on port ${PORT}. See the messages above.`);
})();
