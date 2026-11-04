// The multiplayer office host, assembled.
//
// One object, `crew`, that every module receives and reaches its siblings through. The
// server (server.cjs) creates it once at boot, hands it the office store so it can speak
// to the 3D office, and routes /crew and /api/crew/* to it.

'use strict';

const path = require('path');
const { openDb, now, json } = require('./db.cjs');
const { createAuth, httpError } = require('./auth.cjs');
const { createHub } = require('./hub.cjs');
const { createRooms } = require('./rooms.cjs');
const { createAgents } = require('./agents.cjs');
const { createWorkers } = require('./workers.cjs');
const { createBus } = require('./bus.cjs');
const { createJobs } = require('./jobs.cjs');
const { createWork } = require('./work.cjs');
const { createHostTools } = require('./host-tools.cjs');
const { createOfficeBridge } = require('./office.cjs');
const { createApi } = require('./api.cjs');
const { createCrashLog } = require('./crash.cjs');
const { createLan } = require('./lan.cjs');
const { createRateLimiter } = require('../rate-limit.cjs');
const { createGit } = require('./git.cjs');
const { createPolicies } = require('./policies.cjs');
const { createReviews } = require('./reviews.cjs');
const { createContracts } = require('./contracts.cjs');
const { createFiles } = require('./files.cjs');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SWEEP_MS = 5000;

function createCrew({ dataDir, root, store = null, mintKeycard, version = 'dev', mode = 'host', bind = '127.0.0.1', port = () => 0, lan = true, dbFile = null, log = console.log }) {
  const crew = { dataDir, root, store, version, mode, bind, port, mintKeycard };
  crew.crash = createCrashLog({ dir: path.join(dataDir, 'crash-logs'), version, component: 'host' });
  crew.db = openDb(dbFile ?? path.join(dataDir, 'crew.sqlite'));
  crew.auth = createAuth(crew.db);
  crew.hub = createHub({ onPresence: (roomId, userId, online) => presence(roomId, userId, online), graceMs: Number(process.env.CREW_PRESENCE_GRACE_MS) || undefined });
  const broadcast = crew.hub.broadcast;
  crew.hub.broadcast = (roomId, event, data, opts) => { crew.crash.remember(event, { roomId, ...(data && typeof data === 'object' ? { id: data.id, status: data.status } : {}) }); return broadcast(roomId, event, data, opts); };
  crew.audit = (roomId, actor, action, detail) => crew.db.run('INSERT INTO audit (room_id, actor, action, detail, ts) VALUES (?,?,?,?,?)', roomId, actor, action, json(detail), now());
  crew.rooms = createRooms(crew);
  crew.agents = createAgents(crew);
  crew.workers = createWorkers(crew);
  crew.bus = createBus(crew);
  crew.jobs = createJobs(crew);
  crew.work = createWork(crew);
  crew.hostTools = createHostTools(crew);
  crew.office = createOfficeBridge(crew);
  crew.policies = createPolicies(crew);
  crew.git = createGit(crew);
  crew.reviews = createReviews(crew);
  crew.contracts = createContracts(crew);
  crew.files = createFiles(crew);
  crew.backup = createBackup(crew);
  crew.limits = createLimits();
  crew.api = createApi(crew);
  crew.lan = lan ? createLan({ getRooms: () => crew.rooms.listLan(), port, log }) : null;

  function presence(roomId, userId, online) {
    crew.office.humanPresence(roomId, crew.auth.getUser(userId), online);
    // An attended worker's agents follow their owner in and out of the room.
    for (const a of crew.agents.ofOwner(roomId, userId)) crew.agents.refreshPresence(a.id);
    crew.hub.broadcast(roomId, 'members', { members: crew.rooms.members(roomId) });
    crew.work.kick();
  }

  // After a restart nothing is leased to anyone who is still here: put it all back.
  crew.db.run("UPDATE jobs SET status = 'queued', lease_worker = NULL, lease_until = 0, attempts = MAX(0, attempts - 1) WHERE status = 'leased'");
  crew.db.run("UPDATE tasks SET status = 'queued' WHERE status = 'in_progress'");
  crew.db.run("UPDATE agents SET status = 'OFFLINE' WHERE removed = 0 AND paused = 0");
  for (const r of crew.db.all("SELECT code FROM rooms WHERE status = 'open'")) crew.office.ensure(r.code);

  const sweeper = setInterval(() => {
    try { crew.workers.sweep(); crew.jobs.sweep(); crew.files.sweep(); crew.work.kick(); } catch (err) { crew.crash.record('sweep', err); }
  }, SWEEP_MS);
  sweeper.unref?.();

  function start() { crew.lan?.start(); }

  function close() {
    clearInterval(sweeper);
    crew.lan?.stop();
    crew.office.stop();
    crew.hub.closeAll();
    crew.workers.closeAll();
    crew.db.close();
  }

  crew.start = start;
  crew.close = close;
  return crew;
}

function createLimits() {
  const login = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const join = createRateLimiter({ limit: 20, windowMs: 60_000 });
  const chat = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const clientError = createRateLimiter({ limit: 20, windowMs: 60_000 });
  const key = (req) => req.socket.remoteAddress ?? 'unknown';
  const check = (lim, k, what) => {
    const r = lim.take(k);
    if (!r.ok) throw httpError(429, `Too many ${what}. Try again in ${Math.ceil(r.retryAfterMs / 1000)} s.`);
  };
  return {
    login: (req) => check(login, key(req), 'sign-in attempts'),
    join: (req) => check(join, key(req), 'join attempts'),
    chat: (userId) => check(chat, userId, 'messages'),
    clientError: (req) => check(clientError, key(req), 'error reports'),
  };
}

/**
 * Saving an office is automatic — every change is in the SQLite file under the data
 * directory, which is what reloads. Export is the portable copy: a JSON document of the
 * room, its projects, tasks, messages, notes and files, without password hashes and
 * without other players' private agent instructions.
 */
function createBackup(crew) {
  const { db } = crew;
  function exportRoom(roomId, userId) {
    const room = crew.rooms.get(roomId);
    const projects = db.all('SELECT * FROM projects WHERE room_id = ?', roomId);
    return {
      format: 'crew-office-export/1', exportedAt: new Date().toISOString(), exportedBy: crew.auth.getUser(userId)?.username,
      room: { name: room.name, code: room.code, privacy: room.privacy, maxPlayers: room.max_players, createdAt: room.created_at },
      members: crew.rooms.members(roomId).map((m) => ({ username: m.username, displayName: m.displayName, role: m.role })),
      agents: crew.agents.list(roomId, userId),
      projects: projects.map((p) => {
        const pr = crew.work.getProject(p.id);
        return {
          ...crew.work.shapeProject(pr), tasks: crew.work.listTasks(p.id), notes: crew.work.searchNotes('project', p.id, '', 500),
          files: Object.fromEntries(crew.work.listFiles(pr).map((f) => [f.path, crew.work.readFile(pr, f.path)])),
        };
      }),
      channels: crew.bus.channelsFor(roomId, userId).map((c) => ({ ...c, messages: crew.bus.history(roomId, userId, c.id, { limit: 5000 }) })),
    };
  }
  /**
   * A host-side backup: the database (a consistent copy via VACUUM INTO), every hosted Git
   * repository and every project's files, in one .tar under <data>/backups. Owner
   * credentials are not in it, because the host never has them: they live on workers.
   */
  function snapshot() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(crew.dataDir, 'backups', `backup-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    db.raw.exec(`VACUUM INTO '${path.join(dir, 'crew.sqlite').replace(/'/g, "''")}'`);
    for (const sub of ['git', 'rooms']) {
      const from = path.join(crew.dataDir, sub);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true, filter: (p) => !/[\\/]uploads([\\/]|$)/.test(p) });
    }
    fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ created: new Date().toISOString(), version: crew.version,
      includes: ['database (rooms, accounts, agents, projects, tasks, messages, approvals, rules, audit)', 'Git repositories', 'project files and file versions'],
      excludes: ['players’ API keys and subscription sign-ins (never on the host)', 'agents’ private memory (on workers)', 'unfinished uploads'] }, null, 2));
    const tar = path.join(crew.dataDir, 'backups', `backup-${stamp}.tar`);
    try {
      execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-cf', tar, '-C', path.dirname(dir), path.basename(dir)]);
      fs.rmSync(dir, { recursive: true, force: true });
      return { file: tar, size: fs.statSync(tar).size };
    } catch {
      return { file: dir, size: null };
    }
  }

  function listBackups() {
    const d = path.join(crew.dataDir, 'backups');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.startsWith('backup-')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(d, f)).size }));
  }

  return { exportRoom, snapshot, listBackups };
}

module.exports = { createCrew };
