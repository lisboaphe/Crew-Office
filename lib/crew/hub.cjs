// The room's realtime channel: Server-Sent Events out, HTTP requests in.
//
// SSE is what the office already uses for its agent stream, it passes through every proxy
// a WebSocket does, and the browser reconnects it by itself. Every event carries a
// per-room sequence number; a client that reconnects with Last-Event-ID is replayed what it
// missed from a short buffer, and one that has been away longer refetches the snapshot.
//
// The hub also owns presence: who has a window open on which room right now.

'use strict';

const REPLAY_MAX = 500;
const PING_MS = 15_000;
const OFFLINE_GRACE_MS = 20_000;

function createHub({ onPresence = () => {}, graceMs = OFFLINE_GRACE_MS } = {}) {
  /** roomId -> { seq, buffer: [{seq, event, data, toUser}], subs: Set } */
  const rooms = new Map();
  /** `${roomId}:${userId}` -> { count, offlineTimer } */
  const presence = new Map();

  function room(roomId) {
    let r = rooms.get(roomId);
    if (!r) { r = { seq: 0, buffer: [], subs: new Set() }; rooms.set(roomId, r); }
    return r;
  }

  const frame = (entry) => `id: ${entry.seq}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;

  /** Send to everyone in a room, or (toUser) to one player's windows only. */
  function broadcast(roomId, event, data, { toUser = null } = {}) {
    const r = room(roomId);
    const entry = { seq: ++r.seq, event, data, toUser };
    r.buffer.push(entry);
    if (r.buffer.length > REPLAY_MAX) r.buffer.shift();
    const text = frame(entry);
    for (const sub of r.subs) {
      if (toUser && sub.userId !== toUser) continue;
      try { sub.res.write(text); } catch { /* closed: cleaned up on 'close' */ }
    }
    return entry.seq;
  }

  function subscribe(roomId, userId, req, res) {
    const r = room(roomId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const last = Number(req.headers['last-event-id'] ?? NaN);
    if (Number.isFinite(last) && r.buffer.length && last >= r.buffer[0].seq - 1) {
      for (const entry of r.buffer) {
        if (entry.seq > last && (!entry.toUser || entry.toUser === userId)) res.write(frame(entry));
      }
    } else {
      // Too far behind (or first connect): tell the client to refetch the snapshot.
      res.write(`event: resync\ndata: ${JSON.stringify({ seq: r.seq })}\n\n`);
    }
    const sub = { userId, res, ping: setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, PING_MS) };
    r.subs.add(sub);
    arrive(roomId, userId);
    req.on('close', () => {
      clearInterval(sub.ping);
      r.subs.delete(sub);
      leave(roomId, userId);
    });
  }

  function arrive(roomId, userId) {
    const key = `${roomId}:${userId}`;
    const p = presence.get(key) ?? { count: 0, offlineTimer: null };
    if (p.offlineTimer) { clearTimeout(p.offlineTimer); p.offlineTimer = null; }
    const wasOnline = p.count > 0 || p.lingering;
    p.count++;
    p.lingering = false;
    presence.set(key, p);
    if (!wasOnline) onPresence(roomId, userId, true);
  }

  function leave(roomId, userId) {
    const key = `${roomId}:${userId}`;
    const p = presence.get(key);
    if (!p) return;
    p.count = Math.max(0, p.count - 1);
    if (p.count === 0) {
      // A reload is a disconnect followed by a connect; do not walk the avatar out for it.
      p.lingering = true;
      p.offlineTimer = setTimeout(() => {
        presence.delete(key);
        onPresence(roomId, userId, false);
      }, graceMs);
    }
  }

  function online(roomId) {
    const out = [];
    for (const [key, p] of presence) {
      const [rid, uid] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (rid === roomId && (p.count > 0 || p.lingering)) out.push(uid);
    }
    return out;
  }

  function disconnectUser(roomId, userId) {
    const r = rooms.get(roomId);
    if (!r) return;
    for (const sub of r.subs) if (sub.userId === userId) { try { sub.res.end(); } catch {} }
  }

  function closeAll() {
    for (const r of rooms.values()) for (const sub of r.subs) { clearInterval(sub.ping); try { sub.res.end(); } catch {} }
    for (const p of presence.values()) if (p.offlineTimer) clearTimeout(p.offlineTimer);
  }

  const seq = (roomId) => room(roomId).seq;

  return { broadcast, subscribe, online, disconnectUser, closeAll, seq };
}

module.exports = { createHub };
