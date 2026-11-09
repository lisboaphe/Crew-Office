// The room host's durable state: one SQLite file, through Node's built-in driver.
//
// Everything a room needs to survive a restart lives here — accounts, rooms, agents'
// configurations (never their owners' API keys: those stay on the owner's worker),
// messages, projects, tasks and the job queue. `node:sqlite` keeps the project at zero
// runtime dependencies, which is the convention this codebase was built on.
//
// Schema changes are append-only migrations, numbered, applied in order.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Silence the one ExperimentalWarning node:sqlite prints, and only that one.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (text && text.includes('SQLite is an experimental feature')) return;
  return emit.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, color TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL,
    privacy TEXT NOT NULL, password_hash TEXT, password_salt TEXT, max_players INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
  CREATE TABLE room_members (
    room_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id));
  CREATE TABLE invites (
    code TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_by TEXT NOT NULL, role TEXT NOT NULL,
    uses_left INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL, skills TEXT NOT NULL, instructions TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, tools TEXT NOT NULL, color TEXT NOT NULL, autonomy TEXT NOT NULL,
    budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'IDLE', paused INTEGER NOT NULL DEFAULT 0,
    is_manager INTEGER NOT NULL DEFAULT 0, current_task_id TEXT, created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, always_on INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    project_id TEXT, dm_user_id TEXT, dm_agent_id TEXT, created_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX channels_name ON channels(room_id, name);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, channel_id TEXT NOT NULL, seq INTEGER NOT NULL,
    sender_type TEXT NOT NULL, sender_id TEXT NOT NULL, to_agent_id TEXT, kind TEXT NOT NULL,
    body TEXT NOT NULL, correlation_id TEXT, reply_to TEXT, task_id TEXT, job_id TEXT,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE INDEX messages_channel ON messages(channel_id, seq);
  CREATE INDEX messages_corr ON messages(correlation_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL,
    created_by TEXT NOT NULL, manager_agent_id TEXT, status TEXT NOT NULL, summary TEXT,
    channel_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
  CREATE TABLE project_grants (
    project_id TEXT NOT NULL, agent_id TEXT NOT NULL, granted_by TEXT NOT NULL, tools TEXT NOT NULL,
    budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, requires_approval INTEGER NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (project_id, agent_id));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, milestone TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, role_hint TEXT, assigned_agent_id TEXT,
    status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, deps TEXT NOT NULL DEFAULT '[]',
    deliverables TEXT NOT NULL DEFAULT '[]', approval_state TEXT NOT NULL DEFAULT 'none',
    approved_by TEXT, result_summary TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
    timeout_s INTEGER NOT NULL DEFAULT 900, est_cost REAL NOT NULL DEFAULT 0, actual_cost REAL NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0, created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX tasks_project ON tasks(project_id);
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, agent_id TEXT, path TEXT NOT NULL,
    kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE memory (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, author_type TEXT NOT NULL, author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX memory_scope ON memory(scope, scope_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL,
    ref_id TEXT, idem_key TEXT UNIQUE, status TEXT NOT NULL, lease_worker TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, depth INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL, result TEXT, error TEXT, cancel INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX jobs_status ON jobs(status, agent_id);
  CREATE TABLE exec_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts INTEGER NOT NULL,
    level TEXT NOT NULL, text TEXT NOT NULL);
  CREATE INDEX exec_logs_job ON exec_logs(job_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, job_id TEXT, agent_id TEXT,
    approver_id TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER,
    created_at INTEGER NOT NULL);
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, level TEXT NOT NULL,
    link TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
    detail TEXT NOT NULL, ts INTEGER NOT NULL);
  `,
  // Memory & Knowledge. A memory remembers which commit it was written against.
  `
  ALTER TABLE memory ADD COLUMN project_id TEXT;
  ALTER TABLE memory ADD COLUMN repo_id TEXT;
  ALTER TABLE memory ADD COLUMN repo_commit TEXT;
  ALTER TABLE memory ADD COLUMN updated_at INTEGER;
  ALTER TABLE memory ADD COLUMN updated_by TEXT;
  ALTER TABLE memory ADD COLUMN mem0_id TEXT;
  CREATE INDEX memory_room ON memory(room_id);
  CREATE TABLE project_knowledge (
    project_id TEXT PRIMARY KEY, mem0 INTEGER NOT NULL DEFAULT 0, graphify INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT, updated_at INTEGER);
  CREATE TABLE knowledge_graphs (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL, repo_id TEXT NOT NULL UNIQUE,
    commit_sha TEXT, state TEXT NOT NULL, error TEXT, nodes INTEGER NOT NULL DEFAULT 0, edges INTEGER NOT NULL DEFAULT 0,
    built_at INTEGER, engine_version TEXT);
  `,
  // v-next: the character a player chose to appear as in the office.
  'ALTER TABLE users ADD COLUMN character INTEGER;',
  // v-next: a project has all of its creator's own agents on it (work.lendOwnTeam). Projects made
  // before that had only their manager, until each agent was lent by hand.
  `INSERT OR IGNORE INTO project_grants (project_id, agent_id, granted_by, tools, budget_usd, requires_approval, created_at)
     SELECT p.id, a.id, p.created_by, a.tools, MIN(a.budget_usd, 5), 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     FROM projects p JOIN agents a ON a.room_id = p.room_id AND a.owner_id = p.created_by AND a.removed = 0
     WHERE p.status != 'completed';`,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get();
  let v = row ? row.v : 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...args) => stmt(sql).get(...args) ?? null,
    all: (sql, ...args) => stmt(sql).all(...args),
    run: (sql, ...args) => stmt(sql).run(...args),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    close: () => db.close(),
  };
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const now = () => Date.now();
const json = (v) => JSON.stringify(v ?? null);
const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { openDb, newId, now, json, parse, sha256 };
