// HTTP routes for the multiplayer office: /api/crew/*.
//
// Browser routes authenticate with the session cookie and, for anything that changes
// state, require the `X-Crew: 1` header — a custom header cannot be sent cross-origin
// without a CORS preflight this server never answers, which is the CSRF defence.
// Worker routes authenticate with a worker bearer token instead (see workers.cjs).

'use strict';

const fs = require('fs');
const path = require('path');
const { httpError } = require('./auth.cjs');
const { PERMISSIONS, PROVIDERS } = require('./catalog.cjs');
const { lanAddresses } = require('./lan.cjs');

const MAX_BODY = 1024 * 1024;

function createApi(crew) {
  const { db } = crew;
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }).replace(/\*$/, '(.*)')}$`);
    if (pattern.endsWith('*')) keys.push('rest');
    routes.push({ method, re, keys, handler, opts });
  };

  // --- helpers ---

  function cookieToken(req) {
    const header = req.headers.cookie ?? '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === crew.auth.COOKIE) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  function setCookie(req, res, token, maxAgeS) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${crew.auth.COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`);
  }

  const user = (req) => crew.auth.userForToken(cookieToken(req));
  function requireUser(req) {
    const u = user(req);
    if (!u) throw httpError(401, 'Sign in first.');
    return u;
  }

  function member(req, roomId, ability = 'view') {
    const u = requireUser(req);
    const room = crew.rooms.require(roomId, u.id, ability);
    return { u, room };
  }

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw httpError(413, 'Request body too large.');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Body must be JSON.'); }
  }

  async function rawBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw httpError(413, 'Chunk too large.');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function send(res, code, data) {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data ?? {}));
  }

  // --- identity ---

  route('POST', '/api/crew/register', async (req, res, p, b) => {
    const u = crew.auth.register(b);
    const { token } = crew.auth.login({ username: b.username, password: b.password });
    setCookie(req, res, token, 30 * 24 * 3600);
    return { user: u };
  });
  route('POST', '/api/crew/login', async (req, res, p, b) => {
    crew.limits.login(req);
    const { user: u, token } = crew.auth.login(b);
    setCookie(req, res, token, 30 * 24 * 3600);
    return { user: u };
  });
  route('POST', '/api/crew/logout', async (req, res) => { crew.auth.logout(cookieToken(req)); setCookie(req, res, '', 0); return { ok: true }; });
  route('GET', '/api/crew/me', async (req) => ({ user: user(req) }));
  route('PATCH', '/api/crew/me', async (req, res, p, b) => {
    const u = requireUser(req);
    const updated = crew.auth.updateProfile(u.id, b);
    for (const r of crew.rooms.listFor(u.id)) {
      crew.hub.broadcast(r.id, 'members', { members: crew.rooms.members(r.id) });
      if (crew.hub.online(r.id).includes(u.id)) crew.office.humanPresence(r.id, updated, true);
    }
    return { user: updated };
  });

  route('GET', '/api/crew/host-info', async () => ({
    version: crew.version, mode: crew.mode, port: crew.port(), lanAddresses: lanAddresses(), bind: crew.bind,
    providers: PROVIDERS, permissions: PERMISSIONS,
  }));
  route('GET', '/api/crew/lan-rooms', async () => ({ rooms: crew.lan?.rooms() ?? [] }));

  // --- rooms ---

  route('GET', '/api/crew/rooms', async (req) => ({ rooms: crew.rooms.listFor(requireUser(req).id) }));
  route('POST', '/api/crew/rooms', async (req, res, p, b) => {
    const room = crew.rooms.create(requireUser(req).id, b);
    // Before answering, so the first visitor walks into the furnished room, not a race.
    try { await crew.office.furnish(room.code); } catch (err) { crew.crash.record('furnish', err); }
    return { room };
  });
  route('POST', '/api/crew/rooms/join', async (req, res, p, b) => { crew.limits.join(req); return { room: crew.rooms.join(requireUser(req).id, b) }; });
  route('GET', '/api/crew/rooms/by-code/:code', async (req, res, p) => {
    const r = crew.rooms.byCode(p.code);
    if (!r) throw httpError(404, 'No office with that code on this host.');
    const u = user(req);
    const shape = crew.rooms.shape(r, u?.id);
    return { room: { id: shape.myRole ? shape.id : undefined, code: shape.code, name: shape.name, privacy: shape.privacy, hasPassword: shape.hasPassword, players: shape.players, maxPlayers: shape.maxPlayers, status: shape.status, myRole: shape.myRole } };
  });

  route('GET', '/api/crew/rooms/:room/state', async (req, res, p) => {
    const { u, room } = member(req, p.room);
    return snapshot(room, u);
  });
  route('GET', '/api/crew/rooms/:room/events', async (req, res, p) => {
    const { u } = member(req, p.room);
    crew.hub.subscribe(p.room, u.id, req, res);
    return undefined;
  }, { stream: true });

  route('PATCH', '/api/crew/rooms/:room/settings', async (req, res, p, b) => ({ room: crew.rooms.updateSettings(p.room, requireUser(req).id, b) }));
  route('POST', '/api/crew/rooms/:room/status', async (req, res, p, b) => ({ room: crew.rooms.setStatus(p.room, requireUser(req).id, b.status) }));
  route('POST', '/api/crew/rooms/:room/invites', async (req, res, p, b) => ({ invite: crew.rooms.createInvite(p.room, requireUser(req).id, b) }));
  route('POST', '/api/crew/rooms/:room/members/:user/role', async (req, res, p, b) => { crew.rooms.setRole(p.room, requireUser(req).id, p.user, b.role); return { ok: true }; });
  route('DELETE', '/api/crew/rooms/:room/members/:user', async (req, res, p) => { crew.rooms.kick(p.room, requireUser(req).id, p.user); return { ok: true }; });
  route('GET', '/api/crew/rooms/:room/export', async (req, res, p) => {
    const { u } = member(req, p.room, 'room.settings');
    return crew.backup.exportRoom(p.room, u.id);
  });

  // --- agents ---

  route('POST', '/api/crew/rooms/:room/agents', async (req, res, p, b) => ({ agent: crew.agents.create(p.room, requireUser(req).id, b) }));
  route('PATCH', '/api/crew/rooms/:room/agents/:agent', async (req, res, p, b) => ({ agent: crew.agents.update(inRoom(p).id, requireUser(req).id, b) }));
  // Stop everything of mine, now: running jobs stop at their next step, queued work waits.
  route('POST', '/api/crew/rooms/:room/agents-pause-all', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    const mine = crew.agents.ofOwner(p.room, u.id);
    for (const a of mine) crew.agents.setPaused(a.id, u.id, b.paused !== false);
    return { count: mine.length };
  });
  route('POST', '/api/crew/rooms/:room/agents/:agent/pause', async (req, res, p) => ({ agent: crew.agents.setPaused(inRoom(p).id, requireUser(req).id, true) }));
  route('POST', '/api/crew/rooms/:room/agents/:agent/resume', async (req, res, p) => ({ agent: crew.agents.setPaused(inRoom(p).id, requireUser(req).id, false) }));
  route('DELETE', '/api/crew/rooms/:room/agents/:agent', async (req, res, p) => { crew.agents.remove(inRoom(p).id, requireUser(req).id); return { ok: true }; });
  route('GET', '/api/crew/rooms/:room/agents/:agent', async (req, res, p) => {
    const { u } = member(req, p.room);
    const a = inRoom(p);
    const tasks = db.all('SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY updated_at DESC LIMIT 40', a.id).map(crew.work.shapeTask);
    const projects = db.all('SELECT project_id FROM project_grants WHERE agent_id = ?', a.id).map((g) => crew.work.getProject(g.project_id)).filter(Boolean).map((pr) => ({ id: pr.id, name: pr.name, status: pr.status }));
    const visible = new Set(crew.bus.channelsFor(p.room, u.id).map((c) => c.id));
    return {
      agent: crew.agents.shape(a, u.id), tasks, projects, jobs: crew.jobs.forAgent(a.id),
      messages: crew.bus.forAgent(a.id, 60).filter((m) => visible.has(m.channelId)),
      dmChannelId: a.owner_id === u.id ? crew.bus.dmChannel(p.room, u.id, a.id).id : null,
    };
  });
  route('POST', '/api/crew/rooms/:room/agents/:agent/chat', async (req, res, p, b) => {
    const { u } = member(req, p.room, 'chat');
    const a = inRoom(p);
    if (a.owner_id !== u.id) throw httpError(403, 'Direct chat runs on the owner’s worker and budget, so only the owner can chat with this agent. Mention it in a project channel instead.');
    const ch = crew.bus.dmChannel(p.room, u.id, a.id);
    const msg = crew.bus.post({ roomId: p.room, channelId: ch.id, senderType: 'human', senderId: u.id, toAgentId: a.id, kind: 'chat', body: b.text });
    db.run("UPDATE messages SET status = 'delivered' WHERE id = ?", msg.id);
    const job = crew.jobs.enqueue({ roomId: p.room, agentId: a.id, type: 'chat', refId: msg.id, idemKey: `chat:${msg.id}`, payload: { channelId: ch.id, userId: u.id, projectId: b.projectId ?? null } });
    return { message: msg, jobId: job.id, available: crew.agents.available(a) };
  });
  route('POST', '/api/crew/rooms/:room/agents/:agent/assign', async (req, res, p, b) => {
    const { u } = member(req, p.room, 'projects.join');
    const a = inRoom(p);
    return { task: crew.work.addTask(p.room, u.id, b.projectId, { ...b, agentId: a.id }) };
  });

  function inRoom(p) {
    const a = crew.agents.get(p.agent);
    if (!a || a.room_id !== p.room) throw httpError(404, 'No such agent in this office.');
    return a;
  }

  // --- chat ---

  route('GET', '/api/crew/rooms/:room/channels/:channel/messages', async (req, res, p, b, url) => {
    const { u } = member(req, p.room);
    return { messages: crew.bus.history(p.room, u.id, p.channel, { before: Number(url.searchParams.get('before')) || null, q: url.searchParams.get('q') }) };
  });
  route('POST', '/api/crew/rooms/:room/channels/:channel/messages', async (req, res, p, b) => {
    const { u } = member(req, p.room, 'chat');
    const ch = db.get('SELECT * FROM channels WHERE id = ? AND room_id = ?', p.channel, p.room);
    if (!ch || !crew.bus.canSee(ch, u.id)) throw httpError(404, 'No such channel.');
    if (ch.kind === 'dm') throw httpError(400, 'Use the agent chat endpoint for direct messages.');
    // A human @-mentioning an agent addresses it: the message lands in that agent's inbox,
    // read the next time it works. It does not start a job on someone else's budget.
    const mention = String(b.body ?? '').match(/@([A-Za-z0-9_.-]+)/);
    const target = mention ? crew.agents.resolve(p.room, mention[1]) : null;
    crew.limits.chat(u.id);
    return { message: crew.bus.post({ roomId: p.room, channelId: ch.id, senderType: 'human', senderId: u.id, toAgentId: target?.id ?? null, kind: 'chat', body: b.body }) };
  });
  route('POST', '/api/crew/rooms/:room/channels', async (req, res, p, b) => {
    member(req, p.room, 'chat');
    const name = String(b.name ?? '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(name)) throw httpError(400, 'Channel names are 2–40 lowercase letters, digits or dashes.');
    const ch = crew.bus.ensureChannel(p.room, name, 'public');
    return { channel: { id: ch.id, name: ch.name, kind: ch.kind } };
  });
  route('GET', '/api/crew/rooms/:room/search', async (req, res, p, b, url) => {
    const { u } = member(req, p.room);
    return { messages: crew.bus.search(p.room, u.id, String(url.searchParams.get('q') ?? '').slice(0, 100)) };
  });

  // --- projects & tasks ---

  route('POST', '/api/crew/rooms/:room/projects', async (req, res, p, b) => ({ project: crew.work.createProject(p.room, requireUser(req).id, b) }));
  route('GET', '/api/crew/rooms/:room/projects/:project', async (req, res, p) => {
    member(req, p.room);
    const pr = crew.work.projectFor(p.room, p.project);
    return { project: crew.work.shapeProject(pr), tasks: crew.work.listTasks(pr.id), files: crew.work.listFiles(pr), notes: crew.work.searchNotes('project', pr.id, '', 50) };
  });
  route('POST', '/api/crew/rooms/:room/projects/:project/join', async (req, res, p) => ({ project: crew.work.joinProject(p.room, requireUser(req).id, p.project) }));
  route('POST', '/api/crew/rooms/:room/projects/:project/start', async (req, res, p) => ({ project: crew.work.startProject(p.room, requireUser(req).id, p.project) }));
  route('POST', '/api/crew/rooms/:room/projects/:project/grants', async (req, res, p, b) => ({ grant: crew.work.grant(p.room, requireUser(req).id, p.project, b.agentId, b) }));
  route('DELETE', '/api/crew/rooms/:room/projects/:project/grants/:agent', async (req, res, p) => { crew.work.revokeGrant(p.room, requireUser(req).id, p.project, p.agent); return { ok: true }; });
  route('POST', '/api/crew/rooms/:room/projects/:project/tasks', async (req, res, p, b) => ({ task: crew.work.addTask(p.room, requireUser(req).id, p.project, b) }));
  route('POST', '/api/crew/rooms/:room/projects/:project/notes', async (req, res, p, b) => {
    const { u } = member(req, p.room, 'chat');
    const pr = crew.work.projectFor(p.room, p.project);
    if (!crew.work.isMember(pr.id, u.id)) throw httpError(403, 'Join the project to add notes.');
    return { note: crew.work.addNote(p.room, 'project', pr.id, { title: b.title, body: b.body, authorType: 'human', authorId: u.id }) };
  });
  route('GET', '/api/crew/rooms/:room/projects/:project/files/*', async (req, res, p) => {
    member(req, p.room);
    const pr = crew.work.projectFor(p.room, p.project);
    const text = crew.work.readFile(pr, decodeURIComponent(p.rest));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.end(text);
    return undefined;
  }, { stream: true });
  route('POST', '/api/crew/rooms/:room/tasks/:task/cancel', async (req, res, p) => { crew.work.cancelTask(p.room, requireUser(req).id, p.task); return { ok: true }; });
  route('POST', '/api/crew/rooms/:room/tasks/:task/retry', async (req, res, p) => { crew.work.retryTask(p.room, requireUser(req).id, p.task); return { ok: true }; });
  route('GET', '/api/crew/rooms/:room/jobs/:job/logs', async (req, res, p) => {
    member(req, p.room);
    const j = crew.jobs.get(p.job);
    if (!j || j.room_id !== p.room) throw httpError(404, 'No such job.');
    return { job: crew.jobs.shape(j), logs: crew.jobs.logs(j.id) };
  });

  route('POST', '/api/crew/rooms/:room/approvals/:approval', async (req, res, p, b) => ({ approval: crew.work.decide(p.room, requireUser(req).id, p.approval, b.decision, b.note) }));
  route('POST', '/api/crew/rooms/:room/notifications/read', async (req, res, p) => {
    const { u } = member(req, p.room);
    db.run('UPDATE notifications SET read = 1 WHERE room_id = ? AND user_id = ?', p.room, u.id);
    return { ok: true };
  });

  // --- workers (browser side: mint and revoke) ---

  route('POST', '/api/crew/rooms/:room/workers', async (req, res, p, b) => ({ worker: crew.workers.mint(p.room, requireUser(req).id, b) }));
  route('DELETE', '/api/crew/rooms/:room/workers/:worker', async (req, res, p) => { crew.workers.revoke(p.room, requireUser(req).id, p.worker); return { ok: true }; });

  // --- worker protocol ---

  const w = (req) => crew.workers.authenticate(req);
  route('GET', '/api/crew/worker/whoami', async (req) => {
    const wk = w(req);
    const room = crew.rooms.get(wk.room_id);
    return { workerId: wk.id, room: { id: room.id, name: room.name, code: room.code }, user: crew.auth.getUser(wk.user_id), alwaysOn: Boolean(wk.always_on),
      agents: crew.agents.ofOwner(wk.room_id, wk.user_id).map((a) => ({ id: a.id, name: a.name, provider: a.provider, model: a.model })) };
  }, { worker: true });
  route('GET', '/api/crew/worker/stream', async (req, res) => { crew.workers.stream(w(req), req, res); return undefined; }, { stream: true, worker: true });
  route('POST', '/api/crew/worker/claim', async (req, res, p, b) => {
    const wk = w(req);
    const job = crew.jobs.claim(wk, { blockedProviders: Array.isArray(b.blockedProviders) ? b.blockedProviders : [] });
    if (!job) return { job: null };
    return { job: { id: job.id, type: job.type }, context: crew.work.buildContext(job), leaseMs: crew.jobs.LEASE_MS };
  }, { worker: true });
  route('POST', '/api/crew/worker/heartbeat', async (req, res, p, b) => {
    const job = crew.jobs.held(w(req), b.jobId);
    return { cancel: Boolean(job.cancel) };
  }, { worker: true });
  route('POST', '/api/crew/worker/tool', async (req, res, p, b) => crew.hostTools.call(w(req), b), { worker: true });
  route('POST', '/api/crew/worker/authorize', async (req, res, p, b) => crew.hostTools.authorize(w(req), b), { worker: true });
  route('POST', '/api/crew/worker/local-done', async (req, res, p, b) => crew.hostTools.localDone(w(req), b), { worker: true });
  route('POST', '/api/crew/worker/usage', async (req, res, p, b) => crew.hostTools.usage(w(req), b), { worker: true });
  route('POST', '/api/crew/worker/log', async (req, res, p, b) => {
    const job = crew.jobs.held(w(req), b.jobId);
    crew.jobs.log(job, ['info', 'warn', 'error', 'model'].includes(b.level) ? b.level : 'info', String(b.text ?? '').slice(0, 2000));
    return { ok: true };
  }, { worker: true });
  route('POST', '/api/crew/worker/finish', async (req, res, p, b) => {
    const job = crew.jobs.held(w(req), b.jobId);
    const result = b.result && typeof b.result === 'object' ? {
      text: String(b.result.text ?? '').slice(0, 8000), summary: String(b.result.summary ?? '').slice(0, 500),
      pause: b.result.pause ? { kind: String(b.result.pause.kind).slice(0, 30), reason: String(b.result.pause.reason ?? '').slice(0, 500), resumeAfter: Number(b.result.pause.resumeAfter) || null } : undefined,
    } : null;
    return { job: crew.jobs.shape(crew.jobs.finish(job, { status: b.status, result, error: b.error })) };
  }, { worker: true });
  route('GET', '/api/crew/worker/files', async (req, res, p, b, url) => {
    // The files a sandboxed run starts from: only for a job whose agent may read them.
    const wk = w(req);
    const job = crew.jobs.held(wk, url.searchParams.get('jobId'));
    const ctx = crew.work.buildContext(job);
    if (!ctx.project || !ctx.tools.includes('read_file')) throw httpError(403, 'This job may not read project files.');
    const pr = crew.work.getProject(ctx.project.id);
    const files = {};
    let total = 0;
    for (const f of crew.work.listFiles(pr)) {
      const text = crew.work.readFile(pr, f.path);
      total += text.length;
      if (total > 4 * 1024 * 1024) break;
      files[f.path] = text;
    }
    return { files };
  }, { worker: true });

  // --- Git / Sync ---

  const repoIn = (p) => {
    const r = crew.git.get(p.repo);
    if (!r || r.room_id !== p.room) throw httpError(404, 'No such repository.');
    return r;
  };
  const canRead = (r, u) => { if (!crew.git.access(r, u.id).read) throw httpError(403, 'You do not have access to this repository.'); };
  route('POST', '/api/crew/rooms/:room/projects/:project/repos', async (req, res, p, b) => ({ repo: crew.git.create(p.room, requireUser(req).id, p.project, b) }));
  route('GET', '/api/crew/rooms/:room/projects/:project/git', async (req, res, p) => {
    const { u } = member(req, p.room);
    const pr = crew.work.projectFor(p.room, p.project);
    const out = [];
    for (const r of crew.git.forProject(pr.id)) {
      const repo = crew.git.get(r.id);
      if (!crew.git.access(repo, u.id).read) continue;
      out.push({ ...r, branches: crew.git.branches(repo), events: crew.git.events(r.id, 30), snapshots: crew.git.snapshots(repo) });
    }
    return { repos: out, merges: crew.reviews.forProject(pr.id), links: crew.contracts.forProject(pr.id) };
  });
  route('GET', '/api/crew/rooms/:room/repos/:repo/diff', async (req, res, p, b, url) => {
    const { u } = member(req, p.room);
    const r = repoIn(p);
    canRead(r, u);
    return crew.git.diff(r, String(url.searchParams.get('branch') ?? ''));
  });
  route('POST', '/api/crew/rooms/:room/repos/:repo/snapshots', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    const r = repoIn(p);
    if (!crew.work.isMember(r.project_id, u.id)) throw httpError(403, 'Join the project first.');
    return crew.git.snapshot(r, b.label, u.id);
  });
  route('POST', '/api/crew/rooms/:room/repos/:repo/rollback', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    const r = repoIn(p);
    if (crew.work.getProject(r.project_id).created_by !== u.id) throw httpError(403, 'Only the project creator can roll back main.');
    crew.audit(p.room, u.id, 'repo.rollback', { repoId: r.id, tag: b.tag });
    return { event: crew.git.rollback(r, String(b.tag ?? ''), u.id) };
  });
  route('POST', '/api/crew/rooms/:room/git-tokens', async (req, res, p, b) => crew.git.mintToken(p.room, requireUser(req).id, b.label));
  route('POST', '/api/crew/rooms/:room/contracts', async (req, res, p, b) => ({ link: crew.contracts.link(p.room, requireUser(req).id, b) }));

  // --- Rules, presets, task budgets ---

  route('GET', '/api/crew/rooms/:room/rules', async (req, res, p, b, url) => {
    member(req, p.room);
    const q = (k) => url.searchParams.get(k) || null;
    return { effective: crew.policies.effective(p.room, { projectId: q('projectId'), ownerId: q('ownerId'), agentId: q('agentId'), taskId: q('taskId') }) };
  });
  route('PUT', '/api/crew/rooms/:room/rules/:scope/:id', async (req, res, p, b) => crew.policies.set(p.room, requireUser(req).id, p.scope, p.id, b.rules));
  route('GET', '/api/crew/rooms/:room/rules/:scope/:id/history', async (req, res, p) => { member(req, p.room); return { history: crew.policies.history(p.room, p.scope, p.id) }; });
  route('GET', '/api/crew/rooms/:room/presets', async (req, res, p) => { member(req, p.room); return { presets: crew.policies.listPresets(p.room) }; });
  route('POST', '/api/crew/rooms/:room/presets', async (req, res, p, b) => ({ preset: crew.policies.savePreset(p.room, requireUser(req).id, b) }));
  route('POST', '/api/crew/rooms/:room/tasks/:task/budget', async (req, res, p, b) => ({ task: crew.work.setTaskBudget(p.room, requireUser(req).id, p.task, b.pct) }));

  // --- Shared file storage: browsers ---

  const writer = (req, p) => {
    const { u } = member(req, p.room, 'chat');
    const pr = crew.work.projectFor(p.room, p.project);
    if (!crew.work.isMember(pr.id, u.id)) throw httpError(403, 'Join the project to publish files.');
    return { pr, by: { type: 'human', id: u.id } };
  };
  route('GET', '/api/crew/rooms/:room/projects/:project/blobs', async (req, res, p) => { member(req, p.room); return crew.files.list(crew.work.projectFor(p.room, p.project)); });
  route('GET', '/api/crew/rooms/:room/projects/:project/blobs/:blob', async (req, res, p) => {
    member(req, p.room);
    crew.files.download(crew.work.projectFor(p.room, p.project), p.blob, res);
    return undefined;
  }, { stream: true });
  route('POST', '/api/crew/rooms/:room/projects/:project/uploads', async (req, res, p, b) => { const { pr, by } = writer(req, p); return crew.files.begin(pr, by, b); });
  route('GET', '/api/crew/rooms/:room/projects/:project/uploads/:upload', async (req, res, p) => { const { pr, by } = writer(req, p); return crew.files.status(pr, p.upload, by); });
  route('PUT', '/api/crew/rooms/:room/projects/:project/uploads/:upload/chunks/:n', async (req, res, p, b) => { const { pr, by } = writer(req, p); return crew.files.chunk(pr, p.upload, by, p.n, b, req.headers['x-chunk-sha256'] || null); }, { raw: true });
  route('POST', '/api/crew/rooms/:room/projects/:project/uploads/:upload/finalize', async (req, res, p) => { const { pr, by } = writer(req, p); return { file: crew.files.finalize(pr, p.upload, by) }; });

  // --- Backups (the whole host) ---

  route('POST', '/api/crew/rooms/:room/backups', async (req, res, p) => { const { u } = member(req, p.room, 'room.stop'); crew.audit(p.room, u.id, 'backup.create', {}); return crew.backup.snapshot(); });
  route('GET', '/api/crew/rooms/:room/backups', async (req, res, p) => { member(req, p.room, 'room.stop'); return { backups: crew.backup.listBackups() }; });

  // --- Worker: provider state, resuming a handoff, publishing files ---

  route('POST', '/api/crew/worker/providers', async (req, res, p, b) => { crew.workers.reportProviders(w(req), b.providers); return { ok: true }; }, { worker: true });
  route('POST', '/api/crew/worker/resume', async (req, res, p, b) => {
    const wk = w(req);
    const job = crew.jobs.get(b.jobId);
    const agent = job && crew.agents.get(job.agent_id);
    if (!job || !agent || agent.owner_id !== wk.user_id || job.room_id !== wk.room_id) throw httpError(404, 'No such job for this worker.');
    if (job.status !== 'waiting') throw httpError(409, 'That job is not waiting.');
    crew.jobs.requeue(job.id, { resume: { kind: String(b.kind ?? 'handoff') } });
    return { ok: true };
  }, { worker: true });
  const agentFile = (req, jobId) => {
    const wk = w(req);
    const job = crew.jobs.held(wk, jobId);
    const ctx = crew.work.buildContext(job);
    if (!ctx.project || !ctx.tools.includes('publish_file')) throw httpError(403, 'This job may not publish files.');
    return { pr: crew.work.getProject(ctx.project.id), by: { type: 'agent', id: job.agent_id }, taskId: ctx.task?.id ?? null };
  };
  route('POST', '/api/crew/worker/uploads', async (req, res, p, b) => { const { pr, by, taskId } = agentFile(req, b.jobId); return crew.files.begin(pr, by, { ...b, taskId }); }, { worker: true });
  route('PUT', '/api/crew/worker/uploads/:upload/chunks/:n', async (req, res, p, b, url) => { const { pr, by } = agentFile(req, url.searchParams.get('jobId')); return crew.files.chunk(pr, p.upload, by, p.n, b, req.headers['x-chunk-sha256'] || null); }, { worker: true, raw: true });
  route('POST', '/api/crew/worker/uploads/:upload/finalize', async (req, res, p, b) => { const { pr, by } = agentFile(req, b.jobId); return { file: crew.files.finalize(pr, p.upload, by) }; }, { worker: true });

  route('POST', '/api/crew/client-error', async (req, res, p, b) => {
    crew.limits.clientError(req);
    const file = crew.crash.write('client', String(b.context ?? 'browser').slice(0, 100), { name: 'ClientError', message: String(b.message ?? '').slice(0, 2000), stack: String(b.stack ?? '').slice(0, 8000) },
      { url: String(b.url ?? '').slice(0, 300), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200), user: user(req)?.username ?? null });
    return { logged: Boolean(file) };
  });

  function snapshot(room, u) {
    const projects = crew.work.listProjects(room.id);
    return {
      room: crew.rooms.shape(room, u.id), me: u, members: crew.rooms.members(room.id), agents: crew.agents.list(room.id, u.id),
      projects, tasks: projects.flatMap((pr) => crew.work.listTasks(pr.id)), channels: crew.bus.channelsFor(room.id, u.id),
      approvals: crew.work.approvalsFor(room.id, u.id), notifications: crew.work.notificationsFor(room.id, u.id), workers: crew.workers.list(room.id, u.id),
      feed: crew.bus.feed(room.id, u.id), seq: crew.hub.seq(room.id), permissions: PERMISSIONS, providers: PROVIDERS,
      repos: projects.flatMap((pr) => crew.git.forProject(pr.id)), merges: projects.flatMap((pr) => crew.reviews.forProject(pr.id)),
      providerStates: Object.fromEntries(crew.rooms.members(room.id).map((m) => [m.userId, crew.workers.providersOf(room.id, m.userId)])),
      gitAvailable: crew.git.hasGit(), rulesCatalog: crew.policies.RULES, riskTable: crew.policies.RISK,
      artifacts: projects.flatMap((pr) => crew.work.listFiles(crew.work.getProject(pr.id)).map((f) => ({ ...f, projectId: pr.id, projectName: pr.name }))),
      host: { lanAddresses: lanAddresses(), port: crew.port(), mode: crew.mode },
    };
  }

  /** Returns true when the request was ours (handled), false to fall through. */
  async function handle(req, res, url) {
    if (url.pathname === '/crew' || url.pathname === '/crew/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(crew.root, 'crew', 'lobby.html')));
      return true;
    }
    if (url.pathname === '/crew/join') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(crew.root, 'crew', 'lobby.html')));
      return true;
    }
    if (url.pathname.startsWith('/git/') && await crew.git.handle(req, res, url)) return true;
    if (!url.pathname.startsWith('/api/crew/')) return false;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        if (req.method !== 'GET' && !r.opts.worker && req.headers['x-crew'] !== '1') throw httpError(403, 'Missing X-Crew header.');
        const b = req.method === 'GET' ? {} : r.opts.raw ? await rawBody(req) : await body(req);
        const out = await r.handler(req, res, params, b, url);
        if (!r.opts.stream) send(res, 200, out);
      } catch (err) {
        if (!err.status) crew.crash.record(`${req.method} ${url.pathname}`, err);
        send(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong on the host. A crash log was written.', ...(err.needsPassword ? { needsPassword: true } : {}) });
      }
      return true;
    }
    send(res, 404, { error: 'No such crew route.' });
    return true;
  }

  return { handle, snapshot };
}

module.exports = { createApi };

