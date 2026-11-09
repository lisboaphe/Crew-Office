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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WINDOWS = { session5h: 5 * 3600_000, daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000 };
const DEFAULTS = { neverPaidApi: true, allowClaudeAutomation: false, autonomous: 'off', taskDefaultPct: null, tokenSaver: true, savedChars: 0, allowWeakSandbox: false, localStop: false, providers: {} };
const PROVIDER_DEFAULTS = { window: 'weekly', capacity: null, reservePct: 20, maxConcurrent: 2, warnAt: [50, 75, 90], pauseAtLimit: true, pauseAtPercent: null };
const PAID = new Set(['anthropic', 'openai']);
const TICK = 1; // one model request

// The settings that decide how much agents may do here. No agent may raise them: while an autonomous
// agent works they cannot be raised at all, and one changed in the file behind the worker's back is
// put back to its safe value when the worker starts (see `seal` below).
const GUARDED = ['neverPaidApi', 'allowClaudeAutomation', 'autonomous', 'allowWeakSandbox', 'localStop'];
const REACH_RANK = { off: 0, project: 1, computer: 2 };

/** Which of these changes would let agents do more than they can now. */
function widening(current, patch) {
  const out = [];
  if (patch.neverPaidApi === false && current.neverPaidApi !== false) out.push('allowing paid APIs');
  if (patch.allowClaudeAutomation === true && !current.allowClaudeAutomation) out.push('starting Claude Code automatically');
  if (patch.autonomous !== undefined && (REACH_RANK[patch.autonomous] ?? 0) > (REACH_RANK[current.autonomous] ?? 0)) out.push(`autonomous agents reaching ${patch.autonomous === 'computer' ? 'the whole computer' : 'their project folder'}`);
  if (patch.allowWeakSandbox === true && !current.allowWeakSandbox) out.push('the weaker sandbox');
  if (patch.localStop === false && current.localStop) out.push('resuming agents');
  return out;
}

const fingerprint = (s) => crypto.createHash('sha256').update(JSON.stringify(GUARDED.map((k) => [k, s[k] ?? null]))).digest('hex');

/**
 * @param {{now?: () => number, seal?: ?{get: () => ?string, set: (v: string) => void}}} [opts]
 *   `seal` keeps a fingerprint of the guarded settings somewhere the settings file is not: the
 *   worker's encrypted vault, whose key the operating system holds for this user.
 */
function createBudget(dataDir, { now = () => Date.now(), seal = null } = {}) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const ledgerFile = path.join(dataDir, 'usage-ledger.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  let settings = { ...DEFAULTS, ...read(settingsFile, {}) };
  // A file whose guarded settings do not match the seal was changed outside the worker. Whatever it
  // says, the safe values come back, and the owner is told.
  let tampered = null;
  if (seal) {
    const sealed = seal.get();
    if (sealed && sealed !== fingerprint(settings)) {
      const changed = GUARDED.filter((k) => settings[k] !== DEFAULTS[k]);
      tampered = changed;
      for (const k of GUARDED) settings[k] = DEFAULTS[k];
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    }
    seal.set(fingerprint(settings));
  }
  let ledger = read(ledgerFile, []);
  const running = new Map(); // reservation id -> { provider, taskId, cap }
  let seq = 0;
  let quota = null;
  const useQuota = (q) => { quota = q; };
  let connections = null;
  const useConnections = (c) => { connections = c; };

  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    seal?.set(fingerprint(settings));
  };
  const saveLedger = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ledgerFile, JSON.stringify(ledger)); };

  const cfg = (provider) => ({ ...PROVIDER_DEFAULTS, ...(settings.providers[provider] ?? {}) });
  const windowMs = (c) => WINDOWS[c.window] ?? WINDOWS.weekly;
  const usedInWindow = (provider, c = cfg(provider)) => ledger.filter((e) => e.provider === provider && e.at > now() - windowMs(c)).reduce((s, e) => s + e.units, 0);
  const usedByTask = (provider, taskId) => (taskId ? ledger.filter((e) => e.provider === provider && e.taskId === taskId).reduce((s, e) => s + e.units, 0) : 0);

  /** Why this provider may not run on this worker at all, if so. */
  function billingBlock(provider) {
    if (PAID.has(provider) && settings.neverPaidApi) return `Paid API usage is off on this computer (“Never use paid API”). ${provider} bills per token, so it will not run until you turn that off yourself.`;
    if (provider === 'claude-cli' && !settings.allowClaudeAutomation) return 'Automated Claude Code is off. Use the manual handoff, or opt in on this worker’s settings page after reading the notice.';
    const account = connections?.providerBlock(provider);
    if (account) return account;
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
      // A line the owner set, against what the provider itself reported. Without a reading it never fires.
      if (c.pauseAtPercent && quota?.atOrOver(p, c.pauseAtPercent)) return true;
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

  /** Characters the token saver kept out of a prompt: measured, and all it can honestly claim. */
  const noteSaved = (chars) => { if (chars > 0) { settings = { ...settings, savedChars: (settings.savedChars ?? 0) + chars }; save(); } };

  const close = (reservation) => { if (reservation?.id) running.delete(reservation.id); };

  /**
   * @param {object} patch
   * @param {{locked?: boolean}} [opts]  locked while an autonomous agent works: nothing that lets
   *   agents do more may change then, whoever asks
   */
  function update(patch, { locked = false } = {}) {
    if (locked) {
      const more = widening(settings, patch);
      if (more.length) throw Object.assign(new Error(`Not while an autonomous agent is working: ${more.join(', ')} would let agents do more. Try again when it has finished.`), { status: 423 });
    }
    const next = { ...settings };
    if (patch.neverPaidApi !== undefined) next.neverPaidApi = Boolean(patch.neverPaidApi);
    if (patch.allowClaudeAutomation !== undefined) next.allowClaudeAutomation = Boolean(patch.allowClaudeAutomation);
    // The most an autonomous agent may reach on this computer: nothing, its project's folder, or
    // everything. An agent's own setting only asks; this decides.
    if (patch.autonomous !== undefined && ['off', 'project', 'computer'].includes(patch.autonomous)) next.autonomous = patch.autonomous;
    if (patch.tokenSaver !== undefined) next.tokenSaver = Boolean(patch.tokenSaver);
    if (patch.allowWeakSandbox !== undefined) next.allowWeakSandbox = Boolean(patch.allowWeakSandbox);
    if (patch.localStop !== undefined) next.localStop = Boolean(patch.localStop);
    if (patch.taskDefaultPct !== undefined) next.taskDefaultPct = patch.taskDefaultPct === null || patch.taskDefaultPct === '' ? null : Math.min(100, Math.max(1, Number(patch.taskDefaultPct)));
    if (patch.provider) {
      const { name, ...rest } = patch.provider;
      const cur = { ...(next.providers[name] ?? {}) };
      if (rest.window !== undefined && WINDOWS[rest.window]) cur.window = rest.window;
      if (rest.capacity !== undefined) cur.capacity = rest.capacity === null || rest.capacity === '' ? null : Math.max(1, Number(rest.capacity));
      if (rest.reservePct !== undefined) cur.reservePct = Math.min(95, Math.max(0, Number(rest.reservePct)));
      if (rest.maxConcurrent !== undefined) cur.maxConcurrent = Math.max(1, Number(rest.maxConcurrent));
      if (rest.pauseAtLimit !== undefined) cur.pauseAtLimit = Boolean(rest.pauseAtLimit);
      if (rest.pauseAtPercent !== undefined) cur.pauseAtPercent = rest.pauseAtPercent === null || rest.pauseAtPercent === '' ? null : Math.min(100, Math.max(1, Number(rest.pauseAtPercent)));
      if (Array.isArray(rest.warnAt)) cur.warnAt = rest.warnAt.map(Number).filter((n) => [50, 75, 90, 100].includes(n));
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
        ...c, requestsInWindow: used, tokensInWindow: ledger.filter((e) => e.provider === p && e.at > now() - windowMs(c)).reduce((s, e) => s + (e.tokensIn ?? 0) + (e.tokensOut ?? 0), 0), measured: 'requests made by this worker (measured)',
        estimatedPct: c.capacity ? Math.round((used / c.capacity) * 100) : null, remainingAllowance: 'unavailable: providers do not report it to apps',
        running: [...running.values()].filter((r) => r.provider === p).length,
      };
    }
    return { allowWeakSandbox: settings.allowWeakSandbox === true, localStop: settings.localStop === true, tokenSaver: settings.tokenSaver !== false, savedChars: settings.savedChars ?? 0, neverPaidApi: settings.neverPaidApi, allowClaudeAutomation: settings.allowClaudeAutomation, autonomous: settings.autonomous ?? 'off', taskDefaultPct: settings.taskDefaultPct, providers };
  }

  return { noteSaved, useQuota, useConnections, connections: () => connections, billingBlock, blockedProviders, open, charge, close, update, status, free, settings: () => settings, tampered: () => tampered };
}

module.exports = { createBudget, PAID, widening, GUARDED };
