// In-app updates, from the GitHub releases that .github/workflows/release.yml publishes on
// every push to main.
//
// An installed copy carries build.json, written by installer/build.cjs, naming its build
// number and the repository it came from. A source checkout has none and updates with git.
//
// Nothing installs by itself. The app says an update exists; the person at the host's own
// computer presses the button (the routes in api.cjs refuse anyone else, because installing
// replaces the code this machine runs). The download must match the checksum published
// beside it, which catches a damaged download, and a release can only come from whoever may
// push to the repository, which is the trust being placed here.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { httpError } = require('./auth.cjs');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_MS = 10 * 60_000;
const MAX_DOWNLOAD = 300 * 1024 * 1024;

function readBuild(root = ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8')); } catch { return null; }
}

function createUpdater({ root = ROOT, dataDir = os.tmpdir(), apiBase = process.env.CREW_UPDATE_API || 'https://api.github.com', platform = process.platform, launchInstaller = launch } = {}) {
  const build = readBuild(root);
  let cached = null;
  let installing = false;

  async function latest() {
    const res = await fetch(`${apiBase}/repos/${build.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'crew-office-updater' }, signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null; // the repository has no release yet
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    const number = Number(/^build-(\d+)$/.exec(r.tag_name ?? '')?.[1]);
    const asset = (name) => r.assets?.find((a) => a.name === name)?.browser_download_url;
    if (!number || !asset('CrewOffice.zip') || !asset('CrewOffice.zip.sha256')) return null;
    return { build: number, url: r.html_url, zip: asset('CrewOffice.zip'), checksum: asset('CrewOffice.zip.sha256') };
  }

  async function status({ force = false } = {}) {
    if (!build) return { enabled: false, available: false, reason: 'This is a source checkout: update it with git.' };
    const current = { build: build.build, commit: build.commit };
    if (!build.repo) return { enabled: false, available: false, current, reason: 'This build was not made from a GitHub repository, so it has nowhere to check.' };
    if (force || !cached || Date.now() - cached.at > CACHE_MS) {
      try { cached = { at: Date.now(), release: await latest(), error: null }; }
      catch (err) { cached = { at: Date.now(), release: null, error: err.message }; }
    }
    const { release, error } = cached;
    const windows = platform === 'win32';
    return {
      enabled: true, current, error, canInstall: windows,
      reason: windows ? null : 'Updating inside the app is Windows only for now. Download the new version and run its installer.',
      available: Boolean(release && release.build > build.build),
      latest: release ? { build: release.build, url: release.url } : null,
    };
  }

  /** Download, verify, and hand over to the installer. The caller then stops this process. */
  async function install({ waitPid = process.pid, appArgs = [] } = {}) {
    if (installing) throw httpError(409, 'An update is already being installed.');
    const s = await status({ force: true });
    if (!s.enabled || !s.canInstall) throw httpError(400, s.reason);
    if (!s.available) throw httpError(409, s.error ? `Could not check for updates: ${s.error}` : 'Already up to date.');
    installing = true;
    try {
      const { release } = cached;
      const zip = await fetchBytes(release.zip);
      const published = (await fetchBytes(release.checksum)).toString('utf8').trim().split(/\s+/)[0].toLowerCase();
      const actual = crypto.createHash('sha256').update(zip).digest('hex');
      if (published !== actual) throw httpError(502, 'The download does not match its published checksum, so it was not installed.');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-update-'));
      const zipFile = path.join(dir, 'app.zip');
      fs.writeFileSync(zipFile, zip);
      // A copy: the installer replaces the folder this script lives in.
      const script = path.join(dir, 'install.ps1');
      fs.copyFileSync(path.join(root, 'installer', 'windows', 'install.ps1'), script);
      fs.mkdirSync(dataDir, { recursive: true });
      launchInstaller({ script, zipFile, target: root, waitPid, appArgs, log: path.join(dataDir, 'update.log') });
      return { build: release.build };
    } catch (err) {
      installing = false;
      throw err;
    }
  }

  async function fetchBytes(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'crew-office-updater' }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw httpError(502, `Download failed: GitHub answered ${res.status}.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) throw httpError(502, 'The download is larger than any real release.');
    return bytes;
  }

  return { status, install, build };
}

// Windows PowerShell does nothing at all if started detached (no console), or if the process
// that started it exits straight away, both of which an updating server needs. So a small
// detached Node process does the waiting: Node runs fine without a console, and it stays
// alive for PowerShell. If PowerShell cannot even start, it brings the old app back, since
// the server has already stopped and nothing else would.
function launch({ script, zipFile, target, waitPid, appArgs, log }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', zipFile, '-Target', target, '-Quiet', '-WaitPid', String(waitPid), '-Relaunch'];
  if (appArgs.length) args.push('-AppArgs', appArgs.join(' '));
  const helper = path.join(path.dirname(script), 'run-installer.cjs');
  fs.writeFileSync(helper, `const { spawn } = require('child_process');
const fs = require('fs');
const out = fs.openSync(${JSON.stringify(log)}, 'w');
spawn('powershell.exe', ${JSON.stringify(args)}, { stdio: ['ignore', out, out], windowsHide: true, cwd: ${JSON.stringify(path.dirname(script))} })
  .on('error', () => {
    spawn(process.execPath, [${JSON.stringify(path.join(target, 'bin', 'crew-app.cjs'))}, ...${JSON.stringify(appArgs)}], { detached: true, stdio: 'ignore', windowsHide: true, cwd: ${JSON.stringify(target)} }).unref();
  });
`);
  spawn(process.execPath, [helper], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(script) }).unref();
}

module.exports = { createUpdater, readBuild };
