// Running agent-written code without handing it the machine.
//
// Two isolation levels, chosen by the worker's owner:
//
//   docker  (CREW_SANDBOX=docker) — a throwaway container: no network, 512 MB, one CPU,
//           128 processes, the project copy as its only volume. The strong option.
//   process (default)             — Node's permission model: the child may read and write
//           only its own temporary copy of the project, may not start processes or
//           worker threads or load native addons, and is killed at the time limit. A guard
//           loaded first takes away the network (no-network.cjs).
//
// Node's own documentation says its permission model is not a defence against malicious code.
// So code that may have come from another player runs in Docker when Docker is here, and is
// otherwise refused unless this computer's owner has accepted the weaker level (forContext).
//
// Only Node commands run, parsed without a shell: no pipes, redirects, substitutions or
// chained commands. The child gets an empty environment, so no credential in the worker's
// own environment is visible to it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 64 * 1024;
const DISK_CAP = 512 * 1024 * 1024;
const MAX_CONCURRENT = 2;
const NO_NETWORK = path.join(__dirname, 'no-network.cjs');
// Flags a command may use. Anything else that starts with a dash before the script is refused,
// because several of Node's flags load code or change what the sandbox enforces.
const ALLOWED_FLAGS = /^(--test|--test-[a-z-]+(=.*)?|-e|--eval|-p|--print|--no-warnings|--trace-warnings)$/;

function parseCommand(command) {
  const s = String(command ?? '').trim();
  if (!s) throw new Error('Empty command.');
  if (/[|&;<>`$\n\r]/.test(s)) throw new Error('Pipes, redirects, substitutions and chained commands are not allowed. Run one node command.');
  const argv = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) argv.push(m[1] ?? m[2] ?? m[3]);
  if (argv[0] === 'npm' && argv[1] === 'test') return ['node', '--test'];
  if (argv[0] !== 'node') throw new Error('Only `node …` commands (and `npm test`) can run in the sandbox.');
  for (const a of argv.slice(1)) {
    if (!a.startsWith('-')) break; // the script: what follows is its own arguments
    if (!ALLOWED_FLAGS.test(a)) throw new Error(`The sandbox sets its own options; ${a} is not allowed.`);
  }
  return argv;
}

function materialise(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crew-sandbox-${crypto.randomBytes(3).toString('hex')}-`));
  for (const [rel, content] of Object.entries(files ?? {})) {
    const norm = rel.replace(/\\/g, '/');
    if (norm.startsWith('/') || norm.split('/').includes('..') || /^[a-zA-Z]:/.test(norm)) continue;
    const full = path.join(dir, norm);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// The container below is a Linux one, started with options that only exist for Linux. Docker on
// Windows can be switched to Windows containers, and GitHub's Windows machines always are: that
// Docker answers every question normally, then refuses the run with exit code 125. So a Docker
// counts only if the engine it talks to runs Linux.
const runsLinux = (answer) => answer?.status === 0 && String(answer.stdout ?? '').trim().toLowerCase() === 'linux';

let dockerChecked = null;
function dockerAvailable() {
  if (dockerChecked === null) {
    try { dockerChecked = runsLinux(spawnSync('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 5000, encoding: 'utf8', windowsHide: true })); } catch { dockerChecked = false; }
  }
  return dockerChecked;
}

// How many run at once on this computer, so looping agents cannot eat it.
let active = 0;
const waiting = [];
const acquire = () => (active < MAX_CONCURRENT ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

function dirSize(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? dirSize(p) : e.isFile() ? fs.statSync(p).size : 0;
    }
  } catch { /* it is being changed under us */ }
  return n;
}

/** The process and anything it started, on every platform. */
function killTree(child, containerName) {
  if (containerName) spawnSync('docker', ['kill', containerName], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
}

/**
 * Whether this job's code may have come from someone else. Decided here, on this computer: a
 * host this worker does not run itself is never taken at its word.
 */
function mayBeForeign(ctx, hostBase) {
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(hostBase).hostname); } catch { /* not local */ }
  return !local || ctx.project?.sharedWithOthers !== false;
}

function weakAccepted(dataDir) {
  if (process.env.CREW_ALLOW_WEAK_SANDBOX === '1') return true;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).allowWeakSandbox === true; } catch { return false; }
}

/** The one way agent work reaches run(): picks the isolation, or refuses. */
function forContext(ctx, { hostBase, dataDir }) {
  return (command, files) => {
    const foreign = ctx.project ? mayBeForeign(ctx, hostBase) : false;
    const opts = { signal: ctx.signal };
    if (foreign && process.env.CREW_SANDBOX !== 'docker') {
      if (dockerAvailable()) opts.mode = 'docker';
      else if (!weakAccepted(dataDir)) {
        return Promise.resolve({ exitCode: -1, isolation: 'refused', refused: true, output: 'Refused: this project is shared, so this code may have come from another player, and this computer has no Docker running Linux containers to isolate it. Nothing was run. Its owner can install Docker, or accept the weaker sandbox on the worker’s page. Do not try to work around this; say so in your report.' });
      }
    }
    return run(command, files, opts);
  };
}

async function run(command, files, { mode = process.env.CREW_SANDBOX || 'process', image = process.env.CREW_SANDBOX_IMAGE || 'node:22-alpine', signal = null, timeoutMs = TIMEOUT_MS } = {}) {
  const argv = parseCommand(command);
  if (signal?.aborted) return { exitCode: -1, output: '[sandbox] stopped before it started', isolation: 'none', stopped: true };
  await acquire();
  try { return await execute(argv, files, { mode, image, signal, timeoutMs }); } finally { release(); }
}

function execute(argv, files, { mode, image, signal, timeoutMs }) {
  const dir = materialise(files);
  const containerName = mode === 'docker' ? `crew-${crypto.randomBytes(6).toString('hex')}` : null;
  let exe;
  let args;
  if (mode === 'docker') {
    if (!dockerAvailable()) {
      fs.rmSync(dir, { recursive: true, force: true });
      return Promise.resolve({ exitCode: -1, output: 'Docker sandbox is configured on this worker but Docker is not available.', isolation: 'none' });
    }
    exe = 'docker';
    args = ['run', '--rm', '--name', containerName, '--network', 'none', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '--read-only', '--tmpfs', '/tmp:size=64m,noexec',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '-v', `${dir}:/work`, '-w', '/work', image, ...withIsolation(argv)];
  } else {
    exe = process.execPath;
    args = ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${NO_NETWORK}`, `--allow-fs-write=${dir}`, '--max-old-space-size=256', '--require', NO_NETWORK, ...withIsolation(argv).slice(1)];
  }
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(exe, args, { cwd: dir, env: { NODE_ENV: 'test', PATH: mode === 'docker' ? process.env.PATH : '' }, windowsHide: true, detached: process.platform !== 'win32' });
    const take = (chunk) => { if (output.length < OUTPUT_CAP) output += chunk.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stopIt = (why) => { output += `\n[sandbox] ${why}`; killTree(child, containerName); };
    const timer = setTimeout(() => stopIt(`killed after ${timeoutMs / 1000} s`), timeoutMs);
    const diskWatch = setInterval(() => { if (dirSize(dir) > DISK_CAP) stopIt(`killed: used more than ${DISK_CAP / 1024 / 1024} MB of disk`); }, 2000);
    const onAbort = () => stopIt('stopped by an emergency stop or a lost lease');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { output += `\n[sandbox] ${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(diskWatch);
      signal?.removeEventListener('abort', onAbort);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* removed by the temp sweep later */ }
      resolve({ exitCode: code ?? -1, output: output.slice(0, OUTPUT_CAP), isolation: mode === 'docker' ? 'docker (no network)' : 'node permission model (fs-confined, no child processes; network not blocked)' });
    });
  });
}

/** The test runner isolates files in child processes, which the sandbox forbids; run them in-process. */
function withIsolation(argv) {
  if (argv.includes('--test') && !argv.some((a) => a.startsWith('--test-isolation'))) {
    const i = argv.indexOf('--test');
    return [...argv.slice(0, i + 1), '--test-isolation=none', ...argv.slice(i + 1)];
  }
  return argv;
}

module.exports = { run, forContext, mayBeForeign, parseCommand, dockerAvailable, runsLinux };
