// Which AI a job uses, among the ones its owner explicitly listed for this agent.
//
// This is the whole of routing here, and it is deliberately small. It never reaches a paid API,
// because the host refuses those on the list and PAID below refuses them again. It moves only
// when a provider reports a limit or a sign-in problem, tries each AI at most once per job, and
// gives up by pausing. docs/developer/9router-assessment.md says why it stops there.

'use strict';

const { PROVIDERS } = require('../crew/catalog.cjs');

const COOLDOWN_MS = 60 * 60_000;
const NEVER_A_BACKUP = new Set(['claude-handoff']);

/** Providers that said stop, and when to believe them no longer. On this computer only. */
const cooling = new Map();

const mayBeBackup = (name) => Boolean(PROVIDERS[name]) && PROVIDERS[name].billing !== 'paid' && !NEVER_A_BACKUP.has(name);

/**
 * The next AI to try, or null. `tried` is this job's own record, so it can never loop.
 * An agent with no backups always tries its one AI: the provider's own answer is the pause.
 */
function nextProvider(agent, tried, budget = null, now = Date.now()) {
  const backups = (agent.fallbacks ?? []).filter(mayBeBackup);
  if (!backups.length) return tried.has(agent.provider) ? null : agent.provider;
  for (const name of [agent.provider, ...backups]) {
    if (tried.has(name)) continue;
    if ((cooling.get(name) ?? 0) > now) continue;
    if (budget?.billingBlock(name)) continue;
    if (budget?.blockedProviders([name]).length) continue;
    return name;
  }
  return null;
}

function reportedLimit(name, now = Date.now()) { cooling.set(name, now + COOLDOWN_MS); }
function worked(name) { cooling.delete(name); }
function resetForTests() { cooling.clear(); }

module.exports = { nextProvider, reportedLimit, worked, mayBeBackup, resetForTests, COOLDOWN_MS };
