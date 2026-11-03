// The bridge from what the crew backend does to what the 3D office shows.
//
// The office already knows how to stage Agent Office Protocol events: a `session.start`
// walks a character in and seats them, `turn.start` puts a job on their desk, a `search`
// tool sends them to the bookshelf, `permission.request` turns them amber, `turn.end`
// carries a page to the outbox. So this module speaks AOP into each room's existing bus,
// under the harness name `crew`, and every animation on the floor is caused by a real
// backend event. Nothing here invents activity.
//
// Things AOP has no word for — speech bubbles, two agents in conversation — go out on the
// room's realtime hub instead, for the overlay to draw.

'use strict';

const crypto = require('crypto');

const HARNESS = { name: 'crew', version: '1' };
const CAPABILITIES = ['session.start', 'session.heartbeat', 'session.end', 'turn.start', 'turn.end', 'tool.start', 'tool.end',
  'permission.request', 'permission.resolve', 'artifact.change', 'job.queued', 'job.claimed', 'notification'];
const HEARTBEAT_MS = 15_000;

function createOfficeBridge(crew) {
  /** roomCode -> Map(sessionId -> { session, seq, turn }) */
  const live = new Map();
  let beat = null;

  function ensure(code) {
    if (!crew.store) return null;
    let office = crew.store.get(code);
    let fresh = false;
    if (!office) { office = crew.store.open(code); fresh = true; }
    const scene = office.scenes[0];
    if (scene && (scene.sources.length !== 1 || scene.sources[0] !== 'crew')) {
      crew.store.updateScene(code, scene.id, { sources: ['crew'], name: scene.name ?? 'Shared office' });
    }
    if (fresh) {
      // The office was reaped or this host restarted: the bus is empty, so restate who is here.
      const sessions = live.get(code);
      if (sessions) for (const s of sessions.values()) { s.seq = 0; s.turn = null; startSession(code, s.session); }
    }
    return office;
  }

  function emit(code, type, session, payload = {}) {
    const office = ensure(code);
    if (!office) return;
    const sessions = live.get(code);
    const s = sessions?.get(session.id);
    const seq = s ? ++s.seq : 0;
    office.bus.accept({ aop: '0.2', id: crypto.randomUUID(), ts: new Date().toISOString(), seq: seq || undefined, type, harness: HARNESS, session, project: { id: 'crew', name: 'Shared office' }, payload });
    crew.store.touch?.(office);
  }

  function startSession(code, session) {
    let sessions = live.get(code);
    if (!sessions) { sessions = new Map(); live.set(code, sessions); }
    const existing = sessions.get(session.id);
    if (!existing) sessions.set(session.id, { session, seq: 0, turn: null });
    else existing.session = session;
    emit(code, 'session.start', session, { source: existing ? 'attach' : 'startup', capabilities: CAPABILITIES });
    ensureBeat();
  }

  function endSession(code, sessionId, reason = 'exit') {
    const s = live.get(code)?.get(sessionId);
    if (!s) return;
    if (s.turn) emit(code, 'turn.end', s.session, { turn_id: s.turn, status: 'cancelled' });
    emit(code, 'session.end', s.session, { reason });
    live.get(code).delete(sessionId);
  }

  function ensureBeat() {
    if (beat) return;
    beat = setInterval(() => {
      for (const [code, sessions] of live) for (const s of sessions.values()) emit(code, 'session.heartbeat', s.session, { status: s.turn ? 'working' : 'idle' });
    }, HEARTBEAT_MS);
    beat.unref?.();
  }

  const codeOf = (roomId) => crew.rooms.get(roomId)?.code;

  function agentSession(a) {
    const owner = crew.auth.getUser(a.owner_id);
    return { id: a.id, kind: 'main', actor: a.name, actor_color: a.color, label: `${a.role} · ${owner?.displayName ?? ''}`.slice(0, 60), agent_type: a.role.slice(0, 40) };
  }

  function sessionFor(agent) {
    const code = agent && codeOf(agent.room_id);
    if (!code) return null;
    const s = live.get(code)?.get(agent.id);
    return s ? { code, s } : null;
  }

  // --- presence ---

  function agentPresence(a, available) {
    const code = codeOf(a.room_id);
    if (!code) return;
    const present = live.get(code)?.has(a.id);
    if (available && !present) startSession(code, agentSession(a));
    if (!available && present) endSession(code, a.id, a.paused ? 'other' : 'logout');
  }

  function agentIdentity(a) {
    const code = codeOf(a.room_id);
    if (code && live.get(code)?.has(a.id)) startSession(code, agentSession(a));
  }

  function agentLeft(a) {
    const code = codeOf(a.room_id);
    if (code) endSession(code, a.id, 'exit');
  }

  /** Human players are characters too: they walk in when they open the office. */
  function humanPresence(roomId, user, online) {
    const code = codeOf(roomId);
    if (!code || !user) return;
    const id = `human-${user.id}`;
    if (online) startSession(code, { id, kind: 'main', actor: user.displayName.includes(' ') ? user.displayName : `${user.displayName} (human)`, actor_color: user.color, label: `Human player · ${user.displayName}` });
    else endSession(code, id, 'logout');
  }

  // --- work ---

  function jobQueued(roomId, task, agent) {
    const code = codeOf(roomId);
    if (code) emit(code, 'job.queued', { id: 'queue' }, { job_id: task.id, title: task.title.slice(0, 80), source: 'crew' });
    if (agent) crew.hub.broadcast(roomId, 'react', { agentId: agent.id, kind: 'assigned', text: `New task: ${task.title}` });
  }

  function jobStarted(agent, title, job) {
    const at = sessionFor(agent);
    if (!at) return;
    if (at.s.turn) emit(at.code, 'turn.end', at.s.session, { turn_id: at.s.turn, status: 'completed' });
    at.s.turn = job.id;
    if (job.type === 'task') emit(at.code, 'job.claimed', { id: 'queue' }, { job_id: job.ref_id, claimed_by: agent.id });
    emit(at.code, 'turn.start', at.s.session, { turn_id: job.id, title: String(title).slice(0, 80), trigger: job.type === 'task' ? 'queue' : 'parent', origin: { kind: job.type === 'task' ? 'queue' : 'parent' } });
  }

  function jobEnded(agent, job, status, summary) {
    const at = sessionFor(agent);
    if (!at || at.s.turn !== job.id) return;
    const map = { done: 'completed', failed: 'error', waiting: 'blocked', cancelled: 'cancelled', retrying: 'error' };
    emit(at.code, 'turn.end', at.s.session, { turn_id: job.id, status: map[status] ?? 'completed', summary: summary ? String(summary).slice(0, 200) : undefined });
    at.s.turn = null;
  }

  function toolStart(agent, job, name, args) {
    const at = sessionFor(agent);
    if (!at) return;
    const { TOOLS } = require('./catalog.cjs');
    const target = args?.path ?? args?.agent ?? args?.to ?? args?.url ?? undefined;
    emit(at.code, 'tool.start', at.s.session, { tool_call_id: `${job.id}:${name}:${at.s.seq}`, tool_name: name, tool_class: TOOLS[name]?.class ?? 'other', target: target ? String(target).slice(0, 80) : undefined });
    at.s.lastTool = `${job.id}:${name}:${at.s.seq - 1}`;
  }

  function toolEnd(agent, job, name, status) {
    const at = sessionFor(agent);
    if (!at || !at.s.lastTool) return;
    emit(at.code, 'tool.end', at.s.session, { tool_call_id: at.s.lastTool, tool_name: name, status });
    at.s.lastTool = null;
  }

  function artifact(agent, path) {
    const at = sessionFor(agent);
    if (at) emit(at.code, 'artifact.change', at.s.session, { kind: 'file', path: String(path).slice(0, 120) });
  }

  function taskDone(agent, task, paths) {
    crew.hub.broadcast(agent.room_id, 'react', { agentId: agent.id, kind: 'completed', text: `Finished: ${task.title}`, files: paths });
  }

  function waitingOnHuman(agent, approvalId, detail) {
    const at = sessionFor(agent);
    if (at) emit(at.code, 'permission.request', at.s.session, { request_id: approvalId, tool_name: detail?.tool ?? 'approval', reason: String(detail?.summary ?? detail?.reason ?? detail?.title ?? 'needs a human').slice(0, 120) });
  }

  function humanDecided(agent, approvalId, ok) {
    const at = agent && sessionFor(agent);
    if (at) emit(at.code, 'permission.resolve', at.s.session, { request_id: approvalId, decision: ok ? 'allow' : 'deny', by: 'user' });
  }

  // --- overlay-only events ---

  function speech(agentId, text, toAgentId) {
    const a = crew.agents.get(agentId);
    if (a) crew.hub.broadcast(a.room_id, 'bubble', { agentId, toAgentId, text: String(text).slice(0, 220) });
  }

  function meeting(a, b, on) {
    crew.hub.broadcast(a.room_id, 'meeting', { agents: [a.id, b.id], on });
  }

  function stop() { if (beat) clearInterval(beat); beat = null; }

  return { ensure, agentPresence, agentIdentity, agentLeft, humanPresence, jobQueued, jobStarted, jobEnded, toolStart, toolEnd, artifact, taskDone, waitingOnHuman, humanDecided, speech, meeting, stop };
}

module.exports = { createOfficeBridge };
