// Player identities on this host: accounts, password hashing and browser sessions.
//
// Accounts belong to the host, the way a game server's player list does — Bob makes an
// account on Alice's room server the first time he joins it. Passwords are scrypt with a
// per-user salt; sessions are random tokens held in an HttpOnly cookie and stored here
// only as a SHA-256 digest, so a copy of the database is not a copy of anyone's login.

'use strict';

const crypto = require('crypto');
const { newId, now, sha256 } = require('./db.cjs');

const SESSION_TTL_MS = 30 * 24 * 3600_000;
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

function createAuth(db) {
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

  function startSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), userId, now(), now() + SESSION_TTL_MS);
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

  return { register, login, logout, userForToken, updateProfile, getUser, publicUser, COOKIE };
}

function cleanName(s) {
  return String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
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
