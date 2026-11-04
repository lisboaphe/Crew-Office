// The owner's Budget Manager and billing safety, on the owner's own machine. The host never
// sees these numbers — only that an agent is available or a task is paused.
//
// BILLING. "Never use paid API" is on by default: providers billed per token refuse to run
// until the owner turns it off here, on this computer. Nothing falls back to them.
//
// BUDGETS ARE ESTIMATES. No provider tells a third-party app how much of a subscription
// allowance remains, so a percentage here is of a capacity the OWNER estimates ("about 300
// requests a week"), counted from requests this worker actually made. It stops work
// conservatively; it is not a provider quota and the UI says so. Provider-enforced limits are
// a separate thing: when a provider says stop, the job pauses and is not retried around it.
//
// Running jobs reserve capacity, so two concurrent tasks cannot each spend the same
// remainder: the second is told how little is free, and pauses early rather than oversubscribe.

'use strict';

const fs = require('fs');
const path = require('path');

const WINDOWS = { session5h: 5 * 3600_000, daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000 };
const DEFAULTS = { neverPaidApi: true, allowClaudeAutomation: false, taskDefaultPct: null, providers: {} };
const PROVIDER_DEFAULTS = { window: 'weekly', capacity: null, reservePct: 20, maxConcurrent: 2, warnAt: [50, 75, 90], pauseAtLimit: true };
const PAID = new Set(['anthropic', 'openai']);
const TICK = 1; // one model request

function createBudget(dataDir, { now = () => Date.now() } = {}) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const ledgerFile = path.join(dataDir, 'usage-ledger.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  let settings = { ...DEFAULTS, ...read(settingsFile, {}) };
  let ledger = read(ledgerFile, []);
  const running = new Map(); // reservation id -> { provider, taskId, cap }
  let seq = 0;

  const save = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 }); };
  const saveLedger = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ledgerFile, JSON.stringify(ledger)); };

  const cfg = (provider) => ({ ...PROVIDER_DEFAULTS, ...(settings.providers[provider] ?? {}) });
  const windowMs = (c) => WINDOWS[c.window] ?? WINDOWS.weekly;
  const usedInWindow = (provider, c = cfg(provider)) => ledger.filter((e) => e.provider === provider && e.at > now() - windowMs(c)).reduce((s, e) => s + e.units, 0);
  const usedByTask = (provider, taskId) => (taskId ? ledger.filter((e) => e.provider === provider && e.taskId === taskId).reduce((s, e) => s + e.units, 0) : 0);

  /** Why this provider may not run on this worker at all, if so. */
  function billingBlock(provider) {
    if (PAID.has(provider) && settings.neverPaidApi) return `Paid API usage is off on this computer (“Never use paid API”). ${provider} bills per token, so it will not run until you turn that off yourself.`;
    if (provider === 'claude-cli' && !settings.allowClaudeAutomation) return 'Automated Claude Code is off. Use the manual handoff, or opt in on this worker’s settings page after reading the notice.';
    return null;
  }

  /** Free estimated capacity after usage, the owner's reserve, and what running jobs hold. */
  function free(provider, c = cfg(provider)) {
    if (!c.capacity) return Infinity;
    const usable = c.capacity * (1 - c.reservePct / 100);
    const held = [...running.values()].filter((r) => r.provider === provider).reduce((s, r) => s + Math.max(0, r.cap - usedByTask(provider, r.taskId) + r.baseUsed), 0);
    return usable - usedInWindow(provider, c) - held;
  }

  /** Providers the worker should not claim jobs for right now. */
  function blockedProviders(providerNames) {
    return providerNames.filter((p) => {
      if (billingBlock(p)) return true;
      const c = cfg(p);
      if ([...running.values()].filter((r) => r.provider === p).length >= c.maxConcurrent) return true;
      return c.capacity && c.pauseAtLimit && free(p, c) <= 0;
    });
  }

  function resetAt(provider, c = cfg(provider)) {
    const entries = ledger.filter((e) => e.provider === provider && e.at > now() - windowMs(c)).map((e) => e.at);
    return entries.length ? Math.min(...entries) + windowMs(c) : now();
  }

  /**
   * A job starts: reserve its share. Returns { ok, cap, warning } or { ok: false, pause }.
   * Without a configured capacity there is nothing to enforce except provider limits.
   */
  function open(provider, taskId, taskPct) {
    const c = cfg(provider);
    const id = ++seq;
    const pct = taskPct ?? settings.taskDefaultPct;
    if (!c.capacity) {
      running.set(id, { provider, taskId, cap: 0, baseUsed: 0 });
      return { ok: true, id, cap: null, estimated: true };
    }
    const avail = free(provider, c);
    const baseUsed = usedByTask(provider, taskId);
    const wanted = pct ? (c.capacity * pct) / 100 : avail;
    const remainingForTask = wanted - baseUsed;
    if (pct && remainingForTask <= 0) return { ok: false, pause: { kind: 'budget', reason: `This task reached its estimated budget (${pct}% of your ${c.window} estimate). Raise it to continue. Estimated, not a provider limit.`, resumeAfter: null } };
    if (avail <= 0) return { ok: false, pause: { kind: 'budget', reason: `Your estimated ${c.window} capacity is used up (keeping your ${c.reservePct}% reserve). Waiting for the window to roll over. Estimated, not a provider limit.`, resumeAfter: resetAt(provider, c) } };
    const cap = Math.min(remainingForTask, avail);
    running.set(id, { provider, taskId, cap: cap, baseUsed });
    const warning = pct && cap < remainingForTask ? `Only about ${Math.round((avail / c.capacity) * 100)}% of the estimate is free while other tasks run, less than this task’s ${pct}%. It may pause early rather than oversubscribe.` : null;
    return { ok: true, id, cap, warning, estimated: true };
  }

  /** One model request happened. Returns warnings crossed, and whether to stop. */
  function charge(reservation, provider, taskId, { tokensIn = 0, tokensOut = 0 } = {}) {
    const c = cfg(provider);
    const before = usedByTask(provider, taskId);
    ledger.push({ at: now(), provider, taskId: taskId ?? null, units: TICK, tokensIn, tokensOut });
    if (ledger.length > 20_000) ledger = ledger.slice(-10_000);
    saveLedger();
    const r = running.get(reservation?.id);
    if (!c.capacity || !r) return { stop: false };
    const usedHere = before + TICK - r.baseUsed;
    const warn = c.warnAt.filter((w) => (usedHere - TICK) / r.cap * 100 < w && usedHere / r.cap * 100 >= w);
    if (c.pauseAtLimit && usedHere >= r.cap) {
      const task = usedHere + r.baseUsed;
      return { stop: true, warn, pause: { kind: 'budget', reason: `This task used its estimated share (about ${task} requests of your ${c.capacity}-request ${c.window} estimate). Estimated, not a provider limit. Work so far is saved.`, resumeAfter: free(provider, c) <= 0 ? resetAt(provider, c) : null } };
    }
    return { stop: false, warn };
  }

  const close = (reservation) => { if (reservation?.id) running.delete(reservation.id); };

  function update(patch) {
    const next = { ...settings };
    if (patch.neverPaidApi !== undefined) next.neverPaidApi = Boolean(patch.neverPaidApi);
    if (patch.allowClaudeAutomation !== undefined) next.allowClaudeAutomation = Boolean(patch.allowClaudeAutomation);
    if (patch.taskDefaultPct !== undefined) next.taskDefaultPct = patch.taskDefaultPct === null || patch.taskDefaultPct === '' ? null : Math.min(100, Math.max(1, Number(patch.taskDefaultPct)));
    if (patch.provider) {
      const { name, ...rest } = patch.provider;
      const cur = { ...(next.providers[name] ?? {}) };
      if (rest.window !== undefined && WINDOWS[rest.window]) cur.window = rest.window;
      if (rest.capacity !== undefined) cur.capacity = rest.capacity === null || rest.capacity === '' ? null : Math.max(1, Number(rest.capacity));
      if (rest.reservePct !== undefined) cur.reservePct = Math.min(95, Math.max(0, Number(rest.reservePct)));
      if (rest.maxConcurrent !== undefined) cur.maxConcurrent = Math.max(1, Number(rest.maxConcurrent));
      if (rest.pauseAtLimit !== undefined) cur.pauseAtLimit = Boolean(rest.pauseAtLimit);
      next.providers = { ...next.providers, [name]: cur };
    }
    settings = next;
    save();
    return status();
  }

  /** What the settings page shows, each number labelled for what it is. */
  function status() {
    const providers = {};
    const names = new Set([...Object.keys(settings.providers), ...ledger.map((e) => e.provider)]);
    for (const p of names) {
      const c = cfg(p);
      const used = usedInWindow(p, c);
      providers[p] = {
        ...c, requestsInWindow: used, measured: 'requests made by this worker (measured)',
        estimatedPct: c.capacity ? Math.round((used / c.capacity) * 100) : null, remainingAllowance: 'unavailable: providers do not report it to apps',
        running: [...running.values()].filter((r) => r.provider === p).length,
      };
    }
    return { neverPaidApi: settings.neverPaidApi, allowClaudeAutomation: settings.allowClaudeAutomation, taskDefaultPct: settings.taskDefaultPct, providers };
  }

  return { billingBlock, blockedProviders, open, charge, close, update, status, free, settings: () => settings };
}

module.exports = { createBudget, PAID };
