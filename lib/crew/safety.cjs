// The record of what happened, and the stop button. Both are enforced here on the host, so neither
// depends on a page, an agent, or a setting that can be switched off.
//
// The audit log is append-only from this code, and each row's hash covers the one before it, so
// an edit or a deletion in the middle of it can be detected with verify(). That detects tampering
// after the fact by something without this code's cooperation. It does not stop someone with
// write access to the database rewriting the whole chain, and docs/security says so.

'use strict';

const crypto = require('crypto');
const { now, json, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');

const RETAIN_MS = 180 * 24 * 3600_000;
const DENIED_PER_MINUTE = 60;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSafety(crew) {
  const { db } = crew;
  const cols = db.raw.prepare('PRAGMA table_info(audit)').all().map((c) => c.name);
  for (const [name, type] of [['outcome', "TEXT NOT NULL DEFAULT 'ok'"], ['resource', 'TEXT'], ['agent_id', 'TEXT'], ['project_id', 'TEXT'], ['request_id', 'TEXT'], ['prev_hash', 'TEXT'], ['hash', 'TEXT']]) {
    if (!cols.includes(name)) db.raw.exec(`ALTER TABLE audit ADD COLUMN ${name} ${type}`);
  }
  db.raw.exec(`
    CREATE INDEX IF NOT EXISTS audit_room ON audit(room_id, ts);
    CREATE TABLE IF NOT EXISTS room_stops (room_id TEXT PRIMARY KEY, stopped_by TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS room_bans (room_id TEXT NOT NULL, user_id TEXT NOT NULL, by_user TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id));
  `);

  let lastHash = db.get('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1')?.hash ?? 'genesis';

  /** Never throws: a failure to record must not become a way to make an action fail. */
  function audit(roomId, actor, action, detail = {}, { outcome = 'ok', resource = null, agentId = null, projectId = null, requestId = null } = {}) {
    try {
      const ts = now();
      const body = json(detail ?? {});
      const hash = sha([lastHash, roomId ?? '', actor ?? '', action, body, outcome, resource ?? '', agentId ?? '', projectId ?? '', ts].join('|'));
      db.run('INSERT INTO audit (room_id, actor, action, detail, ts, outcome, resource, agent_id, project_id, request_id, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        roomId, actor ?? 'system', action, body, ts, outcome, resource, agentId, projectId, requestId ?? crypto.randomBytes(6).toString('hex'), lastHash, hash);
      lastHash = hash;
    } catch (err) { crew.crash?.record('audit', err); }
  }

  /** Walk the chain. Rows from before the chain existed have no hash and are skipped. */
  function verify() {
    let prev = null;
    let checked = 0;
    for (const r of db.all('SELECT * FROM audit WHERE hash IS NOT NULL ORDER BY id')) {
      if (prev !== null && r.prev_hash !== prev) return { ok: false, checked, brokenAt: r.id, why: 'A row is missing or out of order.' };
      const want = sha([r.prev_hash, r.room_id ?? '', r.actor ?? '', r.action, r.detail, r.outcome, r.resource ?? '', r.agent_id ?? '', r.project_id ?? '', r.ts].join('|'));
      if (want !== r.hash) return { ok: false, checked, brokenAt: r.id, why: 'A row was changed after it was written.' };
      prev = r.hash;
      checked++;
    }
    return { ok: true, checked };
  }

  function prune() {
    // Keeps the most recent chain intact. verify() starts from whichever row is now oldest.
    db.run('DELETE FROM audit WHERE ts < ?', now() - RETAIN_MS);
  }

  const seenDenied = new Map();
  /** A refused request, recorded without letting someone flood the log by being refused. */
  function denied(key, roomId, actor, action, why) {
    const minute = Math.floor(now() / 60_000);
    const k = `${key}:${minute}`;
    const n = (seenDenied.get(k) ?? 0) + 1;
    seenDenied.set(k, n);
    if (seenDenied.size > 2000) seenDenied.clear();
    if (n <= DENIED_PER_MINUTE) audit(roomId, actor, action, { why: String(why).slice(0, 200) }, { outcome: 'denied' });
  }

  function search(roomId, { q = '', outcome = null, limit = 200, actor = null } = {}) {
    const rows = db.all(`SELECT * FROM audit WHERE room_id = ?${outcome ? ' AND outcome = ?' : ''}${actor ? ' AND actor = ?' : ''} ORDER BY id DESC LIMIT 2000`, roomId, ...(outcome ? [outcome] : []), ...(actor ? [actor] : []));
    const needle = String(q).toLowerCase();
    const match = needle ? rows.filter((r) => `${r.action} ${r.detail} ${r.resource ?? ''} ${r.actor}`.toLowerCase().includes(needle)) : rows;
    return match.slice(0, Math.min(500, limit)).map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, actorName: crew.auth.getUser(r.actor)?.displayName ?? r.actor, action: r.action, outcome: r.outcome, resource: r.resource, agentId: r.agent_id, projectId: r.project_id, requestId: r.request_id, detail: parse(r.detail, {}) }));
  }

  // --- emergency stop ------------------------------------------------------------------------

  const stopState = (roomId) => db.get('SELECT * FROM room_stops WHERE room_id = ?', roomId) ?? null;
  const isStopped = (roomId) => Boolean(stopState(roomId));

  function requireStoppable(roomId, userId) {
    const role = crew.rooms.roleOf(roomId, userId);
    if (!['owner', 'admin'].includes(role)) throw httpError(403, 'Only the office owner or an admin can stop the whole office. You can stop your own agents with Pause all.');
  }

  /** Everything the host can do at once. Workers also act alone: see lib/crew-worker. */
  function stopAll(roomId, userId, reason = 'Emergency stop') {
    requireStoppable(roomId, userId);
    db.run('INSERT OR REPLACE INTO room_stops (room_id, stopped_by, reason, at) VALUES (?,?,?,?)', roomId, userId, String(reason).slice(0, 200), now());
    let jobs = 0;
    for (const j of db.all("SELECT id FROM jobs WHERE room_id = ? AND status IN ('queued','leased','waiting')", roomId)) { crew.jobs.cancel(j.id, 'Emergency stop'); jobs++; }
    let tasks = 0;
    for (const t of db.all("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.room_id = ? AND t.status IN ('pending','queued','in_progress','waiting','awaiting_approval')", roomId)) {
      crew.work.setTask(t.id, { status: 'blocked', result_summary: 'Stopped by the emergency stop. Retry it after the office resumes.' });
      tasks++;
    }
    crew.workers.stopRoom(roomId);
    audit(roomId, userId, 'emergency.stop', { reason, jobs, tasks });
    crew.hub.broadcast(roomId, 'safety', { stopped: true, by: userId, reason });
    return { stopped: true, jobs, tasks };
  }

  function resume(roomId, userId) {
    requireStoppable(roomId, userId);
    db.run('DELETE FROM room_stops WHERE room_id = ?', roomId);
    audit(roomId, userId, 'emergency.resume', {});
    crew.hub.broadcast(roomId, 'safety', { stopped: false, by: userId });
    crew.work.kick();
    return { stopped: false };
  }

  /** Every door an agent or a run comes through asks this. */
  function refuseIfStopped(roomId) {
    if (isStopped(roomId)) throw httpError(423, 'This office is under an emergency stop. A person has to resume it.');
  }

  /** Stop one project's work. Its owner or an office admin may. */
  function stopProject(roomId, userId, projectId) {
    const p = crew.work.projectFor(roomId, projectId);
    if (p.created_by !== userId && !['owner', 'admin'].includes(crew.rooms.roleOf(roomId, userId))) throw httpError(403, 'Only the project’s creator or an office admin can stop it.');
    let n = 0;
    for (const t of db.all("SELECT id FROM tasks WHERE project_id = ? AND status IN ('pending','queued','in_progress','waiting','awaiting_approval')", projectId)) {
      crew.work.cancelTask(roomId, p.created_by, t.id);
      n++;
    }
    audit(roomId, userId, 'project.stop', { tasks: n }, { projectId, resource: p.name });
    return { tasks: n };
  }

  // --- bans ----------------------------------------------------------------------------------

  const ban = (roomId, userId, by) => db.run('INSERT OR REPLACE INTO room_bans (room_id, user_id, by_user, at) VALUES (?,?,?,?)', roomId, userId, by, now());
  const isBanned = (roomId, userId) => Boolean(db.get('SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?', roomId, userId));

  return { audit, verify, prune, denied, search, isStopped, stopState, stopAll, resume, refuseIfStopped, stopProject, ban, isBanned };
}

module.exports = { createSafety };
