// An in-process crew host for unit tests: a temporary data directory, no HTTP server, no
// 3D office, and helpers to stand players in the room and connect workers by hand.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

process.env.CREW_PRESENCE_GRACE_MS = process.env.CREW_PRESENCE_GRACE_MS || '30';
const { createCrew } = require('../../lib/crew/index.cjs');

function makeCrew() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-unit-'));
  const crew = createCrew({
    dataDir, root: path.join(__dirname, '..', '..'), store: null, lan: false,
    mintKeycard: (taken) => { let c; do c = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-'); while (taken(c)); return c; },
  });
  return { crew, dataDir, close: () => crew.close() };
}

/** A fake SSE connection: the player has the office open until `leave()`. */
function present(crew, roomId, userId, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  const frames = [];
  const res = { writeHead() {}, write(t) { frames.push(t); }, end() {} };
  crew.hub.subscribe(roomId, userId, req, res);
  return { frames, leave: () => req.emit('close') };
}

function workerFor(crew, roomId, userId, opts = {}) {
  const { token } = crew.workers.mint(roomId, userId, opts);
  const req = { headers: { authorization: `Bearer ${token}` } };
  return { token, auth: () => crew.workers.authenticate(req) };
}

/** Two players, a password room, Bob joined. */
function room(crew) {
  const alice = crew.auth.register({ username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  const bob = crew.auth.register({ username: 'bob', password: 'bob-pass-12', displayName: 'Bob' });
  const r = crew.rooms.create(alice.id, { name: 'Studio', privacy: 'password', password: 'pw-1234', maxPlayers: 3 });
  crew.rooms.join(bob.id, { code: r.code, password: 'pw-1234' });
  return { alice, bob, room: r };
}

const agent = (crew, roomId, userId, name, role, extra = {}) => crew.agents.create(roomId, userId, { name, role, provider: 'scripted', model: 'scripted', tools: ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec'], budgetUsd: 10, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeCrew, present, workerFor, room, agent, sleep };
