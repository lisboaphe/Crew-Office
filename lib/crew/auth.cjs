// Player identities on this host: names, browser sessions, and the older password accounts.
//
// A player is a name and a colour, and belongs to the host the way a game server's player
// list does. What makes you *you* is the session, a random token held in an HttpOnly cookie
// and stored here only as a SHA-256 digest, so a copy of the database is not a copy of
// anyone's identity.
//
// A name is a label, never a claim: typing someone's name from another computer makes a new
// player who happens to share it, and cannot reach their agents or plan. Register and login
// remain for scripted demos and tests; the app no longer offers them.
//
// The computer hosting the office remembers its player, so its owner never has to pick again.
// That cannot rest on "the request came from this computer", because the owner's own agents
// run here too, and one that could reach the API as its owner could approve its own work. So
// it rests on machine.key, a file in the data folder that the app's launcher reads and hands
// to its window. A sandboxed agent cannot read that folder.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { newId, now, sha256 } = require('./db.cjs');

const SESSION_TTL_MS = 30 * 24 * 3600_000;
// There is no password to get back in with, so a name session has to last.
const ENTRY_TTL_MS = 365 * 24 * 3600_000;
const COOKIE = 'crew_session';
const PALETTE = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f', '#9b5de5', '#f15bb5', '#00bbf9', '#e76f51', '#2a9d8f', '#8d99ae'];

function hashPassword(plaintext, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(plaintext), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

function verifyPassword(plaintext, hash, salt) {
  if (!hash || !salt) return false;
  const got = Buffer.from(hashPassword(plaintext, salt).hash, 'hex');
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const USERNAME = /^[a-zA-Z0-9_.-]{2,32}$/;

function createAuth(db, { dataDir = null } = {}) {
  db.raw.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  function machineKey() {
    if (!dataDir) return null;
    const file = path.join(dataDir, 'machine.key');
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
    const key = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
  const key = machineKey();

  function isMachineKey(candidate) {
    const got = Buffer.from(String(candidate ?? ''));
    const want = Buffer.from(key ?? '');
    return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  const machinePlayer = () => {
    const id = db.get("SELECT value FROM settings WHERE key = 'machine_player'")?.value;
    return id ? getUser(id) : null;
  };
  const setMachinePlayer = (id) => db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('machine_player', ?)", id);
  const sessionFor = (id) => startSession(id, ENTRY_TTL_MS);

  /** Everyone on this host, for the owner of the computer to choose between. */
  const players = () => db.all(`SELECT u.id, u.display_name, u.color,
      (SELECT COUNT(*) FROM rooms r WHERE r.owner_id = u.id) offices,
      (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id AND a.removed = 0) agents
    FROM users u ORDER BY u.created_at`).map((u) => ({ id: u.id, displayName: u.display_name, color: u.color, offices: u.offices, agents: u.agents }));

  function publicUser(u) {
    return u ? { id: u.id, username: u.username, displayName: u.display_name, color: u.color } : null;
  }

  function register({ username, password, displayName, color }) {
    if (!USERNAME.test(String(username ?? ''))) throw httpError(400, 'Username must be 2–32 letters, digits, dot, dash or underscore.');
    if (String(password ?? '').length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if (db.get('SELECT id FROM users WHERE username = ?', username)) throw httpError(409, 'That username is taken on this host.');
    const { hash, salt } = hashPassword(password);
    const id = newId('usr');
    const count = db.get('SELECT COUNT(*) n FROM users').n;
    db.run('INSERT INTO users (id, username, display_name, password_hash, password_salt, color, created_at) VALUES (?,?,?,?,?,?,?)',
      id, username, cleanName(displayName) || username, hash, salt, validColor(color) ?? PALETTE[count % PALETTE.length], now());
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
  }

  function login({ username, password }) {
    const u = db.get('SELECT * FROM users WHERE username = ?', String(username ?? ''));
    if (!u || !verifyPassword(password, u.password_hash, u.password_salt)) throw httpError(401, 'Wrong username or password.');
    return { user: publicUser(u), token: startSession(u.id) };
  }

  /** A name and a colour are enough to be somebody here. See the header on what a name is not. */
  function enter({ name, color }, { local = false } = {}) {
    const displayName = cleanName(name);
    if (!displayName) throw httpError(400, 'Type a name first.');
    if (local) {
      // More than one can share a name; the host means the one who owns the offices.
      const mine = db.get('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE ORDER BY (SELECT COUNT(*) FROM rooms WHERE rooms.owner_id = users.id) DESC, created_at ASC LIMIT 1', displayName);
      if (mine) { setMachinePlayer(mine.id); return { user: updateProfile(mine.id, { color }), token: sessionFor(mine.id) }; }
    }
    const id = newId('usr');
    const count = db.get('SELECT COUNT(*) n FROM users').n;
    // Empty password fields: verifyPassword refuses them, so nobody can log in as this player.
    db.run('INSERT INTO users (id, username, display_name, password_hash, password_salt, color, created_at) VALUES (?,?,?,?,?,?,?)',
      id, `player-${crypto.randomBytes(8).toString('hex')}`, displayName, '', '', validColor(color) ?? PALETTE[count % PALETTE.length], now());
    if (local) setMachinePlayer(id);
    return { user: getUser(id), token: sessionFor(id) };
  }

  function startSession(userId, ttl = SESSION_TTL_MS) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), userId, now(), now() + ttl);
    return token;
  }

  function userForToken(token) {
    if (!token) return null;
    const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.expires_at < now()) return null;
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', s.user_id));
  }

  function logout(token) {
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  function updateProfile(userId, { displayName, color }) {
    if (displayName !== undefined) db.run('UPDATE users SET display_name = ? WHERE id = ?', cleanName(displayName) || 'Player', userId);
    if (color !== undefined && validColor(color)) db.run('UPDATE users SET color = ? WHERE id = ?', validColor(color), userId);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', userId));
  }

  const getUser = (id) => publicUser(db.get('SELECT * FROM users WHERE id = ?', id));

  return { enter, register, login, logout, userForToken, updateProfile, getUser, publicUser, COOKIE, ENTRY_TTL_MS, isMachineKey, machinePlayer, setMachinePlayer, sessionFor, players };
}

function cleanName(s, max = 40) {
  return String(s ?? '').replace(/[\p{Cc}<>]/gu, '').trim().slice(0, max);
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

module.exports = { createAuth, hashPassword, verifyPassword, httpError, cleanName, validColor, PALETTE };
