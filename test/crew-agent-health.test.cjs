// Whether an agent's AI can work, as players see it: real tasks count as checks, a sign-out or a
// used-up plan shows at once, and the owner hears when an AI one of their agents runs on breaks.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVault } = require('../lib/crew-worker/vault.cjs');
const { createBudget } = require('../lib/crew-worker/budget.cjs');
const { createProviderStatus } = require('../lib/crew-worker/provider-status.cjs');
const health = require('../lib/crew-worker/health.cjs');
const { makeCrew, room, agent } = require('./lib/crew-unit.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-health-'));

function claudeStatus(t) {
  const dir = tmp();
  const vault = createVault(dir, { platform: 'none' });
  const budget = createBudget(dir);
  budget.update({ allowClaudeAutomation: true });
  const status = createProviderStatus({ vault, budget, dataDir: dir });
  t.after(() => status.close());
  return { status, dir };
}

test('an agent’s task getting an answer counts as a check, as Test Connection does', (t) => {
  const { status, dir } = claudeStatus(t);
  assert.equal(status.state('claude-cli').state, 'Connected', 'set up, not proven');
  health.observe('claude-cli', { ok: true });
  const s = status.state('claude-cli');
  assert.equal(s.state, 'Working');
  assert.match(s.reason, /An agent’s task got an answer/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'provider-tests.json'), 'utf8'))['claude-cli'].ok, true, 'and it is remembered');
});

test('a sign-out or a used-up plan during a task shows at once, with the reason', (t) => {
  const { status } = claudeStatus(t);
  health.observe('claude-cli', { ok: true });
  health.observe('claude-cli', { ok: false, signIn: true, reason: 'Claude Code on this worker is not signed in.' });
  assert.deepEqual(status.state('claude-cli'), { state: 'Requires User Action', reason: 'Claude Code on this worker is not signed in.' });
  health.observe('claude-cli', { ok: false, limit: true, reason: 'Your Claude plan’s usage limit was reached.' });
  assert.equal(status.state('claude-cli').state, 'Limited');
  health.observe('claude-cli', { ok: true });
  assert.equal(status.state('claude-cli').state, 'Working', 'and it comes back');
});

test('a closed status stops listening', (t) => {
  const { status } = claudeStatus(t);
  status.close();
  health.observe('claude-cli', { ok: true });
  assert.equal(status.state('claude-cli').state, 'Connected');
});

test('the owner hears once when an AI their agents run on stops working', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  agent(crew, r.id, alice.id, 'Clara', 'Developer', { provider: 'claude-cli', model: 'default' });
  agent(crew, r.id, alice.id, 'Hana', 'Writer', { provider: 'claude-handoff', model: 'default' });
  const w = { room_id: r.id, user_id: alice.id };
  const notes = () => crew.db.all('SELECT text, link FROM notifications WHERE room_id = ? AND user_id = ?', r.id, alice.id);
  const report = (claude, handoff = { state: 'Limited', reason: 'Manual.' }) => crew.workers.reportProviders(w, { 'claude-cli': claude, 'claude-handoff': handoff, gemini: { state: 'Requires User Action', reason: 'needs a key' } });

  report({ state: 'Working', reason: 'fine' });
  assert.equal(notes().length, 0, 'nothing to say while it works, the manual route included, and an AI no agent uses');

  report({ state: 'Requires User Action', reason: 'Claude Code on this worker is not signed in.' });
  assert.equal(notes().length, 1);
  assert.match(notes()[0].text, /^Clara cannot work right now: Claude plan — automated Claude Code.*not signed in/);
  assert.equal(notes()[0].link, 'ai:claude-cli');

  report({ state: 'Requires User Action', reason: 'still not signed in' });
  assert.equal(notes().length, 1, 'not again while it stays broken');

  report({ state: 'Working', reason: 'fine' });
  report({ state: 'Limited', reason: 'usage limit' });
  assert.equal(notes().length, 1, 'not again while the first is unread');

  crew.db.run('UPDATE notifications SET read = 1 WHERE room_id = ? AND user_id = ?', r.id, alice.id);
  report({ state: 'Working', reason: 'fine' });
  report({ state: 'Limited', reason: 'Your Claude plan’s usage limit was reached.' });
  assert.equal(notes().length, 2, 'once read, a new break is news');
});
