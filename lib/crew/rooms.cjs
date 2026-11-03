// Rooms: the hosted multiplayer offices, their members, roles and invitations.
//
// A room is what a player hosts. Its code is an office keycard, so the 3D office for the
// room lives at /office/<code> and reuses everything the office already does. The
// room's own settings — name, password, player cap, privacy — and who may do what in it
// are kept here, and every check that follows from a role goes through `can()`.

'use strict';

const crypto = require('crypto');
const { newId, now } = require('./db.cjs');
const { hashPassword, verifyPassword, httpError, cleanName } = require('./auth.cjs');

const ROLES = ['guest', 'member', 'admin', 'owner'];
const PRIVACY = ['invite', 'password', 'lan'];
const rank = (role) => ROLES.indexOf(role);

/**
 * What each role may do in a room. Agents are not in this table on purpose: an agent is
 * controlled by its owner and nobody else, whatever their room role — see agents.cjs.
 */
const ABILITIES = {
  view: 'guest',
  chat: 'guest',
  'agents.create': 'member',
  'projects.create': 'member',
  'projects.join': 'member',
  'invites.create': 'admin',
  'members.manage': 'admin',
  'room.settings': 'admin',
  'room.stop': 'owner',
};

function createRooms(crew) {
  const { db } = crew;

  function shape(room, userId = null) {
    if (!room) return null;
    const members = db.all('SELECT user_id, role FROM room_members WHERE room_id = ?', room.id);
    const me = userId ? members.find((m) => m.user_id === userId) : null;
    return {
      id: room.id, code: room.code, name: room.name, ownerId: room.owner_id, privacy: room.privacy,
      hasPassword: Boolean(room.password_hash), maxPlayers: room.max_players, status: room.status,
      players: members.length, createdAt: room.created_at, myRole: me?.role ?? null,
    };
  }

  function mintCode() {
    return crew.mintKeycard((c) => Boolean(db.get('SELECT 1 FROM rooms WHERE code = ?', c)));
  }

  function create(ownerId, { name, password, maxPlayers = 8, privacy = 'invite' }) {
    const roomName = cleanName(name);
    if (!roomName) throw httpError(400, 'Give the office a name.');
    if (!PRIVACY.includes(privacy)) throw httpError(400, `Privacy must be one of ${PRIVACY.join(', ')}.`);
    const cap = Math.round(Number(maxPlayers));
    if (!(cap >= 1 && cap <= 32)) throw httpError(400, 'Max players must be between 1 and 32.');
    if (privacy === 'password' && String(password ?? '').length < 4) throw httpError(400, 'A password room needs a password of at least 4 characters.');
    const pw = password ? hashPassword(password) : null;
    const id = newId('room');
    const code = mintCode();
    db.tx(() => {
      db.run('INSERT INTO rooms (id, code, name, owner_id, privacy, password_hash, password_salt, max_players, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, code, roomName, ownerId, privacy, pw?.hash ?? null, pw?.salt ?? null, cap, now());
      db.run('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)', id, ownerId, 'owner', now());
    });
    for (const ch of ['office-general', 'agent-updates', 'frontend', 'backend', 'design']) crew.bus.ensureChannel(id, ch, 'public');
    crew.audit(id, ownerId, 'room.create', { name: roomName, privacy, maxPlayers: cap });
    crew.office.ensure(code);
    return shape(get(id), ownerId);
  }

  const get = (id) => db.get('SELECT * FROM rooms WHERE id = ?', id);
  const byCode = (code) => db.get('SELECT * FROM rooms WHERE code = ?', String(code ?? '').toUpperCase());
  const roleOf = (roomId, userId) => db.get('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId)?.role ?? null;

  function can(roomId, userId, ability) {
    const role = roleOf(roomId, userId);
    if (!role) return false;
    const needed = ABILITIES[ability];
    if (!needed) throw new Error(`unknown ability ${ability}`);
    return rank(role) >= rank(needed);
  }

  function require_(roomId, userId, ability) {
    const room = get(roomId);
    if (!room) throw httpError(404, 'No such office on this host.');
    if (!roleOf(roomId, userId)) throw httpError(403, 'You are not a member of this office.');
    if (!can(roomId, userId, ability)) throw httpError(403, `Your role in this office cannot do that (${ability}).`);
    if (room.status !== 'open' && ability !== 'room.stop' && ability !== 'view') throw httpError(409, 'This office is stopped. The host has to start it again.');
    return room;
  }

  /**
   * Join by room code (+ password) or by invitation. An invitation beats privacy: it is
   * the host's explicit say-so. Without one, an invite-only room refuses, a password room
   * wants its password, and a LAN room admits anyone who can reach this host.
   */
  function join(userId, { code, password, invite }) {
    let room = null;
    let role = 'member';
    let inv = null;
    if (invite) {
      inv = db.get('SELECT * FROM invites WHERE code = ?', String(invite));
      if (!inv || inv.expires_at < now() || inv.uses_left <= 0) throw httpError(403, 'That invitation has expired or been used up.');
      room = get(inv.room_id);
      role = inv.role;
    } else {
      room = byCode(code);
      if (!room) throw httpError(404, 'No office with that code on this host.');
    }
    if (room.status !== 'open') throw httpError(409, 'This office is stopped right now.');
    const existing = roleOf(room.id, userId);
    if (existing) return shape(room, userId);
    if (!inv) {
      if (room.privacy === 'invite') throw httpError(403, 'This office is invite-only. Ask the host for an invitation link.');
      if (room.privacy === 'password' && !verifyPassword(password ?? '', room.password_hash, room.password_salt)) throw httpError(401, 'Wrong office password.', { needsPassword: true });
    }
    const count = db.get('SELECT COUNT(*) n FROM room_members WHERE room_id = ?', room.id).n;
    if (count >= room.max_players) throw httpError(409, `This office is full (${room.max_players} players).`);
    db.tx(() => {
      db.run('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)', room.id, userId, role, now());
      if (inv) db.run('UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?', inv.code);
    });
    crew.audit(room.id, userId, 'room.join', { via: inv ? 'invite' : 'code', role });
    crew.hub.broadcast(room.id, 'members', { members: members(room.id) });
    const user = crew.auth.getUser(userId);
    crew.bus.system(room.id, 'office-general', `${user.displayName} joined the office.`);
    return shape(get(room.id), userId);
  }

  function createInvite(roomId, userId, { role = 'member', uses = 10, hours = 72 } = {}) {
    require_(roomId, userId, 'invites.create');
    if (!['guest', 'member', 'admin'].includes(role)) throw httpError(400, 'Invitations can grant guest, member or admin.');
    if (role === 'admin' && roleOf(roomId, userId) !== 'owner') throw httpError(403, 'Only the owner can invite admins.');
    const code = crypto.randomBytes(12).toString('base64url');
    db.run('INSERT INTO invites (code, room_id, created_by, role, uses_left, expires_at) VALUES (?,?,?,?,?,?)',
      code, roomId, userId, role, Math.max(1, Math.min(100, uses | 0)), now() + Math.max(1, Math.min(24 * 30, hours)) * 3600_000);
    return { code, role, roomCode: get(roomId).code };
  }

  function members(roomId) {
    const online = new Set(crew.hub.online(roomId));
    return db.all(`SELECT m.user_id, m.role, m.joined_at, u.display_name, u.username, u.color
                   FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.joined_at`, roomId)
      .map((m) => ({
        userId: m.user_id, role: m.role, displayName: m.display_name, username: m.username, color: m.color,
        joinedAt: m.joined_at, online: online.has(m.user_id), workerOnline: crew.workers.userOnline(roomId, m.user_id),
      }));
  }

  function setRole(roomId, actorId, targetId, role) {
    require_(roomId, actorId, 'members.manage');
    if (!ROLES.includes(role) || role === 'owner') throw httpError(400, 'Role must be guest, member or admin.');
    const target = roleOf(roomId, targetId);
    if (!target) throw httpError(404, 'Not a member.');
    if (target === 'owner') throw httpError(403, 'The owner’s role cannot be changed.');
    if (rank(roleOf(roomId, actorId)) <= rank(target) && roleOf(roomId, actorId) !== 'owner') throw httpError(403, 'You can only change roles below your own.');
    db.run('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?', role, roomId, targetId);
    crew.audit(roomId, actorId, 'member.role', { targetId, role });
    crew.hub.broadcast(roomId, 'members', { members: members(roomId) });
  }

  /** Removing a player takes their agents off the floor too: those agents are theirs. */
  function kick(roomId, actorId, targetId) {
    require_(roomId, actorId, 'members.manage');
    const target = roleOf(roomId, targetId);
    if (!target || target === 'owner') throw httpError(403, 'Cannot remove that player.');
    if (rank(roleOf(roomId, actorId)) <= rank(target) && roleOf(roomId, actorId) !== 'owner') throw httpError(403, 'You can only remove players below your own role.');
    db.run('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', roomId, targetId);
    db.run('UPDATE workers SET revoked = 1 WHERE room_id = ? AND user_id = ?', roomId, targetId);
    for (const a of db.all('SELECT id FROM agents WHERE room_id = ? AND owner_id = ? AND removed = 0', roomId, targetId)) crew.agents.refreshPresence(a.id);
    crew.hub.disconnectUser(roomId, targetId);
    crew.audit(roomId, actorId, 'member.kick', { targetId });
    crew.hub.broadcast(roomId, 'members', { members: members(roomId) });
  }

  function updateSettings(roomId, userId, { name, password, maxPlayers, privacy }) {
    require_(roomId, userId, 'room.settings');
    if (name !== undefined) db.run('UPDATE rooms SET name = ? WHERE id = ?', cleanName(name) || get(roomId).name, roomId);
    if (maxPlayers !== undefined) {
      const cap = Math.round(Number(maxPlayers));
      if (!(cap >= 1 && cap <= 32)) throw httpError(400, 'Max players must be between 1 and 32.');
      db.run('UPDATE rooms SET max_players = ? WHERE id = ?', cap, roomId);
    }
    if (privacy !== undefined) {
      if (!PRIVACY.includes(privacy)) throw httpError(400, 'Bad privacy setting.');
      db.run('UPDATE rooms SET privacy = ? WHERE id = ?', privacy, roomId);
    }
    if (password !== undefined) {
      if (password === null || password === '') db.run('UPDATE rooms SET password_hash = NULL, password_salt = NULL WHERE id = ?', roomId);
      else { const pw = hashPassword(password); db.run('UPDATE rooms SET password_hash = ?, password_salt = ? WHERE id = ?', pw.hash, pw.salt, roomId); }
    }
    const room = get(roomId);
    if (room.privacy === 'password' && !room.password_hash) throw httpError(400, 'Set a password before switching to password privacy.');
    crew.audit(roomId, userId, 'room.settings', { name, maxPlayers, privacy, passwordChanged: password !== undefined });
    crew.hub.broadcast(roomId, 'room', shape(room));
    return shape(room, userId);
  }

  /** Stopping a room keeps everything; it just stops admitting work until started again. */
  function setStatus(roomId, userId, status) {
    require_(roomId, userId, 'room.stop');
    if (!['open', 'stopped'].includes(status)) throw httpError(400, 'Status is open or stopped.');
    db.run('UPDATE rooms SET status = ? WHERE id = ?', status, roomId);
    crew.audit(roomId, userId, `room.${status === 'open' ? 'start' : 'stop'}`, {});
    for (const a of db.all('SELECT id FROM agents WHERE room_id = ? AND removed = 0', roomId)) crew.agents.refreshPresence(a.id);
    crew.hub.broadcast(roomId, 'room', shape(get(roomId)));
    return shape(get(roomId), userId);
  }

  const listFor = (userId) => db.all(`SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ? ORDER BY r.created_at DESC`, userId)
    .map((r) => shape(r, userId));
  const listLan = () => db.all("SELECT * FROM rooms WHERE privacy IN ('lan','password') AND status = 'open'").map((r) => shape(r));

  return { create, get, byCode, roleOf, can, require: require_, join, createInvite, members, setRole, kick, updateSettings, setStatus, listFor, listLan, shape, ROLES };
}

module.exports = { createRooms, ROLES, PRIVACY };
