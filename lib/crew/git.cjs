// Self-hosted Git for shared projects: authenticated remotes on the room host.
//
// Each project can hold one or more repositories (a website and a desktop app, say), kept
// as bare repos under <data>/git and served over Git's smart-HTTP protocol through the
// `git http-backend` that ships with Git — so any Git client, and every agent worker,
// clones, fetches and pushes with ordinary Git. GitHub is not involved.
//
// The rules the host enforces, whatever a client sends:
//   - Authentication on every request (worker token, or a personal Git token), and
//     authorisation per repository: read for project members and owners of lent agents,
//     write only to branches the pusher may own.
//   - `main` is protected: nobody pushes to it. It changes only through a reviewed merge the
//     host performs itself (`merge()`), after the project's approval policy allows it.
//   - No force-pushes and no branch deletions (receive.denyNonFastForwards/denyDeletes).
//   - Pushed content is scanned: `.env` files, private keys and credential-shaped strings are
//     refused before they land.
// Every accepted push is recorded with its pusher, the agent and task named in the commit
// trailers, the changed files and the test result, and announced to the room.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { newId, now, json, parse, sha256 } = require('./db.cjs');
const { httpError, cleanName } = require('./auth.cjs');

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
    dir TEXT NOT NULL, default_branch TEXT NOT NULL DEFAULT 'main', contract_paths TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS repos_name ON repos(project_id, name);
  CREATE TABLE IF NOT EXISTS git_tokens (
    token_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS git_events (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, repo_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, old TEXT, new TEXT,
    user_id TEXT, agent_id TEXT, task_id TEXT, tests TEXT, commits TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]',
    detail TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS git_events_repo ON git_events(repo_id, created_at);
`;

// What a push may not carry, by name and by content.
const SECRET_FILES = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key|credentials\.json|\.npmrc|\.netrc)$/i;
const SECRET_TEXT = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|sk-proj-[A-Za-z0-9_-]{20,}|wk_[A-Za-z0-9_-]{20,}|gt_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/;
const ALLOWED_EXAMPLE = /\.env\.example$/i;

const GITIGNORE = `# Never committed: settings, secrets, caches.
.env
.env.*
!.env.example
*.pem
*.key
node_modules/
__pycache__/
*.pyc
.venv/
dist/
build/
.DS_Store
`;

function createGit(crew) {
  const { db } = crew;
  db.raw.exec(MIGRATION);
  const root = path.join(crew.dataDir, 'git');
  fs.mkdirSync(root, { recursive: true });
  const gitBin = process.env.CREW_GIT || 'git';
  const hookScript = path.join(__dirname, 'git-hook.cjs');

  const run = (args, opts = {}) => execFileSync(gitBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  const tryRun = (args, opts) => { try { return { ok: true, out: run(args, opts) }; } catch (e) { return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) }; } };

  let available = null;
  function hasGit() {
    if (available === null) { try { run(['--version']); available = true; } catch { available = false; } }
    return available;
  }

  const shape = (r) => r && ({
    id: r.id, projectId: r.project_id, name: r.name, defaultBranch: r.default_branch, contractPaths: parse(r.contract_paths, []),
    url: `/git/${r.id}.git`, createdAt: r.created_at,
  });
  const get = (id) => db.get('SELECT * FROM repos WHERE id = ?', id);
  const gitDir = (r) => path.join(root, r.dir);

  /** A bare repository with a first commit on `main`, protections on, and the hook installed. */
  function create(roomId, userId, projectId, { name, contractPaths = [] }) {
    if (!hasGit()) throw httpError(501, 'Git is not installed on the host computer, so shared repositories are unavailable. Install Git and restart the host.');
    const p = crew.work.projectFor(roomId, projectId);
    if (!crew.work.isMember(p.id, userId)) throw httpError(403, 'Join the project to add repositories.');
    const n = cleanName(name, 40).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!n) throw httpError(400, 'Give the repository a name, like "website" or "bot".');
    if (db.get('SELECT 1 FROM repos WHERE project_id = ? AND name = ?', p.id, n)) throw httpError(409, `This project already has a repository called ${n}.`);
    const id = newId('repo');
    const dir = `${id}.git`;
    const bare = path.join(root, dir);
    run(['init', '--bare', '--initial-branch=main', bare]);
    for (const [k, v] of [['receive.denyNonFastForwards', 'true'], ['receive.denyDeletes', 'true'], ['http.receivepack', 'true'], ['core.autocrlf', 'false'], ['receive.fsckObjects', 'true'], ['receive.maxInputSize', String(200 * 1024 * 1024)], ['uploadpack.allowFilter', 'false'], ['core.protectNTFS', 'true'], ['core.protectHFS', 'true']]) run(['--git-dir', bare, 'config', k, v]);
    // First commit, made without a working tree: README and a .gitignore that keeps secrets out.
    const blob = (text) => run(['--git-dir', bare, 'hash-object', '-w', '--stdin'], { input: text }).trim();
    const tree = run(['--git-dir', bare, 'mktree'], { input: `100644 blob ${blob(GITIGNORE)}\t.gitignore\n100644 blob ${blob(`# ${p.name} — ${n}\n\n${p.goal}\n`)}\tREADME.md\n` }).trim();
    const commit = run(['--git-dir', bare, 'commit-tree', tree, '-m', `Create ${n}`], { env: authorEnv('Crew Office host', 'host@crew.local') }).trim();
    run(['--git-dir', bare, 'update-ref', 'refs/heads/main', commit]);
    installHook(bare);
    db.run('INSERT INTO repos (id, room_id, project_id, name, dir, contract_paths, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, roomId, p.id, n, dir, json(contractPaths.map(String).slice(0, 10)), userId, now());
    crew.audit(roomId, userId, 'repo.create', { repoId: id, projectId: p.id, name: n });
    record(get(id), { kind: 'create', ref: 'refs/heads/main', old: null, new: commit, userId });
    return shape(get(id));
  }

  function installHook(bare) {
    const hook = path.join(bare, 'hooks', 'pre-receive');
    // Git runs hooks with its own sh; node is named by absolute path so PATH does not matter.
    fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${hookScript.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
  }

  function authorEnv(name, email) {
    return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }

  // --- authentication ---

  function mintToken(roomId, userId, label = 'Personal Git token') {
    crew.rooms.require(roomId, userId, 'view');
    const token = `gt_${crypto.randomBytes(24).toString('base64url')}`;
    db.run('INSERT INTO git_tokens (token_hash, room_id, user_id, label, created_at) VALUES (?,?,?,?,?)', sha256(token), roomId, userId, cleanName(label, 60), now());
    crew.audit(roomId, userId, 'git.token', { label });
    return { token };
  }

  /** Basic auth: any username, the password is a worker token or a personal Git token. */
  function identify(req, repo) {
    const h = String(req.headers.authorization ?? '');
    let secret = null;
    if (h.startsWith('Basic ')) secret = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
    else if (h.startsWith('Bearer ')) secret = h.slice(7);
    if (!secret) return null;
    if (secret.startsWith('wk_')) {
      const w = db.get('SELECT * FROM workers WHERE token_hash = ? AND revoked = 0', sha256(secret));
      return w && w.room_id === repo.room_id ? { userId: w.user_id, workerId: w.id } : null;
    }
    if (secret.startsWith('gt_')) {
      const t = db.get('SELECT * FROM git_tokens WHERE token_hash = ? AND revoked = 0', sha256(secret));
      return t && t.room_id === repo.room_id ? { userId: t.user_id } : null;
    }
    return null;
  }

  /** Who may read, and which branches they may push. Never taken from the client. */
  function access(repo, userId) {
    if (!crew.rooms.roleOf(repo.room_id, userId)) return { read: false };
    const member = crew.work.isMember(repo.project_id, userId);
    const agents = db.all("SELECT a.id, a.name, g.tools FROM project_grants g JOIN agents a ON a.id = g.agent_id WHERE g.project_id = ? AND a.owner_id = ? AND a.removed = 0", repo.project_id, userId);
    const read = member || agents.length > 0;
    // A player may push their own human branches and the branches of their own lent agents.
    const prefixes = [`refs/heads/user/${slug(userId)}/`];
    for (const a of agents) if (parse(a.tools, []).includes('git')) prefixes.push(`refs/heads/agent/${slug(a.name)}/`, `refs/heads/draft/${slug(a.name)}/`);
    return { read, write: member || agents.length > 0, prefixes };
  }

  // --- the smart-HTTP endpoint ---

  async function handle(req, res, url) {
    const m = url.pathname.match(/^\/git\/(repo_[A-Za-z0-9_-]+)\.git(\/.*)$/);
    if (!m) return false;
    const repo = get(m[1]);
    const deny = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain', ...extra }); res.end(`${msg}\n`); return true; };
    if (!repo) return deny(404, 'No such repository.');
    const who = identify(req, repo);
    if (!who) return deny(401, 'Sign in with a worker token or a personal Git token as the password.', { 'WWW-Authenticate': 'Basic realm="Crew Office Git"' });
    const can = access(repo, who.userId);
    const pushing = m[2].endsWith('git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
    if (pushing && crew.safety.isStopped(repo.room_id)) return deny(423, 'This office is under an emergency stop.');
    if (!can.read || (pushing && !can.write)) { crew.safety.denied(`git:${who.userId}`, repo.room_id, who.userId, 'git.access', `${pushing ? 'push' : 'read'} refused on ${repo.name}`); return deny(403, 'You do not have access to this repository.'); }
    if (!/^\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.*)$/.test(m[2])) return deny(404, 'Not a Git route.');

    const before = pushing && req.method === 'POST' ? refs(repo) : null;
    const env = {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${repo.dir}${m[2]}`, REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: who.userId, REMOTE_ADDR: req.socket.remoteAddress ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      // Read by the pre-receive hook (git-hook.cjs).
      CREW_ALLOWED_PREFIXES: can.prefixes.join(' '), CREW_PROTECTED: `refs/heads/${repo.default_branch}`,
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    const child = spawn(gitBin, ['http-backend'], { env, windowsHide: true });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk) => {
      if (headersDone) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf('\r\n\r\n') >= 0 ? head.indexOf('\r\n\r\n') : head.indexOf('\n\n');
      if (sep < 0) return undefined;
      const sepLen = head[sep] === 13 ? 4 : 2;
      const lines = head.slice(0, sep).toString('utf8').split(/\r?\n/);
      let status = 200;
      const headers = {};
      for (const l of lines) {
        const i = l.indexOf(':');
        if (i < 0) continue;
        const k = l.slice(0, i).trim();
        const v = l.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200; else headers[k] = v;
      }
      res.writeHead(status, headers);
      headersDone = true;
      res.write(head.slice(sep + sepLen));
      return undefined;
    });
    let errText = '';
    child.stderr.on('data', (c) => { errText += c; });
    await new Promise((resolve) => child.on('close', resolve));
    if (!headersDone) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end();
    if (errText.trim()) crew.jobsLog?.(errText);
    if (before) afterPush(repo, who, before);
    return true;
  }

  function refs(repo) {
    const out = tryRun(['--git-dir', gitDir(repo), 'for-each-ref', '--format=%(refname) %(objectname)']).out;
    return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split(' ')));
  }

  /** Record what a push changed, with provenance from the commit trailers. */
  function afterPush(repo, who, before) {
    const after = refs(repo);
    for (const [ref, sha] of Object.entries(after)) {
      if (before[ref] === sha) continue;
      const base = before[ref] ?? before[`refs/heads/${repo.default_branch}`];
      const commits = log(repo, base ? `${base}..${sha}` : sha, 50);
      const files = changedFiles(repo, base, sha);
      const t = commits[0]?.trailers ?? {};
      const agent = t['Crew-Agent'] ? crew.agents.get(t['Crew-Agent']) : null;
      record(repo, {
        kind: 'push', ref, old: before[ref] ?? null, new: sha, userId: who.userId,
        agentId: agent && agent.owner_id === who.userId ? agent.id : null, taskId: t['Crew-Task'] ?? null, tests: t['Crew-Tests'] ?? null, commits, files,
      });
    }
  }

  function record(repo, e) {
    const id = newId('gev');
    db.run('INSERT INTO git_events (id, room_id, repo_id, kind, ref, old, new, user_id, agent_id, task_id, tests, commits, files, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, repo.room_id, repo.id, e.kind, e.ref ?? null, e.old ?? null, e.new ?? null, e.userId ?? null, e.agentId ?? null, e.taskId ?? null, e.tests ?? null,
      json(e.commits ?? []), json(e.files ?? []), e.detail ? json(e.detail) : null, now());
    const ev = shapeEvent(db.get('SELECT * FROM git_events WHERE id = ?', id));
    crew.hub.broadcast(repo.room_id, 'git', ev);
    if (e.kind === 'push' || e.kind === 'merge') {
      const who = e.agentId ? crew.agents.get(e.agentId)?.name : crew.auth.getUser(e.userId)?.displayName;
      const p = crew.work.getProject(repo.project_id);
      if (p) {
        const branch = String(e.ref ?? '').replace('refs/heads/', '');
        crew.bus.post({ roomId: repo.room_id, channelId: p.channel_id, senderType: 'system', senderId: 'system', kind: 'system', taskId: e.taskId,
          body: `${e.kind === 'merge' ? 'Merged into' : 'Pushed to'} ${repo.name}/${branch} by ${who ?? 'someone'}: ${(e.commits ?? []).length} commit(s), ${(e.files ?? []).length} file(s)${e.tests ? `, tests ${e.tests}` : ''}.` });
      }
    }
    return ev;
  }

  const shapeEvent = (e) => ({
    id: e.id, repoId: e.repo_id, kind: e.kind, ref: e.ref, old: e.old, new: e.new, userId: e.user_id, agentId: e.agent_id, taskId: e.task_id,
    tests: e.tests, commits: parse(e.commits, []), files: parse(e.files, []), detail: parse(e.detail, null), createdAt: e.created_at,
  });

  function log(repo, range, max = 30) {
    const r = tryRun(['--git-dir', gitDir(repo), 'log', `--max-count=${max}`, '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:only,unfold)%x1e', range]);
    if (!r.ok) return [];
    return r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, author, email, at, subject, trailerText] = s.split('\x1f');
      const trailers = {};
      for (const line of String(trailerText ?? '').split('\n')) { const i = line.indexOf(':'); if (i > 0) trailers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      return { hash, author, email, at: Number(at) * 1000, subject, trailers };
    });
  }

  function changedFiles(repo, base, head) {
    const r = base ? tryRun(['--git-dir', gitDir(repo), 'diff', '--name-status', base, head]) : tryRun(['--git-dir', gitDir(repo), 'show', '--name-status', '--format=', head]);
    return r.ok ? r.out.split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p[p.length - 1] }; }) : [];
  }

  const branchHead = (repo, branch) => tryRun(['--git-dir', gitDir(repo), 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).out.trim() || null;

  function branches(repo) {
    const out = tryRun(['--git-dir', gitDir(repo), 'for-each-ref', 'refs/heads', '--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(subject)']).out;
    const main = branchHead(repo, repo.default_branch);
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, hash, at, subject] = l.split('\x1f');
      const counts = name === repo.default_branch ? '0\t0' : tryRun(['--git-dir', gitDir(repo), 'rev-list', '--left-right', '--count', `${main}...${hash}`]).out.trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      return { name, hash, at: Number(at) * 1000, subject, ahead: ahead || 0, behind: behind || 0, protected: name === repo.default_branch };
    });
  }

  /** The diff a reviewer reads: what the branch would bring into main, from their merge base. */
  function diff(repo, branch, { maxBytes = 200_000 } = {}) {
    const head = branchHead(repo, branch);
    if (!head) throw httpError(404, `No branch ${branch} in ${repo.name}.`);
    const main = branchHead(repo, repo.default_branch);
    const r = tryRun(['--git-dir', gitDir(repo), 'diff', '--no-color', `${main}...${head}`]);
    const stat = tryRun(['--git-dir', gitDir(repo), 'diff', '--stat', `${main}...${head}`]).out;
    const text = r.out.length > maxBytes ? `${r.out.slice(0, maxBytes)}\n… (diff truncated)` : r.out;
    return { head, base: main, stat, patch: text, files: changedFiles(repo, tryRun(['--git-dir', gitDir(repo), 'merge-base', main, head]).out.trim(), head) };
  }

  function readFile(repo, ref, file) {
    const r = tryRun(['--git-dir', gitDir(repo), 'show', `${ref}:${file}`]);
    return r.ok ? r.out : null;
  }

  /**
   * Merge a branch into the protected main, on the host, without a working tree. Conflicts
   * stop the merge and are reported; nothing is overwritten. Called only after the
   * approval policy allowed it (work.cjs).
   */
  function merge(repo, branch, { by, message, taskId = null }) {
    const head = branchHead(repo, branch);
    const main = branchHead(repo, repo.default_branch);
    if (!head) throw httpError(404, `No branch ${branch}.`);
    const mt = tryRun(['--git-dir', gitDir(repo), 'merge-tree', '--write-tree', '--name-only', '--messages', main, head]);
    if (!mt.ok) {
      const lines = mt.out.split('\n');
      const conflicted = [];
      for (const l of lines.slice(1)) { if (!l.trim()) break; conflicted.push(l.trim()); }
      return { merged: false, conflict: true, files: conflicted };
    }
    const tree = mt.out.split('\n')[0].trim();
    const commit = run(['--git-dir', gitDir(repo), 'commit-tree', tree, '-p', main, '-p', head, '-m', message], { env: authorEnv('Crew Office host', 'host@crew.local') }).trim();
    // Compare-and-swap: if main moved since we looked, nothing is lost — the merge is retried.
    const upd = tryRun(['--git-dir', gitDir(repo), 'update-ref', `refs/heads/${repo.default_branch}`, commit, main]);
    if (!upd.ok) return { merged: false, conflict: false, retry: true };
    const files = changedFiles(repo, main, commit);
    const ev = record(repo, { kind: 'merge', ref: `refs/heads/${repo.default_branch}`, old: main, new: commit, userId: by.userId ?? null, agentId: by.agentId ?? null, taskId, commits: log(repo, `${main}..${commit}`, 50), files, detail: { branch } });
    crew.contracts?.onMainChanged(repo, main, commit, files);
    return { merged: true, commit, event: ev };
  }

  /** A restorable point on main, as a tag. Rolling back makes a new commit; history is kept. */
  function snapshot(repo, label, by) {
    const main = branchHead(repo, repo.default_branch);
    const tag = `snapshot/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    run(['--git-dir', gitDir(repo), 'update-ref', `refs/tags/${tag}`, main]);
    record(repo, { kind: 'snapshot', ref: `refs/tags/${tag}`, new: main, userId: by, detail: { label: cleanName(label ?? '', 80) } });
    return { tag, commit: main };
  }

  function rollback(repo, tag, by) {
    const target = tryRun(['--git-dir', gitDir(repo), 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).out.trim();
    if (!target) throw httpError(404, 'No such snapshot.');
    const main = branchHead(repo, repo.default_branch);
    const tree = run(['--git-dir', gitDir(repo), 'rev-parse', `${target}^{tree}`]).trim();
    const commit = run(['--git-dir', gitDir(repo), 'commit-tree', tree, '-p', main, '-m', `Roll back to ${tag}`], { env: authorEnv('Crew Office host', 'host@crew.local') }).trim();
    run(['--git-dir', gitDir(repo), 'update-ref', `refs/heads/${repo.default_branch}`, commit, main]);
    return record(repo, { kind: 'rollback', ref: `refs/heads/${repo.default_branch}`, old: main, new: commit, userId: by, files: changedFiles(repo, main, commit), detail: { tag } });
  }

  const forProject = (projectId) => db.all('SELECT * FROM repos WHERE project_id = ? ORDER BY created_at', projectId).map(shape);
  const events = (repoId, limit = 60) => db.all('SELECT * FROM git_events WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?', repoId, limit).map(shapeEvent);
  const byName = (projectId, name) => db.get('SELECT * FROM repos WHERE project_id = ? AND (name = ? OR id = ?)', projectId, String(name ?? '').toLowerCase(), String(name ?? ''));
  const snapshots = (repo) => tryRun(['--git-dir', gitDir(repo), 'for-each-ref', 'refs/tags/snapshot', '--format=%(refname:short) %(objectname)']).out.split('\n').filter(Boolean).map((l) => { const [tag, commit] = l.split(' '); return { tag, commit }; });

  return {
    hasGit, create, get, byName, shape, forProject, mintToken, identify, access, handle, branches, diff, readFile, merge, snapshot, rollback, snapshots, events, log, branchHead, gitDir,
    SECRET_FILES, SECRET_TEXT, ALLOWED_EXAMPLE, root,
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x';

module.exports = { createGit, slug, SECRET_FILES, SECRET_TEXT, ALLOWED_EXAMPLE };
