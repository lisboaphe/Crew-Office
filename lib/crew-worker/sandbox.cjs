// Running agent-written code without handing it the machine.
//
// Two isolation levels, chosen by the worker's owner:
//
//   docker  (CREW_SANDBOX=docker) — a throwaway container: no network, 512 MB, one CPU,
//           128 processes, the project copy as its only volume. The strong option.
//   process (default)             — Node's permission model: the child may read and write
//           only its own temporary copy of the project, may not start processes or
//           worker threads or load native addons, and is killed at the time limit.
//           Network access is NOT blocked at this level; use docker where that matters.
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
  for (const a of argv) if (/^--(allow-|permission|experimental-permission|inspect)/.test(a)) throw new Error(`The sandbox sets its own permissions; ${a} is not allowed.`);
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

let dockerChecked = null;
function dockerAvailable() {
  if (dockerChecked === null) {
    try { dockerChecked = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 }).status === 0; } catch { dockerChecked = false; }
  }
  return dockerChecked;
}

function run(command, files, { mode = process.env.CREW_SANDBOX || 'process', image = process.env.CREW_SANDBOX_IMAGE || 'node:22-alpine' } = {}) {
  const argv = parseCommand(command);
  const dir = materialise(files);
  let exe;
  let args;
  if (mode === 'docker') {
    if (!dockerAvailable()) {
      fs.rmSync(dir, { recursive: true, force: true });
      return Promise.resolve({ exitCode: -1, output: 'Docker sandbox is configured on this worker but Docker is not available.', isolation: 'none' });
    }
    exe = 'docker';
    args = ['run', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--read-only', '--tmpfs', '/tmp',
      '-v', `${dir}:/work`, '-w', '/work', image, ...withIsolation(argv)];
  } else {
    exe = process.execPath;
    args = ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '--max-old-space-size=256', ...withIsolation(argv).slice(1)];
  }
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(exe, args, { cwd: dir, env: { NODE_ENV: 'test', PATH: mode === 'docker' ? process.env.PATH : '' }, windowsHide: true });
    const take = (chunk) => { if (output.length < OUTPUT_CAP) output += chunk.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { output += `\n[sandbox] killed after ${TIMEOUT_MS / 1000} s`; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', (err) => { output += `\n[sandbox] ${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
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

module.exports = { run, parseCommand };
