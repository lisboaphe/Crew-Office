// Workers: the processes that actually run a player's agents, on that player's machine.
//
// The room host never holds an API key. A player connects a worker (bin/crew-worker.cjs)
// with a token minted here; the worker keeps the player's provider credentials locally,
// claims jobs for that player's agents only, calls the model itself, and reports back
// through the host's authenticated worker API. Shared-state tools run on the host after a
// permission check; local tools (sandboxed code, web fetches) run on the worker after the
// host has authorised them.
//
// A worker on someone's laptop is "attended": its agents are only available while their
// owner also has the office open. A worker registered as always-on (a home server, a VPS)
// keeps its owner's agents available when the owner walks away.

'use strict';

const crypto = require('crypto');
const { newId, now, sha256 } = require('./db.cjs');
const { httpError, cleanName } = require('./auth.cjs');

const STALE_MS = 35_000;

function createWorkers(crew) {
  const { db } = crew;
  /** workerId -> last contact, kept in memory so a heartbeat is not a disk write. */
  const lastSeen = new Map();
  /** workerId -> Set of open SSE responses */
  const streams = new Map();

  function mint(roomId, userId, { name = 'My worker', alwaysOn = false } = {}) {
    crew.rooms.require(roomId, userId, 'agents.create');
    const token = `wk_${crypto.randomBytes(24).toString('base64url')}`;
    const id = newId('wkr');
    db.run('INSERT INTO workers (id, room_id, user_id, token_hash, name, always_on, created_at) VALUES (?,?,?,?,?,?,?)',
      id, roomId, userId, sha256(token), cleanName(name) || 'Worker', alwaysOn ? 1 : 0, now());
    crew.audit(roomId, userId, 'worker.mint', { workerId: id, alwaysOn });
    return { id, token, name, alwaysOn };
  }

  function authenticate(req) {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith('wk_')) throw httpError(401, 'Missing worker token.');
    const w = db.get('SELECT * FROM workers WHERE token_hash = ? AND revoked = 0', sha256(token));
    if (!w) throw httpError(401, 'Unknown or revoked worker token.');
    if (!crew.rooms.roleOf(w.room_id, w.user_id)) throw httpError(403, 'This worker’s owner is no longer in the office.');
    touch(w);
    return w;
  }

  function touch(w) {
    const was = isOnline(w.id);
    lastSeen.set(w.id, now());
    if (!was) {
      db.run('UPDATE workers SET last_seen = ? WHERE id = ?', now(), w.id);
      changed(w);
    }
  }

  const isOnline = (workerId) => now() - (lastSeen.get(workerId) ?? 0) < STALE_MS;

  /**
   * Whether any of this player's workers can run their agents right now. An attended
   * worker counts only while its owner has the office open; an always-on one regardless.
   */
  function userOnline(roomId, userId) {
    const ownerHere = crew.hub.online(roomId).includes(userId);
    return db.all('SELECT id, always_on FROM workers WHERE room_id = ? AND user_id = ? AND revoked = 0', roomId, userId)
      .some((w) => isOnline(w.id) && (w.always_on || ownerHere));
  }

  function changed(w) {
    for (const a of crew.agents.ofOwner(w.room_id, w.user_id)) crew.agents.refreshPresence(a.id);
    crew.hub.broadcast(w.room_id, 'workers', { userId: w.user_id, online: userOnline(w.room_id, w.user_id) });
    crew.work.kick();
  }

  /** Called on the host's sweep: notices workers that went quiet. */
  function sweep() {
    for (const [id, at] of lastSeen) {
      if (now() - at >= STALE_MS) {
        lastSeen.delete(id);
        const w = db.get('SELECT * FROM workers WHERE id = ?', id);
        if (w) {
          crew.jobs.releaseWorker(id);
          changed(w);
        }
      }
    }
  }

  function stream(w, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ workerId: w.id, roomId: w.room_id })}\n\n`);
    let set = streams.get(w.id);
    if (!set) { set = new Set(); streams.set(w.id, set); }
    set.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); touch(w); } catch {} }, 10_000);
    req.on('close', () => { clearInterval(ping); set.delete(res); });
  }

  /** Nudge every connected worker of a player: there may be a job for them. */
  function notify(roomId, userId, event = 'jobs', data = {}) {
    for (const w of db.all('SELECT id FROM workers WHERE room_id = ? AND user_id = ? AND revoked = 0', roomId, userId)) {
      for (const res of streams.get(w.id) ?? []) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
    }
  }

  // What each player's worker says about its providers. Only the state and a short reason
  // reach the host; never credentials, balances or usage figures.
  const providerStates = new Map();
  function reportProviders(w, providers) {
    const clean = {};
    for (const [k, v] of Object.entries(providers ?? {})) clean[String(k).slice(0, 40)] = { state: String(v?.state ?? '').slice(0, 40), reason: String(v?.reason ?? '').slice(0, 300) };
    providerStates.set(`${w.room_id}:${w.user_id}`, clean);
    crew.hub.broadcast(w.room_id, 'providers', { userId: w.user_id, providers: clean });
  }
  const providersOf = (roomId, userId) => providerStates.get(`${roomId}:${userId}`) ?? {};

  function list(roomId, userId) {
    return db.all('SELECT * FROM workers WHERE room_id = ? AND user_id = ? AND revoked = 0 ORDER BY created_at', roomId, userId)
      .map((w) => ({ id: w.id, name: w.name, alwaysOn: Boolean(w.always_on), online: isOnline(w.id), lastSeen: lastSeen.get(w.id) ?? w.last_seen }));
  }

  function revoke(roomId, userId, workerId) {
    const w = db.get('SELECT * FROM workers WHERE id = ? AND room_id = ? AND user_id = ?', workerId, roomId, userId);
    if (!w) throw httpError(404, 'No such worker.');
    db.run('UPDATE workers SET revoked = 1 WHERE id = ?', workerId);
    lastSeen.delete(workerId);
    for (const res of streams.get(workerId) ?? []) { try { res.end(); } catch {} }
    crew.jobs.releaseWorker(workerId);
    changed(w);
  }

  /** The office is being deleted: hang up on every worker in it. */
  function dropRoom(roomId) {
    for (const w of db.all('SELECT id FROM workers WHERE room_id = ?', roomId)) {
      lastSeen.delete(w.id);
      for (const res of streams.get(w.id) ?? []) { try { res.end(); } catch {} }
    }
  }

  function closeAll() {
    for (const set of streams.values()) for (const res of set) { try { res.end(); } catch {} }
  }

  return { mint, authenticate, userOnline, isOnline, sweep, stream, notify, list, revoke, dropRoom, closeAll, reportProviders, providersOf };
}

module.exports = { createWorkers };
