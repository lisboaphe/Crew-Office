// What each AI connection on this computer can actually do right now, in five honest words:
//
//   Connected             set up, but not yet proven by a real request
//   Working               a real request succeeded: Test Connection, or an agent's task
//   Limited               works with restrictions, or a limit is in force
//   Requires User Action  the owner has to do something first
//   Not Supported         not available here
//
// Only the state and a one-line reason go to the room host. A green state is never shown for a
// flow nobody has run: Working comes only from a real answer, to Test Connection or to a task.
// A task that hits a plan's limit or finds the sign-in gone says so here too (see health.cjs).

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createProvider } = require('./providers.cjs');
const { DEFS } = require('./ai-connections.cjs');
const health = require('./health.cjs');

const SAVE_EVERY_MS = 5 * 60_000; // a run of good answers is written down once in a while, not each time

const STATES = { CONNECTED: 'Connected', WORKING: 'Working', LIMITED: 'Limited', ACTION: 'Requires User Action', UNSUPPORTED: 'Not Supported' };

function createProviderStatus({ vault, budget, dataDir = null }) {
  // What the last real test found survives a restart, with when it happened, so a connection
  // proven yesterday does not read as never tried. Only ever written by a real test below.
  const testsFile = dataDir ? path.join(dataDir, 'provider-tests.json') : null;
  let saved = [];
  try { if (testsFile) saved = Object.entries(JSON.parse(fs.readFileSync(testsFile, 'utf8'))); } catch { /* first run */ }
  const tested = new Map(saved); // provider -> { ok, reason, at }
  const remember = (provider, result) => {
    tested.set(provider, result);
    if (!testsFile) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(testsFile, JSON.stringify(Object.fromEntries(tested)));
  };
  const installed = new Map();

  // A task's outcome. A change is written at once; more of the same only now and then.
  const stopListening = health.listen((provider, outcome) => {
    const prev = tested.get(provider);
    const next = { ok: Boolean(outcome.ok), limit: Boolean(outcome.limit), reason: outcome.reason ?? '', at: Date.now(), from: 'task' };
    const changed = !prev || prev.ok !== next.ok || Boolean(prev.limit) !== next.limit;
    if (changed || next.at - (prev.at ?? 0) > SAVE_EVERY_MS) remember(provider, next);
    else tested.set(provider, next);
  });

  function checkCli(cmd) {
    return new Promise((resolve) => {
      const win = process.platform === 'win32';
      execFile(cmd, ['--version'], { shell: win, timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().slice(0, 60)));
    });
  }

  async function refreshInstalled() {
    installed.set('claude', await checkCli(process.env.CREW_CLAUDE_CLI || 'claude'));
    installed.set('codex', await checkCli(process.env.CREW_CODEX_CLI || 'codex'));
    installed.set('opencode', await checkCli(process.env.CREW_OPENCODE_CLI || 'opencode'));
    installed.set('kiro', await checkCli(process.env.CREW_KIRO_CLI || 'kiro-cli'));
  }

  function state(provider) {
    const block = budget.billingBlock(provider);
    if (provider === 'anthropic' || provider === 'openai') {
      if (block) return { state: STATES.ACTION, reason: block };
      if (!vault.get(provider).apiKey) return { state: STATES.ACTION, reason: 'No API key on this computer.' };
    }
    if (provider === 'claude-cli') {
      if (block) return { state: STATES.UNSUPPORTED, reason: 'Off: Anthropic does not allow third-party apps to route requests through Claude plan credentials on behalf of users. Use the manual handoff.' };
      if (installed.get('claude') === null) return { state: STATES.ACTION, reason: 'Claude Code is not installed on this computer.' };
    }
    if (provider === 'claude-handoff') {
      if (installed.get('claude') === null) return { state: STATES.ACTION, reason: 'Install Claude Code and sign in with your own account.' };
      return { state: STATES.LIMITED, reason: 'Manual: you run each task in your own Claude Code, then press Done on this worker.' };
    }
    if (provider === 'codex-cli' && installed.get('codex') === null) return { state: STATES.ACTION, reason: 'Codex is not installed on this computer. Install it and run: codex login' };
    if (provider === 'chatgpt-plan') {
      const s = vault.getSecret('chatgptPlan') ?? {};
      if (!s.accessToken) return { state: STATES.ACTION, reason: 'Press “Sign in with ChatGPT” on this worker’s settings page.' };
    }
    const def = DEFS[provider];
    if (def) {
      if (def.cli && installed.get(def.cli) === null) return { state: STATES.ACTION, reason: `${def.name} is not installed on this computer.` };
      const missing = def.fields.find((f) => !f.optional && !vault.get(provider)[f.name]);
      if (missing) return { state: STATES.ACTION, reason: `${def.name} needs your ${missing.label} on this computer.` };
      if (block) return { state: STATES.ACTION, reason: block };
    }
    if (provider === 'scripted') return { state: STATES.LIMITED, reason: 'Test provider: fixed scripts, not AI.' };
    const t = tested.get(provider);
    if (t?.limit) return { state: STATES.LIMITED, reason: t.reason };
    if (t?.ok) return { state: STATES.WORKING, reason: t.from === 'task' ? `An agent’s task got an answer ${new Date(t.at).toLocaleString()}.` : `A real request succeeded ${new Date(t.at).toLocaleString()}.` };
    if (t) return { state: STATES.ACTION, reason: t.reason };
    return { state: STATES.CONNECTED, reason: 'Set up, but not tested yet. Press Test Connection.' };
  }

  /** The room hears a state, a reason, and whether the chosen model takes tools. No account facts. */
  function all(names) {
    const conn = budget.connections?.();
    return Object.fromEntries(names.map((n) => {
      const s = state(n);
      const chosen = conn?.def(n) ? conn.resolveModel(n, 'default') : null;
      return [n, chosen ? { ...s, tools: conn.toolsOf(n, chosen) } : s];
    }));
  }

  /** Sends one small real request. Refused outright for anything billing has blocked. */
  async function test(provider, model) {
    if (provider === 'claude-handoff') return { ok: false, reason: 'Manual route: nothing to test from here. Run `claude` yourself to check it is signed in.' };
    const block = budget.billingBlock(provider);
    if (block) { remember(provider, { ok: false, reason: block, at: Date.now() }); return { ok: false, reason: block }; }
    try {
      const conn = budget.connections?.();
      const neverPaid = budget.status().neverPaidApi;
      let use = model || 'default';
      if (conn?.def(provider) && use === 'default') {
        use = await conn.modelForTest(provider, { neverPaid });
        if (!use) { const reason = 'This connection has no model that may run. Nothing was sent.'; remember(provider, { ok: false, reason, at: Date.now() }); return { ok: false, reason }; }
      }
      const p = createProvider(provider, vault, budget);
      const r = await p.complete({ system: 'Connection test. Reply with the single word: ok', transcript: [{ role: 'user', text: 'Reply with the single word: ok' }], tools: [], model: use, effort: 'low' });
      const ok = Boolean(r.text?.trim());
      remember(provider, { ok, reason: ok ? '' : 'The provider answered with nothing.', at: Date.now() });
      return { ok, reason: ok ? `Got an answer from ${r.model}.` : 'The provider answered with nothing.' };
    } catch (err) {
      remember(provider, { ok: false, limit: Boolean(err.limit), reason: err.message, at: Date.now() });
      return { ok: false, limit: Boolean(err.limit), reason: err.message };
    }
  }

  /** A new sign-in has not been proven by a test the old one passed. */
  const forget = (provider) => { tested.delete(provider); if (testsFile) fs.writeFileSync(testsFile, JSON.stringify(Object.fromEntries(tested))); };

  return { state, all, test, forget, refreshInstalled, STATES, close: stopListening };
}

module.exports = { createProviderStatus, STATES };
