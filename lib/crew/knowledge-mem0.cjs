// The optional Mem0 engine: a long-lived local Python process, started when first needed.
//
// Mem0 knows nothing about players. Crew Office decides who may read what, and asks Mem0 about one
// namespace at a time. Everything here runs on the computer hosting the office, using a model the
// person there chose. No model is chosen for them, because the first use downloads it.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const LOCAL_PROVIDERS = ['fastembed', 'ollama', 'huggingface', 'lmstudio'];
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/;
const CHECK_MS = 10 * 60_000;
const CALL_MS = 180_000;
const IDLE_MS = 15 * 60_000;

/** Only what Python needs to run. No keys, so nothing it loads can find a paid service to call. */
function cleanEnv(extra) {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'PYTHONPATH', 'VIRTUAL_ENV', 'HF_HOME', 'FASTEMBED_CACHE_PATH'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, PYTHONIOENCODING: 'utf-8', MEM0_TELEMETRY: 'False', ...extra };
}

/** Run something and say how it went. Never on the server's own time: importing Mem0 takes seconds. */
function ask(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, env }, (error, stdout, stderr) => resolve({ error: error?.code === 'ENOENT' ? error : null, status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });
}

function createMem0({ dataDir, getConfig, onChange = () => {} }) {
  const home = path.join(dataDir, 'knowledge', 'mem0');
  let check = { at: 0, installed: false, python: null, version: null, reason: 'Checking this computer…', checking: true };
  let looking = null;
  let child = null;
  let starting = null;
  let lastError = null;
  let idle = null;
  const waiting = new Map();
  let nextId = 1;

  const candidates = () => (process.env.CREW_PYTHON ? [process.env.CREW_PYTHON] : ['python3', 'python', 'py']);

  /** Look again for Mem0 on this computer. Everyone asking at once shares one look. */
  function refresh() {
    looking ??= (async () => {
      let found = { at: Date.now(), installed: false, python: null, version: null, reason: 'Python was not found on this computer.' };
      for (const python of candidates()) {
        const r = await ask(python, ['-c', 'import mem0;print(getattr(mem0,"__version__","?"))'], cleanEnv({}));
        if (r.error) continue;
        if (r.status === 0) { found = { at: Date.now(), installed: true, python, version: r.stdout.split('\n')[0].trim(), reason: null }; break; }
        // Windows answers `python` with a store shortcut when there is none; only this error means Python is real.
        if (/No module named ['"]?mem0/.test(r.stderr ?? '')) { found = { at: Date.now(), installed: false, python, version: null, reason: 'Python is here, but Mem0 is not installed.' }; break; }
      }
      check = found;
      looking = null;
      onChange();
      return found;
    })();
    return looking;
  }

  const detect = () => { if (Date.now() - check.at > CHECK_MS) refresh(); return check; };

  function status() {
    const d = detect();
    const c = getConfig();
    const chosen = Boolean(c.provider && c.model);
    return {
      checking: Boolean(d.checking), installed: d.installed, version: d.version, provider: c.provider ?? null, model: c.model ?? null, modelChosen: chosen,
      running: Boolean(child), ready: d.installed && chosen && !lastError,
      reason: !d.installed ? d.reason : !chosen ? 'Choose a local embedding model.' : lastError,
    };
  }

  function stop() {
    clearTimeout(idle);
    if (child) { const c = child; child = null; try { c.stdin.end(); c.kill(); } catch { /* gone */ } }
    starting = null;
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Mem0 stopped.')); }
    waiting.clear();
  }

  function start() {
    if (child) return Promise.resolve();
    if (starting) return starting;
    const d = detect();
    const c = getConfig();
    if (!d.installed) return Promise.reject(new Error(d.reason));
    if (!c.provider || !c.model) return Promise.reject(new Error('Choose a local embedding model first.'));
    fs.mkdirSync(home, { recursive: true });
    starting = new Promise((resolve, reject) => {
      const proc = spawn(d.python, [path.join(__dirname, 'mem0_bridge.py')], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: cleanEnv({ CREW_MEM0_DIR: home, CREW_MEM0_PROVIDER: c.provider, CREW_MEM0_MODEL: c.model }),
      });
      let stderr = '';
      proc.stderr.on('data', (x) => { stderr = (stderr + x).slice(-2000); });
      const lines = readline.createInterface({ input: proc.stdout });
      const fail = (message) => { lastError = message; starting = null; child = null; reject(new Error(message)); onChange(); };
      const startup = setTimeout(() => { fail('Mem0 did not start in time. The first start can download the model; try again.'); proc.kill(); }, CALL_MS);
      lines.on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; } // a library printing to stdout
        if (m.fatal) { clearTimeout(startup); fail(m.fatal); return; }
        if (m.ready) { clearTimeout(startup); child = proc; starting = null; lastError = null; resolve(); onChange(); return; }
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
      });
      proc.on('error', (err) => { clearTimeout(startup); fail(err.message); });
      proc.on('exit', (code) => {
        clearTimeout(startup);
        const was = child === proc;
        if (was) child = null;
        if (starting) fail(stderr.trim().split('\n').pop() || `Mem0 stopped with code ${code}.`);
        for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Mem0 stopped.')); }
        waiting.clear();
        if (was) onChange();
      });
    });
    return starting;
  }

  async function call(method, params) {
    await start();
    clearTimeout(idle);
    idle = setTimeout(stop, IDLE_MS);
    idle.unref?.();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Mem0 took too long to answer.')); }, CALL_MS);
      timer.unref?.();
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Change the model. A different model has vectors of a different size, so the old ones go. */
  function reset() {
    stop();
    lastError = null;
    fs.rmSync(home, { recursive: true, force: true });
  }

  return {
    status, refresh, stop, reset,
    add: (namespace, crewId, text) => call('add', { namespace, crewId, text }),
    update: (mem0Id, text) => call('update', { mem0Id, text }),
    remove: (mem0Id) => call('delete', { mem0Id }),
    search: (namespace, query, limit) => call('search', { namespace, query, limit }),
  };
}

module.exports = { createMem0, LOCAL_PROVIDERS, MODEL };
