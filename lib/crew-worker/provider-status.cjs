// What each AI connection on this computer can actually do right now, in five honest words:
//
//   Connected             set up, but not yet proven by a real request
//   Working               a real request succeeded (Test Connection)
//   Limited               works with restrictions, or a limit is in force
//   Requires User Action  the owner has to do something first
//   Not Supported         not available here
//
// Only the state and a one-line reason go to the room host. A green state is never shown for a
// flow nobody has run: Working comes only from a Test Connection that really got an answer.

'use strict';

const { execFile } = require('child_process');
const { createProvider } = require('./providers.cjs');

const STATES = { CONNECTED: 'Connected', WORKING: 'Working', LIMITED: 'Limited', ACTION: 'Requires User Action', UNSUPPORTED: 'Not Supported' };

function createProviderStatus({ vault, budget }) {
  const tested = new Map(); // provider -> { ok, reason, at }
  const installed = new Map();

  function checkCli(cmd) {
    return new Promise((resolve) => {
      const win = process.platform === 'win32';
      execFile(cmd, ['--version'], { shell: win, timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().slice(0, 60)));
    });
  }

  async function refreshInstalled() {
    installed.set('claude', await checkCli(process.env.CREW_CLAUDE_CLI || 'claude'));
    installed.set('codex', await checkCli(process.env.CREW_CODEX_CLI || 'codex'));
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
    if (provider === 'scripted') return { state: STATES.LIMITED, reason: 'Test provider: fixed scripts, not AI.' };
    const t = tested.get(provider);
    if (t?.limit) return { state: STATES.LIMITED, reason: t.reason };
    if (t?.ok) return { state: STATES.WORKING, reason: `A real request succeeded ${new Date(t.at).toLocaleString()}.` };
    if (t) return { state: STATES.ACTION, reason: t.reason };
    return { state: STATES.CONNECTED, reason: 'Set up, but not tested yet. Press Test Connection.' };
  }

  function all(names) { return Object.fromEntries(names.map((n) => [n, state(n)])); }

  /** Sends one small real request. Refused outright for anything billing has blocked. */
  async function test(provider, model) {
    if (provider === 'claude-handoff') return { ok: false, reason: 'Manual route: nothing to test from here. Run `claude` yourself to check it is signed in.' };
    const block = budget.billingBlock(provider);
    if (block) { tested.set(provider, { ok: false, reason: block, at: Date.now() }); return { ok: false, reason: block }; }
    try {
      const p = createProvider(provider, vault, budget);
      const r = await p.complete({ system: 'Connection test. Reply with the single word: ok', transcript: [{ role: 'user', text: 'Reply with the single word: ok' }], tools: [], model: model || 'default', effort: 'low' });
      const ok = Boolean(r.text?.trim());
      tested.set(provider, { ok, reason: ok ? '' : 'The provider answered with nothing.', at: Date.now() });
      return { ok, reason: ok ? `Got an answer from ${r.model}.` : 'The provider answered with nothing.' };
    } catch (err) {
      tested.set(provider, { ok: false, limit: Boolean(err.limit), reason: err.message, at: Date.now() });
      return { ok: false, limit: Boolean(err.limit), reason: err.message };
    }
  }

  return { state, all, test, refreshInstalled, STATES };
}

module.exports = { createProviderStatus, STATES };
