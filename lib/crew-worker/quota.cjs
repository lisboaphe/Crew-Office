// Real subscription usage, only ever from what the provider's own tool reported.
//
// These percentages come from the official CLI's structured output during a run this worker
// made: Codex's `rate_limits` events and Claude Code's `rate_limit_event`. The field shapes were
// learned from the MIT-licensed alethe-orchestrate-skill. Neither is a promised interface, so a
// reading that does not parse is dropped rather than guessed at, and a provider that reports
// nothing shows "Usage information unavailable".
//
// Never estimated, and never computed from tokens: a token count says nothing about a plan's
// allowance. Readings stay on this computer. The room host hears only a warning its owner asked for.

'use strict';

const fs = require('fs');
const path = require('path');

const THRESHOLDS = [50, 75, 90, 100];
const STALE_MS = 6 * 3600_000;

const CODEX_WINDOWS = { 300: 'session', 10080: 'weekly' };
const CLAUDE_WINDOWS = { five_hour: 'session', seven_day: 'weekly', seven_day_opus: 'weekly (Opus)', seven_day_sonnet: 'weekly (Sonnet)' };

function window_(usedPercent, resetsAt) {
  const used = Number(usedPercent);
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  const raw = Number(resetsAt);
  const at = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(resetsAt);
  return { usedPercent: used, resetsAt: Number.isFinite(at) ? at : null };
}

/** Read one JSON event from `codex exec --json`, at whatever depth it carries rate_limits. */
function fromCodexEvent(ev) {
  const limits = ev?.rate_limits ?? ev?.payload?.rate_limits ?? ev?.msg?.rate_limits;
  if (!limits || typeof limits !== 'object' || (limits.limit_id ?? 'codex') !== 'codex') return null;
  const windows = {};
  for (const key of ['primary', 'secondary']) {
    const raw = limits[key];
    const name = raw && CODEX_WINDOWS[raw.window_minutes];
    const w = raw && window_(raw.used_percent, raw.resets_at);
    if (name && w) windows[name] = w;
  }
  return Object.keys(windows).length ? { windows, source: 'Reported by the Codex app' } : null;
}

/** Read one event from Claude Code's stream-json output. */
function fromClaudeEvent(ev) {
  if (ev?.type !== 'rate_limit_event') return null;
  const unified = ev.rate_limit_info?.unifiedWindows;
  if (!unified || typeof unified !== 'object') return null;
  const windows = {};
  for (const [key, name] of Object.entries(CLAUDE_WINDOWS)) {
    const raw = unified[key];
    const w = raw && window_(Number(raw.utilization) * 100, raw.resetsAt);
    if (w) windows[name] = w;
  }
  return Object.keys(windows).length ? { windows, source: 'Reported by Claude Code' } : null;
}

function createQuota(dataDir, { now = () => Date.now(), onWarning = () => {} } = {}) {
  const file = path.join(dataDir, 'quota.json');
  let state = { readings: {}, warned: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); };

  function record(provider, reading, warnAt = THRESHOLDS) {
    if (!reading) return;
    state.readings[provider] = { ...reading, observedAt: now() };
    for (const [name, w] of Object.entries(reading.windows)) {
      const key = `${provider}:${name}:${w.resetsAt ?? 'x'}`;
      const crossed = warnAt.filter((t) => w.usedPercent >= t).at(-1);
      if (crossed && (state.warned[key] ?? 0) < crossed) {
        state.warned[key] = crossed;
        onWarning({ provider, window: name, percent: crossed, usedPercent: w.usedPercent, resetsAt: w.resetsAt });
      }
    }
    save();
  }

  /** A reading stops being trusted once its window has reset, or it has simply gone old. */
  function read(provider) {
    const r = state.readings[provider];
    if (!r) return null;
    const windows = Object.fromEntries(Object.entries(r.windows).filter(([, w]) => !w.resetsAt || w.resetsAt > now()));
    if (!Object.keys(windows).length) return null;
    return { ...r, windows, stale: now() - r.observedAt > STALE_MS };
  }

  const all = () => Object.fromEntries(Object.keys(state.readings).map((p) => [p, read(p)]).filter(([, r]) => r));

  /** Whether fresh, provider-reported usage is at or over a line the owner set. Never an estimate. */
  function atOrOver(provider, percent) {
    const r = read(provider);
    if (!r || r.stale || !percent) return null;
    const hit = Object.entries(r.windows).find(([, w]) => w.usedPercent >= percent);
    return hit ? { window: hit[0], usedPercent: hit[1].usedPercent, resetsAt: hit[1].resetsAt } : null;
  }

  return { record, read, all, atOrOver };
}

module.exports = { createQuota, fromCodexEvent, fromClaudeEvent, THRESHOLDS };
