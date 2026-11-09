// AI employees: each one belongs to exactly one player, and only that player configures,
// pauses, resumes or removes it. Room owners and admins cannot — owning the room is not
// owning the people in it.
//
// An agent is *available* when it is not paused, its room is open, its owner is still a
// member, and one of its owner's workers is connected (or registered as always-on). Only an
// available agent is on the office floor, and only an available agent's jobs are handed out.

'use strict';

const { newId, now, json, parse } = require('./db.cjs');
const { httpError, cleanName, validColor, PALETTE } = require('./auth.cjs');
const { PERMISSIONS, PROVIDERS } = require('./catalog.cjs');

const MAX_INSTRUCTIONS = 4000;

function createAgents(crew) {
  const { db } = crew;

  function shape(a, viewerId = null) {
    if (!a) return null;
    const owner = crew.auth.getUser(a.owner_id);
    const mine = viewerId === a.owner_id;
    return {
      id: a.id, roomId: a.room_id, ownerId: a.owner_id, ownerName: owner?.displayName ?? '?', ownerColor: owner?.color,
      name: a.name, role: a.role, skills: parse(a.skills, []), tools: parse(a.tools, []), provider: a.provider, model: a.model,
      color: a.color, autonomy: a.autonomy, budgetUsd: a.budget_usd, spentUsd: a.spent_usd, tokensIn: a.tokens_in, tokensOut: a.tokens_out,
      status: a.status, paused: Boolean(a.paused), isManager: Boolean(a.is_manager), currentTaskId: a.current_task_id,
      available: available(a), createdAt: a.created_at,
      // The owner's standing instructions are theirs: another player sees the job title, not the brief.
      instructions: mine ? a.instructions : undefined,
    };
  }

  function validate(input, existing = {}) {
    const out = {};
    const name = input.name !== undefined ? cleanName(input.name) : existing.name;
    if (!name) throw httpError(400, 'An agent needs a name.');
    out.name = name;
    out.role = input.role !== undefined ? cleanName(input.role) || 'Generalist' : existing.role ?? 'Generalist';
    const skills = input.skills !== undefined ? input.skills : parse(existing.skills, []);
    out.skills = (Array.isArray(skills) ? skills : String(skills).split(',')).map((s) => cleanName(s).toLowerCase()).filter(Boolean).slice(0, 20);
    out.instructions = String(input.instructions ?? existing.instructions ?? '').slice(0, MAX_INSTRUCTIONS);
    // Never a paid API by default: a new agent starts on the owner's own plan.
    out.provider = input.provider ?? existing.provider ?? 'chatgpt-plan';
    if (!PROVIDERS[out.provider]) throw httpError(400, `Unknown provider ${out.provider}.`);
    out.model = String(input.model ?? existing.model ?? PROVIDERS[out.provider].defaultModel).slice(0, 80);
    const tools = input.tools !== undefined ? input.tools : parse(existing.tools, ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'web', 'git']);
    out.tools = [...new Set((tools ?? []).filter((t) => PERMISSIONS[t]))];
    out.color = validColor(input.color) ?? existing.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
    out.autonomy = input.autonomy ?? existing.autonomy ?? 'auto';
    if (!['auto', 'ask'].includes(out.autonomy)) throw httpError(400, 'Autonomy is auto or ask.');
    const budget = Number(input.budgetUsd ?? existing.budget_usd ?? 5);
    if (!(budget >= 0 && budget <= 10_000)) throw httpError(400, 'Budget must be between 0 and 10000 USD.');
    out.budget = budget;
    out.isManager = input.isManager !== undefined ? Boolean(input.isManager) : Boolean(existing.is_manager);
    return out;
  }

  function create(roomId, userId, input) {
    crew.rooms.require(roomId, userId, 'agents.create');
    const count = db.get('SELECT COUNT(*) n FROM agents WHERE room_id = ? AND owner_id = ? AND removed = 0', roomId, userId).n;
    if (count >= 12) throw httpError(409, 'A player can bring at most 12 agents into one office.');
    const v = validate(input);
    const id = newId('agt');
    db.run(`INSERT INTO agents (id, room_id, owner_id, name, role, skills, instructions, provider, model, tools, color, autonomy, budget_usd, is_manager, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, roomId, userId, v.name, v.role, json(v.skills), v.instructions, v.provider, v.model, json(v.tools), v.color, v.autonomy, v.budget, v.isManager ? 1 : 0, now());
    crew.audit(roomId, userId, 'agent.create', { agentId: id, name: v.name });
    publish(id);
    refreshPresence(id);
    return shape(get(id), userId);
  }

  const get = (id) => db.get('SELECT * FROM agents WHERE id = ? AND removed = 0', id);

  function owned(agentId, userId) {
    const a = get(agentId);
    if (!a) throw httpError(404, 'No such agent.');
    if (a.owner_id !== userId) throw httpError(403, 'Only this agent’s owner can do that.');
    return a;
  }

  function update(agentId, userId, input) {
    const a = owned(agentId, userId);
    const v = validate(input, a);
    db.run(`UPDATE agents SET name=?, role=?, skills=?, instructions=?, provider=?, model=?, tools=?, color=?, autonomy=?, budget_usd=?, is_manager=? WHERE id=?`,
      v.name, v.role, json(v.skills), v.instructions, v.provider, v.model, json(v.tools), v.color, v.autonomy, v.budget, v.isManager ? 1 : 0, agentId);
    crew.work.followAgentTools(agentId, parse(a.tools, []), v.tools);
    crew.audit(a.room_id, userId, 'agent.update', { agentId });
    publish(agentId);
    crew.office.agentIdentity(get(agentId));
    if (v.budget > a.spent_usd && a.status === 'BLOCKED') setStatus(agentId, 'IDLE');
    crew.work.kick();
    return shape(get(agentId), userId);
  }

  function setPaused(agentId, userId, paused) {
    const a = owned(agentId, userId);
    db.run('UPDATE agents SET paused = ? WHERE id = ?', paused ? 1 : 0, agentId);
    if (paused) crew.jobs.cancelForAgent(agentId, 'paused by owner', { keepTasks: true });
    setStatus(agentId, paused ? 'PAUSED' : 'IDLE');
    crew.audit(a.room_id, userId, paused ? 'agent.pause' : 'agent.resume', { agentId });
    refreshPresence(agentId);
    crew.work.kick();
    return shape(get(agentId), userId);
  }

  function remove(agentId, userId) {
    const a = owned(agentId, userId);
    crew.jobs.cancelForAgent(agentId, 'agent removed');
    crew.work.unassignAgent(agentId);
    db.run('UPDATE agents SET removed = 1, status = ? WHERE id = ?', 'CANCELLED', agentId);
    db.run('DELETE FROM project_grants WHERE agent_id = ?', agentId);
    crew.audit(a.room_id, userId, 'agent.remove', { agentId });
    crew.office.agentLeft(a);
    crew.hub.broadcast(a.room_id, 'agent.removed', { id: agentId });
  }

  function available(a) {
    if (!a || a.removed || a.paused) return false;
    const room = crew.rooms.get(a.room_id);
    if (!room || room.status !== 'open') return false;
    if (!crew.rooms.roleOf(a.room_id, a.owner_id)) return false;
    return crew.workers.userOnline(a.room_id, a.owner_id);
  }

  function setStatus(agentId, status, extra = {}) {
    const a = get(agentId);
    if (!a) return;
    let next = status;
    if (a.paused && status !== 'PAUSED' && status !== 'CANCELLED') next = 'PAUSED';
    db.run('UPDATE agents SET status = ?, current_task_id = ? WHERE id = ?', next, extra.taskId !== undefined ? extra.taskId : a.current_task_id, agentId);
    publish(agentId);
  }

  function addUsage(agentId, tokensIn, tokensOut, usd) {
    db.run('UPDATE agents SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, spent_usd = spent_usd + ? WHERE id = ?', tokensIn, tokensOut, usd, agentId);
    publish(agentId);
  }

  /** Put the agent on the floor, or take it off, to match whether it is available. */
  function refreshPresence(agentId) {
    const a = db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!a) return;
    const avail = available(a);
    if (!avail && !a.paused && !a.removed && a.status !== 'OFFLINE') {
      db.run("UPDATE agents SET status = 'OFFLINE' WHERE id = ?", agentId);
    } else if (avail && a.status === 'OFFLINE') {
      db.run("UPDATE agents SET status = 'IDLE' WHERE id = ?", agentId);
    }
    crew.office.agentPresence(db.get('SELECT * FROM agents WHERE id = ?', agentId), avail);
    publish(agentId);
  }

  function publish(agentId) {
    const a = db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!a || a.removed) return;
    crew.hub.broadcast(a.room_id, 'agent', shape(a));
    // The owner's own view carries the instructions.
    crew.hub.broadcast(a.room_id, 'agent', shape(a, a.owner_id), { toUser: a.owner_id });
  }

  const list = (roomId, viewerId) => db.all('SELECT * FROM agents WHERE room_id = ? AND removed = 0 ORDER BY created_at', roomId).map((a) => shape(a, viewerId));
  const ofOwner = (roomId, userId) => db.all('SELECT * FROM agents WHERE room_id = ? AND owner_id = ? AND removed = 0', roomId, userId);

  /** Find an agent in a room by id or by (case-insensitive) name — how agents address each other. */
  function resolve(roomId, ref) {
    const s = String(ref ?? '').trim().replace(/^@/, '');
    return db.get('SELECT * FROM agents WHERE room_id = ? AND removed = 0 AND (id = ? OR name = ? COLLATE NOCASE)', roomId, s, s);
  }

  return { create, get, update, setPaused, remove, available, setStatus, addUsage, refreshPresence, publish, list, ofOwner, resolve, shape, owned };
}

module.exports = { createAgents };
