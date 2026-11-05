#!/usr/bin/env node
// What the desktop shortcut runs: Crew Office in a window of its own.
//
//   node bin/crew-app.cjs            host for your network (friends can join)
//   node bin/crew-app.cjs --private  this computer only
//   node bin/crew-app.cjs crewoffice://join?...   open an invitation; what the system's link handler runs
//
// The window is Edge or Chrome in app mode: no tabs or address bar, and a separate profile
// kept under the user's app data. The office runs behind it with no console, its output in
// app.log, and stops when the last window closes. Without either browser it falls back to
// the old way: a console that holds the office open and a tab in the default browser.
//
// If a host is already running on the port, this just opens another window, so
// double-clicking the shortcut twice does not start two servers.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseInvitation, SCHEME } = require('../lib/relay/invitation.cjs');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env */ }
const PORT = Number(process.env.PORT) || 8080;
const lobby = `http://localhost:${PORT}/crew`;
const PRIVATE = process.argv.includes('--private');
const SERVING = process.argv.includes('--serve');
// Whatever the operating system hands us came from a link someone clicked. It only goes further if
// it parses as an invitation, and then only as far as a page that shows it and asks.
const handed = process.argv.slice(2).find((a) => a.toLowerCase().startsWith(`${SCHEME}:`));
const invitation = handed && parseInvitation(handed) ? handed : null;
const windowDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.crew-office'), 'CrewOffice', 'window');
const dataDir = path.join(process.env.ROVING_OFFICE_STATE_DIR || path.join(os.homedir(), '.roving-office'), 'crew');

// The lobby, carrying this computer's key so the page knows it is its owner (lib/crew/auth.cjs).
// Read late: the server writes the key the first time it starts.
function lobbyLink() {
  const q = new URLSearchParams();
  try { q.set('this-pc', fs.readFileSync(path.join(dataDir, 'machine.key'), 'utf8').trim()); } catch { /* not written yet */ }
  if (invitation) q.set('open', invitation);
  return q.size ? `${lobby}?${q}` : lobby;
}

function findBrowser() {
  if (process.env.CREW_APP_NO_WINDOW) return null;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === 'win32'
    ? pf.flatMap((d) => [path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function openWindow(browser) {
  fs.mkdirSync(windowDir, { recursive: true });
  spawn(browser, [`--app=${lobbyLink()}`, `--user-data-dir=${windowDir}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disable-background-mode'], { detached: true, stdio: 'ignore' }).unref();
}

/** Whether a window is open: the browser holds a lock in its profile for as long as it runs. */
function windowIsOpen() {
  if (process.platform !== 'win32') { try { fs.lstatSync(path.join(windowDir, 'SingletonLock')); return true; } catch { return false; } }
  try { fs.closeSync(fs.openSync(path.join(windowDir, 'lockfile'), 'r+')); return false; } catch (err) { return err.code !== 'ENOENT'; }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { console.log(`Open ${url} in your browser.`); }
}

async function running() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/api/crew/host-info`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function waitUntilRunning() {
  for (let i = 0; i < 60; i++) {
    if (await running()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startHost() {
  if (PRIVATE) process.env.HOST = process.env.HOST || '127.0.0.1';
  process.env.PORT = String(PORT);
  require('./crew-host.cjs');
}

/** The office, with no console: a copy of this program that outlives the shortcut's. */
function startInBackground() {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = path.join(dataDir, 'app.log');
  const out = fs.openSync(log, 'w');
  spawn(process.execPath, [__filename, '--serve', ...(PRIVATE ? ['--private'] : []), ...(invitation ? [invitation] : [])], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: path.join(__dirname, '..') }).unref();
  fs.closeSync(out);
  return log;
}

/** Stop the office once the app's windows are gone. Two looks, in case one lands mid-restart. */
function stopWithWindow() {
  let misses = 0;
  setInterval(() => {
    misses = windowIsOpen() ? 0 : misses + 1;
    if (misses >= 2) {
      process.emit('SIGTERM');
      setTimeout(() => process.exit(0), 3000).unref();
    }
  }, 3000);
}

(async () => {
  const browser = findBrowser();
  if (await running()) {
    console.log(`Crew Office is already running — opening ${lobby}`);
    if (browser) openWindow(browser); else openBrowser(lobbyLink());
    return;
  }
  if (!browser) {
    console.log('Starting Crew Office… (keep this window open while you play; close it to stop the office)');
    startHost();
    if (!await waitUntilRunning()) console.log(`The office did not answer on port ${PORT}. See the messages above.`);
    else if (process.env.CREW_APP_NO_WINDOW !== 'headless') openBrowser(lobbyLink());
    return;
  }
  if (!SERVING) {
    const log = startInBackground();
    if (!await waitUntilRunning()) openBrowser(log); // no console to say so in: show what went wrong
    return;
  }
  process.env.CREW_APP_MANAGED = '1'; // the office also runs this computer's worker
  startHost();
  if (!await waitUntilRunning()) { process.exit(1); }
  // After an update the old window is still open, and reloads itself when the office returns.
  if (!windowIsOpen()) openWindow(browser);
  setTimeout(stopWithWindow, 10_000);
})();
