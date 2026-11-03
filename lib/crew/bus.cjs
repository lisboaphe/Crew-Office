// The message bus: channels, direct messages, and agent-to-agent traffic with correlation.
//
// Every message is a persisted, structured record — sender type and id, an optional
// addressee agent, a kind (chat, question, answer, delegation, handoff, progress,
// review_request, artifact, approval, system), the task and job it belongs to, and a
// delivery status. Agent messages exist because an agent called a tool; nothing here
// writes dialogue on anyone's behalf.
//
// Guards against runaway conversations live here too: a per-agent send rate, a cap on
// how many messages two agents may exchange within one task, and refusal of an agent
// repeating itself verbatim.

'use strict';

const { newId, now } = require('./db.cjs');
const { httpError } = require('./auth.cjs');

const KINDS = ['chat', 'question', 'answer', 'delegation', 'handoff', 'progress', 'review_request', 'artifact', 'approval', 'system'];
const MAX_BODY = 8000;
const RATE_PER_MIN = 20;
const PAIR_LIMIT_PER_TASK = 10;

function createBus(crew) {
  const { db } = crew;
  const sendTimes = new Map();      // agentId -> [timestamps]
  const waiters = new Map();        // correlationId -> { resolve, timer }

  function ensureChannel(roomId, name, kind, extra = {}) {
    const clean = String(name).toLowerCase().replace(/[^a-z0-9-:_]/g, '-').slice(0, 60);
    const found = db.get('SELECT * FROM channels WHERE room_id = ? AND name = ?', roomId, clean);
    if (found) return found;
    const id = newId('ch');
    db.run('INSERT INTO channels (id, room_id, name, kind, project_id, dm_user_id, dm_agent_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, roomId, clean, kind, extra.projectId ?? null, extra.dmUserId ?? null, extra.dmAgentId ?? null, now());
    const ch = db.get('SELECT * FROM channels WHERE id = ?', id);
    if (kind !== 'dm') crew.hub.broadcast(roomId, 'channel', shapeChannel(ch));
    return ch;
  }

  const shapeChannel = (c) => ({ id: c.id, name: c.name, kind: c.kind, projectId: c.project_id, dmUserId: c.dm_user_id, dmAgentId: c.dm_agent_id });

  /** A DM channel is visible to the human in it and nobody else. */
  function canSee(channel, userId) {
    if (channel.kind !== 'dm') return Boolean(crew.rooms.roleOf(channel.room_id, userId));
    return channel.dm_user_id === userId;
  }

  function channelsFor(roomId, userId) {
    return db.all('SELECT * FROM channels WHERE room_id = ? ORDER BY created_at', roomId).filter((c) => canSee(c, userId)).map(shapeChannel);
  }

  function dmChannel(roomId, userId, agentId) {
    return ensureChannel(roomId, `dm:${userId.slice(-6)}:${agentId.slice(-6)}`, 'dm', { dmUserId: userId, dmAgentId: agentId });
  }

  function shapeMessage(m) {
    let senderName = 'System';
    let senderColor = '#8d99ae';
    if (m.sender_type === 'human') { const u = crew.auth.getUser(m.sender_id); senderName = u?.displayName ?? '?'; senderColor = u?.color; }
    if (m.sender_type === 'agent') {
      const a = db.get('SELECT name, color, owner_id FROM agents WHERE id = ?', m.sender_id);
      senderName = a?.name ?? '?'; senderColor = a?.color;
    }
    const to = m.to_agent_id ? db.get('SELECT name FROM agents WHERE id = ?', m.to_agent_id) : null;
    return {
      id: m.id, channelId: m.channel_id, seq: m.seq, senderType: m.sender_type, senderId: m.sender_id, senderName, senderColor,
      toAgentId: m.to_agent_id, toAgentName: to?.name ?? null, kind: m.kind, body: m.body, correlationId: m.correlation_id,
      replyTo: m.reply_to, taskId: m.task_id, jobId: m.job_id, status: m.status, createdAt: m.created_at,
    };
  }

  function post({ roomId, channelId, senderType, senderId, toAgentId = null, kind = 'chat', body, correlationId = null, replyTo = null, taskId = null, jobId = null }) {
    if (!KINDS.includes(kind)) throw httpError(400, `Unknown message kind ${kind}.`);
    const text = String(body ?? '').trim().slice(0, MAX_BODY);
    if (!text) throw httpError(400, 'Empty message.');
    const ch = db.get('SELECT * FROM channels WHERE id = ? AND room_id = ?', channelId, roomId);
    if (!ch) throw httpError(404, 'No such channel.');
    const id = newId('msg');
    const seq = (db.get('SELECT MAX(seq) s FROM messages WHERE channel_id = ?', channelId)?.s ?? 0) + 1;
    db.run(`INSERT INTO messages (id, room_id, channel_id, seq, sender_type, sender_id, to_agent_id, kind, body, correlation_id, reply_to, task_id, job_id, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, roomId, channelId, seq, senderType, senderId, toAgentId, kind, text, correlationId, replyTo, taskId, jobId, toAgentId ? 'sent' : 'delivered', now());
    const msg = shapeMessage(db.get('SELECT * FROM messages WHERE id = ?', id));
    if (ch.kind === 'dm') crew.hub.broadcast(roomId, 'message', msg, { toUser: ch.dm_user_id });
    else crew.hub.broadcast(roomId, 'message', msg);
    if (senderType === 'agent' && kind !== 'system') crew.office.speech(senderId, text, toAgentId);
    return msg;
  }

  function system(roomId, channelName, text) {
    const ch = ensureChannel(roomId, channelName, 'public');
    return post({ roomId, channelId: ch.id, senderType: 'system', senderId: 'system', kind: 'system', body: text });
  }

  /** Every guard an agent-originated message passes before it is written. */
  function guardAgentSend(agent, { toAgentId, taskId, body }) {
    const times = (sendTimes.get(agent.id) ?? []).filter((t) => now() - t < 60_000);
    if (times.length >= RATE_PER_MIN) throw httpError(429, `Rate limit: an agent may send ${RATE_PER_MIN} messages a minute. Wait before sending more.`);
    if (toAgentId && taskId) {
      const pair = db.get(`SELECT COUNT(*) n FROM messages WHERE task_id = ? AND ((sender_id = ? AND to_agent_id = ?) OR (sender_id = ? AND to_agent_id = ?))`,
        taskId, agent.id, toAgentId, toAgentId, agent.id).n;
      if (pair >= PAIR_LIMIT_PER_TASK) throw httpError(429, `Conversation limit reached: ${PAIR_LIMIT_PER_TASK} messages between these two agents on this task. Proceed with what you have, or ask a human.`);
    }
    const repeats = db.get('SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND body = ? AND created_at > ?', agent.id, String(body).trim(), now() - 600_000).n;
    if (repeats >= 2) throw httpError(429, 'Loop detected: you have already sent this exact message twice. Do something different.');
    times.push(now());
    sendTimes.set(agent.id, times);
  }

  /** Unread messages addressed to an agent; reading them for a job marks them delivered. */
  function inbox(agentId, { markDelivered = false, limit = 20 } = {}) {
    const rows = db.all("SELECT * FROM messages WHERE to_agent_id = ? AND status = 'sent' ORDER BY created_at LIMIT ?", agentId, limit);
    if (markDelivered) for (const r of rows) db.run("UPDATE messages SET status = 'delivered' WHERE id = ?", r.id);
    return rows.map(shapeMessage);
  }

  /** Park a caller until the answer with this correlation id arrives, or time runs out. */
  function awaitAnswer(correlationId, timeoutMs) {
    const done = db.get("SELECT * FROM messages WHERE correlation_id = ? AND kind = 'answer'", correlationId);
    if (done) return Promise.resolve(shapeMessage(done));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(correlationId); resolve(null); }, timeoutMs);
      waiters.set(correlationId, { resolve, timer });
    });
  }

  function answered(correlationId, msg) {
    db.run("UPDATE messages SET status = 'read' WHERE correlation_id = ? AND kind = 'question'", correlationId);
    const w = waiters.get(correlationId);
    if (w) { clearTimeout(w.timer); waiters.delete(correlationId); w.resolve(msg); }
  }

  function failed(correlationId, reason) {
    db.run("UPDATE messages SET status = 'failed' WHERE correlation_id = ? AND kind = 'question'", correlationId);
    const w = waiters.get(correlationId);
    if (w) { clearTimeout(w.timer); waiters.delete(correlationId); w.resolve({ failed: true, reason }); }
  }

  function history(roomId, userId, channelId, { before = null, limit = 100, q = null } = {}) {
    const ch = db.get('SELECT * FROM channels WHERE id = ? AND room_id = ?', channelId, roomId);
    if (!ch || !canSee(ch, userId)) throw httpError(404, 'No such channel.');
    let rows;
    if (q) rows = db.all('SELECT * FROM messages WHERE channel_id = ? AND body LIKE ? ORDER BY seq DESC LIMIT ?', channelId, `%${q}%`, limit);
    else if (before) rows = db.all('SELECT * FROM messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', channelId, before, limit);
    else rows = db.all('SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?', channelId, limit);
    return rows.reverse().map(shapeMessage);
  }

  /** Search across every channel this player can see. */
  function search(roomId, userId, q) {
    const visible = new Set(channelsFor(roomId, userId).map((c) => c.id));
    return db.all('SELECT * FROM messages WHERE room_id = ? AND body LIKE ? ORDER BY created_at DESC LIMIT 100', roomId, `%${q}%`)
      .filter((m) => visible.has(m.channel_id)).map(shapeMessage);
  }

  function feed(roomId, userId, limit = 80) {
    const visible = new Set(channelsFor(roomId, userId).map((c) => c.id));
    return db.all("SELECT * FROM messages WHERE room_id = ? AND sender_type = 'agent' ORDER BY created_at DESC LIMIT ?", roomId, limit * 2)
      .filter((m) => visible.has(m.channel_id)).slice(0, limit).reverse().map(shapeMessage);
  }

  function forAgent(agentId, limit = 50) {
    return db.all('SELECT * FROM messages WHERE (sender_id = ? OR to_agent_id = ?) ORDER BY created_at DESC LIMIT ?', agentId, agentId, limit).reverse().map(shapeMessage);
  }

  return { ensureChannel, channelsFor, dmChannel, post, system, guardAgentSend, inbox, awaitAnswer, answered, failed, history, search, feed, forAgent, canSee, shapeMessage, KINDS };
}

module.exports = { createBus };
