// The parts of an agent's setup that are not on the agents row. Every field here changes what the
// agent does: the text goes into its standing instructions on each job, the role steers who gets
// picked as a reviewer or lead, and the delegation list is enforced when it delegates. Like its
// instructions, all of this is visible to its owner only.

'use strict';

const { now, json, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');
const { PROVIDERS } = require('./catalog.cjs');

const ROLES = ['worker', 'lead', 'reviewer', 'tester'];
const TEXT = { definitionOfDone: 'Definition of Done', planning: 'Before you start', completion: 'When you finish', coordination: 'Working with the team' };
const MAX_TEXT = 2000;

// The AIs that can run as themselves, with their own tools, on their owner's computer.
const AUTONOMOUS_PROVIDERS = ['claude-cli'];

function createProfiles(crew) {
  const { db } = crew;
  db.raw.exec('CREATE TABLE IF NOT EXISTS agent_profiles (agent_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');

  const get = (agentId) => ({ orchestrationRole: 'worker', delegationTargets: [], fallbacks: [], freedom: { mode: 'limited', reach: 'project' }, ...parse(db.get('SELECT data FROM agent_profiles WHERE agent_id = ?', agentId)?.data, {}) });

  function set(agentId, userId, patch) {
    const a = crew.agents.owned(agentId, userId);
    const next = get(agentId);
    for (const k of Object.keys(TEXT)) if (patch[k] !== undefined) next[k] = String(patch[k]).slice(0, MAX_TEXT);
    if (patch.orchestrationRole !== undefined) {
      if (!ROLES.includes(patch.orchestrationRole)) throw httpError(400, `Role is one of ${ROLES.join(', ')}.`);
      next.orchestrationRole = patch.orchestrationRole;
    }
    if (patch.delegationTargets !== undefined) {
      const ids = (Array.isArray(patch.delegationTargets) ? patch.delegationTargets : []).map(String);
      for (const id of ids) if (crew.agents.get(id)?.room_id !== a.room_id) throw httpError(400, 'A delegation target has to be an agent in this office.');
      next.delegationTargets = [...new Set(ids)];
    }
    if (patch.fallbacks !== undefined) {
      const names = [...new Set((Array.isArray(patch.fallbacks) ? patch.fallbacks : []).map(String))].filter((n) => n !== a.provider);
      for (const n of names) {
        if (!PROVIDERS[n]) throw httpError(400, `Unknown AI ${n}.`);
        if (PROVIDERS[n].billing === 'paid') throw httpError(400, 'A paid API cannot be a backup. Nothing falls back to one.');
        if (n === 'claude-handoff') throw httpError(400, 'The manual handoff cannot be a backup: it needs you to run it.');
      }
      next.fallbacks = names;
    }
    if (patch.freedom !== undefined) {
      // Limited works through the office's tools; Autonomous is Claude Code as itself, in the
      // project's folder or on the whole computer. This only asks: the owner's worker decides how
      // much it allows on that computer (see lib/crew-worker/native.cjs).
      const mode = String(patch.freedom?.mode ?? '');
      const reach = String(patch.freedom?.reach ?? 'project');
      if (!['limited', 'autonomous'].includes(mode)) throw httpError(400, 'Freedom is limited or autonomous.');
      if (!['project', 'computer'].includes(reach)) throw httpError(400, 'Reach is project or computer.');
      if (mode === 'autonomous' && !AUTONOMOUS_PROVIDERS.includes(a.provider)) throw httpError(400, 'Only an agent on automated Claude Code can work autonomously. Change its AI first.');
      next.freedom = { mode, reach };
    }
    db.run('INSERT OR REPLACE INTO agent_profiles (agent_id, data, updated_at) VALUES (?,?,?)', agentId, json(next), now());
    crew.audit(a.room_id, userId, 'agent.profile', { agentId, fields: Object.keys(patch) });
    return next;
  }

  /** What goes into the system prompt, after the owner's instructions. */
  function promptSection(agentId) {
    const p = get(agentId);
    return Object.entries(TEXT).filter(([k]) => p[k]?.trim()).map(([k, title]) => `${title}:\n${p[k].trim()}`).join('\n\n');
  }

  /** Whether this agent's owner lets it hand work to that agent. An empty list means anyone. */
  function mayDelegateTo(fromId, toId) {
    const { delegationTargets: list } = get(fromId);
    return !list.length || list.includes(toId);
  }

  const role = (agentId) => get(agentId).orchestrationRole;
  const fallbacks = (agentId) => get(agentId).fallbacks;

  const freedom = (agentId) => get(agentId).freedom;

  return { fallbacks, freedom, get, set, promptSection, mayDelegateTo, role, ROLES, AUTONOMOUS_PROVIDERS };
}

module.exports = { createProfiles };
