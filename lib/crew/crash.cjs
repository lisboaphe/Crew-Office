// Crash logs for the multiplayer host and workers.
//
// When something breaks — an uncaught exception, a rejected promise nobody handled, an
// error inside the scheduler, or a player's browser reporting one — a JSON report is
// written to <data>/crash-logs/: the error and stack, the version, the platform, uptime,
// memory, and the last realtime events the room saw, which is usually the story of how it
// got there. Every report is scrubbed of anything shaped like a credential first.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = 200;
const RECENT = 80;
const SECRET = /(sk-[a-z0-9_-]{10,}|sk-ant-[a-z0-9_-]{10,}|wk_[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{10,}|"(?:password|token|apiKey|api_key|authorization)"\s*:\s*"[^"]*")/gi;

function redact(value) {
  return JSON.parse(JSON.stringify(value ?? null, (k, v) => {
    if (/password|token|secret|apikey|api_key|authorization|cookie/i.test(k)) return '[redacted]';
    return typeof v === 'string' ? v.replace(SECRET, '[redacted]') : v;
  }));
}

function createCrashLog({ dir, version = 'dev', component = 'host' }) {
  const recent = [];
  let counter = 0;

  function remember(event, data) {
    recent.push({ at: new Date().toISOString(), event, data: truncate(data) });
    if (recent.length > RECENT) recent.shift();
  }

  function write(kind, context, err, extra = {}) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${kind}-${component}-${stamp}-${process.pid}-${++counter}.json`);
      const report = redact({
        kind, component, context, version, at: new Date().toISOString(),
        error: { name: err?.name, message: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 30) },
        process: { pid: process.pid, node: process.version, platform: `${os.platform()} ${os.release()}`, uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1e6) },
        recentEvents: recent.slice(-RECENT),
        ...extra,
      });
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
      prune();
      return file;
    } catch {
      return null;
    }
  }

  function prune() {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  }

  /** A handled-but-unexpected error: logged, process keeps running. */
  function record(context, err, extra) {
    const file = write('error', context, err, extra);
    console.error(`[crash-log] ${context}: ${err?.message ?? err}${file ? ` → ${file}` : ''}`);
    return file;
  }

  /** Fatal handlers. The host keeps serving after an unhandled rejection; an uncaught exception is fatal. */
  function install() {
    process.on('uncaughtException', (err) => {
      const file = write('crash', 'uncaughtException', err);
      console.error(`[crash-log] fatal: ${err?.stack ?? err}\nReport: ${file}`);
      process.exit(70);
    });
    process.on('unhandledRejection', (reason) => record('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
  }

  function list() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 50)
        .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }));
    } catch { return []; }
  }

  return { remember, record, write, install, list, dir };
}

function truncate(data) {
  const s = JSON.stringify(data ?? null);
  return s.length > 600 ? `${s.slice(0, 600)}…` : JSON.parse(s);
}

module.exports = { createCrashLog, redact };
