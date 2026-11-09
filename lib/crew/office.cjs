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
  'permission.request', 'permission.resolve', 'artifact.change', 'notification'];
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

  /**
   * Furnish a new room with enough desks for a crew.
   *
   * The office generates a room per scene from a seed, and a seed can just as well give a
   * two-desk back room as a fourteen-desk floor. A shared office with two players and six
   * agents in a three-desk room would leave most of the team standing in the street, so
   * the host runs the same generator first, trying seeds until one has MIN_DESKS desks
   * (or keeping the largest it saw), and stores that plan before anyone opens the room.
   * A scene that already has a look is never touched.
   */
  let planModule = null;
  async function furnish(code, minDesks = Number(process.env.CREW_MIN_DESKS) || 10) {
    const office = ensure(code);
    const scene = office?.scenes[0];
    if (!scene || scene.look || scene.layout) return null;
    planModule ??= await import(require('url').pathToFileURL(require('path').join(crew.root, 'src', 'plan', 'index.js')).href);
    let best = null;
    for (let n = 0; n < 40; n++) {
      const g = planModule.generateOffice(`${code}:${n}`);
      const desks = Object.keys(g.layout?.desks ?? {}).length;
      if (!best || desks > best.desks) best = { g, desks };
      if (desks >= minDesks) break;
      await new Promise((r) => setImmediate(r));
    }
    crew.store.updateScene(code, scene.id, { look: best.g.look, layout: best.g.layout });
    return best.desks;
  }

  const codeOf = (roomId) => crew.rooms.get(roomId)?.code;

  /**
   * What an agent is doing right now, in two words and a target — the status pill the
   * overlay draws above the character. Sent at every real step: a job starting, each
   * tool call, the model thinking between calls, waiting, and going idle.
   */
  const ACTIVITY = {
    read_file: ['📖', 'Reading'], list_files: ['🗂️', 'Browsing files'], write_file: ['✏️', 'Writing'], delete_file: ['🗑️', 'Deleting'],
    search_memory: ['📚', 'Checking notes'], code_graph: ['🗺️', 'Reading the code map'], write_note: ['📝', 'Noting'], send_message: ['💬', 'Messaging'], ask_agent: ['❓', 'Asking'],
    report_progress: ['📣', 'Reporting'], delegate_task: ['📣', 'Delegating'], start_project: ['🚀', 'Starting a project'], request_review: ['🔍', 'Requesting review'],
    request_human_approval: ['✋', 'Waiting for approval'], submit_plan: ['🗺️', 'Planning'], complete_task: ['✅', 'Handing in'],
    run_command: ['⚙️', 'Running'], fetch_url: ['🌐', 'Browsing'], remember: ['🧠', 'Remembering'], recall: ['🧠', 'Recalling'],
    list_team: ['👥', 'Checking the team'], read_task: ['📋', 'Checking the board'],
  };
  function activity(agent, emoji, verb, target = null) {
    if (!agent) return;
    crew.hub.broadcast(agent.room_id, 'activity', { agentId: agent.id, emoji, verb, target: target ? String(target).slice(0, 60) : null });
  }

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
    // No `job.queued` here: the office already delivers every `turn.start` as mail
    // addressed to its agent, and an unaddressed envelope would sit in the box forever.
    void code;
    if (agent) crew.hub.broadcast(roomId, 'react', { agentId: agent.id, kind: 'assigned', text: `New task: ${task.title}` });
  }

  function jobStarted(agent, title, job) {
    const at = sessionFor(agent);
    if (!at) return;
    if (at.s.turn) emit(at.code, 'turn.end', at.s.session, { turn_id: at.s.turn, status: 'completed' });
    at.s.turn = job.id;
    activity(agent, job.type === 'reply' ? '💬' : '🤔', job.type === 'reply' ? 'Answering' : job.type === 'chat' ? 'Chatting' : 'Thinking', job.type === 'task' ? title : null);
    emit(at.code, 'turn.start', at.s.session, { turn_id: job.id, title: String(title).slice(0, 80), trigger: job.type === 'task' ? 'queue' : 'parent', origin: { kind: job.type === 'task' ? 'queue' : 'parent' } });
  }

  function jobEnded(agent, job, status, summary) {
    const at = sessionFor(agent);
    if (!at || at.s.turn !== job.id) return;
    const map = { done: 'completed', failed: 'error', waiting: 'blocked', cancelled: 'cancelled', retrying: 'error' };
    emit(at.code, 'turn.end', at.s.session, { turn_id: job.id, status: map[status] ?? 'completed', summary: summary ? String(summary).slice(0, 200) : undefined });
    at.s.turn = null;
    if (status === 'waiting') activity(agent, '✋', 'Waiting for approval');
    else if (status === 'failed') activity(agent, '⚠️', 'Hit a problem');
    else activity(agent, '💤', 'Idle');
  }

  function toolStart(agent, job, name, args) {
    const at = sessionFor(agent);
    if (!at) return;
    const { TOOLS } = require('./catalog.cjs');
    const target = args?.path ?? args?.agent ?? args?.to ?? args?.url ?? undefined;
    emit(at.code, 'tool.start', at.s.session, { tool_call_id: `${job.id}:${name}:${at.s.seq}`, tool_name: name, tool_class: TOOLS[name]?.class ?? 'other', target: target ? String(target).slice(0, 80) : undefined });
    at.s.lastTool = `${job.id}:${name}:${at.s.seq - 1}`;
    const [emoji, verb] = ACTIVITY[name] ?? ['🛠️', name];
    const what = name === 'delegate_task' ? args?.title : name === 'run_command' ? args?.command ?? args?.summary : name === 'fetch_url' ? args?.summary ?? args?.url : target;
    activity(agent, emoji, verb, what);
  }

  function toolEnd(agent, job, name, status) {
    const at = sessionFor(agent);
    if (!at || !at.s.lastTool) return;
    emit(at.code, 'tool.end', at.s.session, { tool_call_id: at.s.lastTool, tool_name: name, status });
    at.s.lastTool = null;
    // Back to the model between tool calls.
    if (name !== 'complete_task' && name !== 'submit_plan') activity(agent, '🤔', 'Thinking');
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
    activity(agent, '✋', 'Waiting for approval', detail?.title ?? detail?.summary ?? null);
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

  /** The room has been deleted: nothing more goes to its floor, and the floor itself goes. */
  function forget(code) {
    live.delete(code);
    crew.store?.remove(code);
  }

  return { ensure, forget, furnish, agentPresence, agentIdentity, agentLeft, humanPresence, jobQueued, jobStarted, jobEnded, toolStart, toolEnd, artifact, taskDone, waitingOnHuman, humanDecided, speech, meeting, stop };
}

module.exports = { createOfficeBridge };
