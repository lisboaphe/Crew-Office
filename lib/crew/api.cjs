// HTTP routes for the multiplayer office: /api/crew/*.
//
// Browser routes authenticate with the session cookie and, for anything that changes
// state, require the `X-Crew: 1` header — a custom header cannot be sent cross-origin
// without a CORS preflight this server never answers, which is the CSRF defence.
// Worker routes authenticate with a worker bearer token instead (see workers.cjs).

'use strict';

const { clean, SENSITIVE_FILE } = require('./scrub.cjs');
const fs = require('fs');
const path = require('path');
const { httpError } = require('./auth.cjs');
const { createHostConditions } = require('./host-conditions.cjs');

const hostConditions = createHostConditions();
const { PERMISSIONS, PROVIDERS } = require('./catalog.cjs');
const { lanAddresses } = require('./lan.cjs');
const { parseInvitation, joinUrl, appLink } = require('../relay/invitation.cjs');

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

  function cookieNamed(req, name) {
    const header = req.headers.cookie ?? '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  }
  const cookieToken = (req) => cookieNamed(req, crew.auth.COOKIE);

  function setCookie(req, res, token, maxAgeS) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.appendHeader('Set-Cookie', `${crew.auth.COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`);
  }

  const user = (req) => crew.auth.userForToken(cookieToken(req));
  function requireUser(req) {
    const u = user(req);
    if (!u) throw httpError(401, 'Enter your name in the lobby first.');
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

  // The computer the host runs on, reached directly. A tunnel or reverse proxy also connects
  // from loopback, so anything that names a forwarded client, or arrives under another
  // hostname, is somebody else.
  function localMachine(req) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
    if (req.crewViaRelay || ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip'].some((k) => req.headers[k])) return false;
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
  }

  // The owner of this computer: on it, and holding machine.key. Being on it is not enough,
  // because the owner's agents are too. See the header of auth.cjs.
  const MACHINE_COOKIE = 'crew_machine';
  const ownerOfComputer = (req) => localMachine(req) && crew.auth.isMachineKey(cookieNamed(req, MACHINE_COOKIE));
  function requireOwnerOfComputer(req) {
    if (!ownerOfComputer(req)) throw httpError(403, 'Only the Crew Office app on the computer hosting this office can do that.');
  }
  /** A project's contents are for its members, and the office's owner and admins. */
  function projectAccess(req, roomId, projectId) {
    const { u } = member(req, roomId);
    const pr = crew.work.projectFor(roomId, projectId);
    if (!crew.work.isMember(pr.id, u.id) && !['owner', 'admin'].includes(crew.rooms.roleOf(roomId, u.id))) throw httpError(403, 'Join this project to see inside it.');
    return { u, pr };
  }
  const startSessionFor = (req, res, userId) => setCookie(req, res, crew.auth.sessionFor(userId), crew.auth.ENTRY_TTL_MS / 1000);

  // --- identity ---

  route('POST', '/api/crew/enter', async (req, res, p, b) => {
    crew.limits.enter(req);
    const { user: u, token } = crew.auth.enter(b, { local: ownerOfComputer(req) });
    crew.audit(null, u.id, 'player.enter', { local: ownerOfComputer(req) });
    setCookie(req, res, token, crew.auth.ENTRY_TTL_MS / 1000);
    return { user: u };
  });

  // The app's window presents the key once; after that its cookie carries it.
  route('POST', '/api/crew/this-computer/pair', async (req, res, p, b) => {
    crew.limits.login(req);
    if (!localMachine(req) || !crew.auth.isMachineKey(b.key)) throw httpError(403, 'That is not this computer’s key.');
    res.appendHeader('Set-Cookie', `${MACHINE_COOKIE}=${encodeURIComponent(b.key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${crew.auth.ENTRY_TTL_MS / 1000}`);
    const mine = crew.auth.machinePlayer();
    if (mine) startSessionFor(req, res, mine.id);
    return { user: mine, players: crew.auth.players() };
  });
  route('GET', '/api/crew/this-computer', async (req) => {
    if (!ownerOfComputer(req)) return { owner: false };
    return { owner: true, current: crew.auth.machinePlayer()?.id ?? null, players: crew.auth.players() };
  });
  route('POST', '/api/crew/this-computer/player', async (req, res, p, b) => {
    requireOwnerOfComputer(req);
    const u = crew.auth.getUser(b.id);
    if (!u) throw httpError(404, 'No such player on this host.');
    crew.auth.setMachinePlayer(u.id);
    startSessionFor(req, res, u.id);
    return { user: u };
  });
  route('DELETE', '/api/crew/this-computer/player/:user', async (req, res, p) => {
    requireOwnerOfComputer(req);
    if (crew.auth.machinePlayer()?.id === p.user) throw httpError(409, 'Switch to another player before deleting this one.');
    crew.rooms.deletePlayer(p.user);
    return { ok: true, players: crew.auth.players() };
  });
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

  // The host's time and weather, for the office's clock and windows. Nothing here identifies anyone.
  route('GET', '/api/crew/host-conditions', async () => hostConditions.read());

  // Installing replaces the code this computer runs, so it is for the person sitting at it.
  // Nobody else is told an update exists: a guest cannot do anything about it.
  route('GET', '/api/crew/update', async (req) => {
    if (!ownerOfComputer(req)) return { available: false };
    return crew.updater.status({ force: new URL(req.url, 'http://host').searchParams.has('force') });
  });
  route('POST', '/api/crew/update/sign-in', async (req) => { requireOwnerOfComputer(req); return crew.updater.signIn(); });
  route('POST', '/api/crew/update/install', async (req) => {
    requireOwnerOfComputer(req);
    const result = await crew.updater.install({ appArgs: process.argv.includes('--private') ? ['--private'] : [] });
    // After the answer has gone: the installer is waiting for this process to end.
    setTimeout(() => { process.emit('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref(); }, 300);
    return result;
  });

  // Memory & Knowledge. Every check is in knowledge.cjs, or here for the code a graph is built from.
  route('GET', '/api/crew/rooms/:room/knowledge', async (req, res, p) => {
    const { u } = member(req, p.room);
    return { ...crew.knowledge.overview(p.room, u.id), canConfigure: ownerOfComputer(req) };
  });
  route('POST', '/api/crew/rooms/:room/knowledge/check', async (req, res, p) => {
    member(req, p.room);
    requireOwnerOfComputer(req);
    return crew.knowledge.checkEngines();
  });
  route('PUT', '/api/crew/knowledge/mem0-model', async (req, res, p, b) => { requireOwnerOfComputer(req); return { mem0: crew.knowledge.setMem0Model(b) }; });
  route('PATCH', '/api/crew/rooms/:room/projects/:project/knowledge', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    return crew.knowledge.setSettings(crew.work.projectFor(p.room, p.project), u.id, b);
  });
  route('GET', '/api/crew/rooms/:room/memories', async (req, res, p, b, url) => {
    const { u } = member(req, p.room);
    const q = url.searchParams;
    const found = await crew.knowledge.search(p.room, crew.knowledge.person(u.id), { query: q.get('q') ?? '', scope: q.get('scope') || null, projectId: q.get('project') || null, limit: 200 });
    return { engine: found.engine, note: found.note, memories: found.memories.map((r) => crew.knowledge.shape(r, u.id)) };
  });
  route('POST', '/api/crew/rooms/:room/memories', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    return { memory: crew.knowledge.add(p.room, crew.knowledge.person(u.id), b) };
  });
  route('PATCH', '/api/crew/rooms/:room/memories/:id', async (req, res, p, b) => {
    const { u } = member(req, p.room);
    return { memory: crew.knowledge.update(p.room, u.id, p.id, b) };
  });
  route('DELETE', '/api/crew/rooms/:room/memories/:id', async (req, res, p) => {
    const { u } = member(req, p.room);
    crew.knowledge.remove(p.room, u.id, p.id);
    return { ok: true };
  });
  const graphRepo = (req, p) => {
    const { u } = member(req, p.room);
    const pr = crew.work.projectFor(p.room, p.project);
    const repo = crew.git.get(p.repo);
    if (!repo || repo.project_id !== pr.id) throw httpError(404, 'No such repository in this project.');
    if (!crew.git.access(repo, u.id).read) { crew.audit(p.room, u.id, 'graph.denied', {}, { outcome: 'denied', resource: repo.id }); throw httpError(403, 'You do not have access to this repository.'); }
    if (!crew.knowledge.settingsOf(pr.id).graphify) throw httpError(409, 'The code graph is off for this project.');
    return { u, pr, repo };
  };
  route('GET', '/api/crew/rooms/:room/projects/:project/repos/:repo/graph', async (req, res, p) => {
    const { repo } = graphRepo(req, p);
    return { info: crew.knowledge.graphs.info(repo), graph: crew.knowledge.graphs.read(repo.id) };
  });
  route('POST', '/api/crew/rooms/:room/projects/:project/repos/:repo/graph/rebuild', async (req, res, p) => {
    const { u, repo } = graphRepo(req, p);
    if (!(await crew.knowledge.graphs.refresh()).installed) throw httpError(409, 'Graphify is not installed on the computer hosting this office.');
    crew.knowledge.graphs.schedule(repo);
    crew.audit(p.room, u.id, 'graph.rebuild', {}, { resource: repo.id });
    return { info: crew.knowledge.graphs.info(repo) };
  });
  route('GET', '/api/crew/rooms/:room/projects/:project/repos/:repo/graph/source', async (req, res, p, b, url) => {
    const { repo } = graphRepo(req, p);
    const info = crew.knowledge.graphs.info(repo);
    const file = url.searchParams.get('file') ?? '';
    if (!info.commit || !/^[^\0]{1,400}$/.test(file) || file.startsWith('-') || file.split('/').includes('..') || SENSITIVE_FILE.test(file)) throw httpError(400, 'That file cannot be shown.');
    const text = crew.git.readFile(repo, info.commit, file);
    if (text === null) throw httpError(404, 'That file is not in this version of the code.');
    return { commit: info.commit, file, text: clean(text).slice(0, 200_000) };
  });

  // Internet hosting. Set up at this computer's own keyboard.
  route('GET', '/api/crew/internet', async (req) => { requireOwnerOfComputer(req); return crew.relay.status(); });
  route('PUT', '/api/crew/internet', async (req, res, p, b) => {
    requireOwnerOfComputer(req);
    const out = crew.relay.configure(b);
    crew.audit(null, user(req)?.id ?? 'owner', 'relay.configure', { url: b.url !== undefined ? String(b.url).slice(0, 200) : undefined, enabled: b.enabled });
    return out;
  });
  route('GET', '/api/crew/host-info', async (req) => ({
    internet: { state: crew.relay.status().state, label: crew.relay.status().label, url: crew.relay.status().url }, viaRelay: Boolean(req.crewViaRelay),
    version: crew.version, build: crew.updater.build?.build ?? null, workerPort: Number(process.env.CREW_WORKER_PORT || 8790), mode: crew.mode, port: crew.port(), lanAddresses: lanAddresses(), bind: crew.bind,
    providers: PROVIDERS, permissions: PERMISSIONS,
  }));
  route('GET', '/api/crew/lan-rooms', async () => ({ rooms: crew.lan?.rooms() ?? [] }));

  // The host fetching its own public address: true only if the request really came down the tunnel.
  route('GET', '/api/crew/relay-probe', async (req, res, p, b, url) => {
    if (!req.crewViaRelay || !crew.relay.answerProbe(url.searchParams.get('nonce'))) throw httpError(404, 'Not here.');
    return { ok: true };
  });

  // --- invitations ---

  const badInvitation = (req) => {
    crew.safety.denied(req.crewClientIp ?? req.socket.remoteAddress ?? 'unknown', null, 'internet', 'invite.invalid', 'an invitation that does not exist or has ended');
    return httpError(403, 'That invitation has expired or been revoked. Ask for a new one.');
  };

  /** Holding the invitation is the permission, so nothing here needs a player yet. */
  route('GET', '/api/crew/invitations/preview', async (req, res, p, b, url) => {
    crew.limits.join(req);
    const q = { invite: url.searchParams.get('invite') || undefined, shortCode: url.searchParams.get('code') || undefined };
    const target = (q.invite || q.shortCode) ? crew.rooms.targetOf(q) : null;
    if (!target || (req.crewViaRelay && !crew.relay.exposes(target))) throw badInvitation(req);
    return { room: crew.rooms.preview(q) };
  });

  // Turn whatever was pasted, or arrived through crewoffice://, into a place to go. Asking another
  // computer about it is only for this computer's owner, so that a visitor cannot use this host to
  // poke at addresses of their choosing. Never reachable through the relay.
  route('POST', '/api/crew/invitations/resolve', async (req, res, p, b) => {
    crew.limits.join(req);
    const parsed = parseInvitation(b.text);
    if (!parsed) throw httpError(400, 'That is not an invitation link or a room code.');
    const q = parsed.kind === 'invite' ? `invite=${encodeURIComponent(parsed.invite)}` : `code=${encodeURIComponent(parsed.code)}`;
    if (parsed.kind === 'code' && !parsed.origin && crew.rooms.targetOf({ shortCode: parsed.code })) {
      return { url: joinUrl(parsed), transport: 'here', origin: null, room: crew.rooms.preview({ shortCode: parsed.code }) };
    }
    let origin = parsed.origin ?? null;
    let transport = origin && /^http:/.test(origin) ? 'direct' : 'link';
    if (!origin) {
      const near = crew.lan?.hostForCode(crew.lanHash(parsed.code));
      if (near) { origin = near; transport = 'direct'; } else { origin = await crew.relay.resolveCode(parsed.code); transport = 'relay'; }
    }
    const out = { url: joinUrl({ ...parsed, origin }), transport, origin };
    if (!ownerOfComputer(req)) return out;
    let seen;
    try { seen = await crew.relay.get(`${origin}/api/crew/invitations/preview?${q}`); } catch (err) { throw httpError(503, `Could not reach that office: ${err.message}`); }
    if (seen.status === 503) throw httpError(409, 'That office’s host is not online right now. Ask them to open Crew Office.');
    if (seen.status !== 200 || !seen.body?.room) throw httpError(seen.status === 429 ? 429 : 403, seen.body?.error ?? 'That invitation has expired or been revoked. Ask for a new one.');
    const r = seen.body.room;
    return { ...out, room: { name: String(r.name ?? '').slice(0, 60), hostName: String(r.hostName ?? '').slice(0, 60), needsPassword: Boolean(r.needsPassword), players: r.players | 0, maxPlayers: r.maxPlayers | 0, status: r.status === 'open' ? 'open' : 'stopped' } };
  });

  // --- rooms ---

  route('GET', '/api/crew/rooms', async (req) => ({ rooms: crew.rooms.listFor(requireUser(req).id) }));
  route('POST', '/api/crew/rooms', async (req, res, p, b) => {
    const room = crew.rooms.create(requireUser(req).id, b);
    // Before answering, so the first visitor walks into the furnished room, not a race.
    try { await crew.office.furnish(room.code); } catch (err) { crew.crash.record('furnish', err); }
    return { room };
  });
  route('POST', '/api/crew/rooms/join', async (req, res, p, b) => {
    crew.limits.join(req);
    // From the internet, a bare code to an Open office is not enough: Open means this network.
    if (req.crewViaRelay && !b.invite && !b.shortCode && crew.rooms.byCode(b.code)?.privacy === 'lan') throw httpError(403, 'This office takes an invitation link from outside its network.');
    if (req.crewViaRelay) {
      const target = crew.rooms.targetOf(b);
      if (target && !crew.relay.exposes(target)) throw httpError(403, 'This office is not being hosted right now.');
    }
    return { room: crew.rooms.join(requireUser(req).id, b) };
  });
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
  route('POST', '/api/crew/rooms/:room/delete', async (req, res, p, b) => { crew.rooms.remove(p.room, requireUser(req).id, b.confirm); return { ok: true }; });
  route('POST', '/api/crew/rooms/:room/status', async (req, res, p, b) => ({ room: crew.rooms.setStatus(p.room, requireUser(req).id, b.status) }));
  route('POST', '/api/crew/rooms/:room/invites', async (req, res, p, b) => ({ invite: crew.rooms.createInvite(p.room, requireUser(req).id, b) }));
  route('GET', '/api/crew/rooms/:room/invites', async (req, res, p) => ({ invites: crew.rooms.listInvites(p.room, requireUser(req).id) }));
  route('DELETE', '/api/crew/rooms/:room/invites/:code', async (req, res, p) => { crew.rooms.revokeInvite(p.room, requireUser(req).id, p.code); return { ok: true }; });

  // Host Office. What the screen shows comes from here, so "available" and a link can only ever
  // appear together, and only once the connection has been proved from outside.
  function hostingState(req, room) {
    const internet = crew.relay.status();
    const invite = crew.rooms.currentInvite(room.id);
    const hosted = Boolean(room.internet_hosted) || internet.manual;
    const usable = hosted && room.status === 'open';
    const lan = crew.bind === '127.0.0.1' ? [] : lanAddresses().map((a) => `http://${a}:${crew.port()}`);
    return {
      room: crew.rooms.shape(room, requireUser(req).id), internet: ownerOfComputer(req) ? internet : { state: internet.state, label: internet.label, url: internet.url },
      invite: invite ? { code: invite.code, usesLeft: invite.usesLeft, expiresAt: invite.expiresAt, shortCode: usable && internet.codesPublished ? invite.shortCode : null } : null,
      link: invite && usable && internet.url ? `${internet.url}/crew/join?invite=${invite.code}` : null,
      appLink: invite && usable && internet.url ? appLink(internet.url, invite.code) : null,
      lanLink: invite && room.status === 'open' && lan.length ? `${lan[0]}/crew/join?invite=${invite.code}` : null,
      players: crew.rooms.members(room.id).map((m) => ({ userId: m.userId, displayName: m.displayName, color: m.color, role: m.role, online: m.online })),
    };
  }
  route('GET', '/api/crew/rooms/:room/hosting', async (req, res, p) => { const { room } = member(req, p.room, 'view'); crew.rooms.require(p.room, requireUser(req).id, 'room.stop'); return hostingState(req, room); });
  route('POST', '/api/crew/rooms/:room/hosting', async (req, res, p, b) => {
    const u = requireUser(req);
    if (b.on === false) crew.rooms.stopHosting(p.room, u.id);
    else crew.rooms.startHosting(p.room, u.id, { internet: ownerOfComputer(req) });
    return hostingState(req, crew.rooms.get(p.room));
  });
  // Stops. Each checks who may press it on the host; hiding a button would protect nothing.
  route('POST', '/api/crew/rooms/:room/emergency-stop', async (req, res, p, b) => crew.safety.stopAll(p.room, requireUser(req).id, b.reason));
  route('POST', '/api/crew/rooms/:room/emergency-resume', async (req, res, p) => crew.safety.resume(p.room, requireUser(req).id));
  route('POST', '/api/crew/rooms/:room/projects/:project/stop', async (req, res, p) => crew.safety.stopProject(p.room, requireUser(req).id, p.project));
  route('GET', '/api/crew/rooms/:room/security', async (req, res, p) => securityOverview(req, p.room));
  route('GET', '/api/crew/rooms/:room/security/audit', async (req, res, p, b, url) => {
    const { u } = member(req, p.room);
    const staff = ['owner', 'admin'].includes(crew.rooms.roleOf(p.room, u.id));
    // A player sees their own trail; the whole office's is for those who run it.
    return { events: crew.safety.search(p.room, { q: url.searchParams.get('q') ?? '', outcome: url.searchParams.get('outcome'), actor: staff ? null : u.id }), chain: staff ? crew.safety.verify() : null };
  });

  function securityOverview(req, roomId) {
    const { u } = member(req, roomId);
    const staff = ['owner', 'admin'].includes(crew.rooms.roleOf(roomId, u.id));
    const effective = crew.policies.effective(roomId, {});
    const agents = db.all('SELECT * FROM agents WHERE room_id = ? AND removed = 0', roomId).filter((a) => staff || a.owner_id === u.id);
    const count = (sql, ...args) => db.get(sql, ...args).n;
    return {
      viewer: { staff }, profile: effective.approvalMode.value, emergency: crew.safety.stopState(roomId),
      counts: {
        running: count("SELECT COUNT(*) n FROM jobs WHERE room_id = ? AND status = 'leased'", roomId),
        queued: count("SELECT COUNT(*) n FROM jobs WHERE room_id = ? AND status = 'queued'", roomId),
        pendingApprovals: count("SELECT COUNT(*) n FROM approvals WHERE room_id = ? AND status = 'pending'", roomId),
        blocked24h: count("SELECT COUNT(*) n FROM audit WHERE room_id = ? AND outcome = 'denied' AND ts > ?", roomId, Date.now() - 86_400_000),
      },
      network: crew.relay.status().state !== 'off' ? crew.relay.status() : { label: crew.bind === '127.0.0.1' ? 'This computer only' : 'Your local network only' },
      players: staff ? crew.rooms.members(roomId).map((m) => ({ ...m, online: crew.hub.online(roomId).includes(m.userId),
        projects: db.all('SELECT p.id, p.name FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? AND p.room_id = ?', m.userId, roomId),
        agents: db.all('SELECT id, name FROM agents WHERE room_id = ? AND owner_id = ? AND removed = 0', roomId, m.userId),
        workers: db.all('SELECT name, last_seen, revoked FROM workers WHERE room_id = ? AND user_id = ?', roomId, m.userId).filter((w) => !w.revoked).length,
        recent: crew.safety.search(roomId, { actor: m.userId, limit: 8 }) })) : [],
      agents: agents.map((a) => ({
        id: a.id, name: a.name, ownerName: crew.auth.getUser(a.owner_id)?.displayName, status: a.status, tools: JSON.parse(a.tools), provider: a.provider, execution: 'On its owner’s own computer, in that worker’s sandbox',
        projects: db.all('SELECT p.id, p.name, g.tools FROM project_grants g JOIN projects p ON p.id = g.project_id WHERE g.agent_id = ?', a.id).map((g) => ({ id: g.id, name: g.name, tools: JSON.parse(g.tools), repos: crew.git.forProject(g.id).map((r) => r.name) })),
        recent: db.all("SELECT action, outcome, resource, ts FROM audit WHERE agent_id = ? ORDER BY id DESC LIMIT 8", a.id),
      })),
      workspaces: db.all('SELECT p.id, p.name, p.status FROM projects p WHERE p.room_id = ?', roomId).filter((p) => staff || crew.work.isMember(p.id, u.id)),
      invites: staff ? crew.rooms.listInvites(roomId, u.id) : [],
    };
  }
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
  // Owner only, like the instructions these extend.
  route('GET', '/api/crew/rooms/:room/agents/:agent/profile', async (req, res, p) => {
    const a = crew.agents.owned(inRoom(p).id, requireUser(req).id);
    return { profile: crew.profiles.get(a.id), rules: crew.policies.effective(p.room, { agentId: a.id }), catalog: crew.policies.RULES };
  });
  route('PUT', '/api/crew/rooms/:room/agents/:agent/profile', async (req, res, p, b) => ({ profile: crew.profiles.set(inRoom(p).id, requireUser(req).id, b) }));
  route('GET', '/api/crew/rooms/:room/agents/:agent/workspace', async (req, res, p) => {
    const { u } = member(req, p.room);
    const a = inRoom(p);
    const grants = db.all('SELECT project_id, tools FROM project_grants WHERE agent_id = ?', a.id);
    return {
      projects: grants.map((g) => crew.work.getProject(g.project_id)).filter(Boolean).filter((pr) => crew.work.isMember(pr.id, u.id) || pr.created_by === u.id || a.owner_id === u.id).map((pr) => {
        const open = db.get("SELECT * FROM tasks WHERE project_id = ? AND assigned_agent_id = ? AND status NOT IN ('completed','failed','cancelled','blocked') ORDER BY updated_at DESC LIMIT 1", pr.id, a.id);
        return {
          id: pr.id, name: pr.name, status: pr.status, repos: crew.git.forProject(pr.id).map((r) => ({ id: r.id, name: r.name, url: r.url, defaultBranch: r.defaultBranch })),
          branch: open ? crew.reviews.branchFor(a, open) : null, tools: JSON.parse(grants.find((g) => g.project_id === pr.id).tools),
          notes: crew.work.isMember(pr.id, u.id) ? crew.work.searchNotes('project', pr.id, '', 10).map((n) => ({ title: n.title, body: n.body.slice(0, 400) })) : [],
          artifacts: db.all('SELECT path, kind FROM artifacts WHERE project_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 15', pr.id, a.id),
        };
      }),
    };
  });
  route('GET', '/api/crew/rooms/:room/agents/:agent', async (req, res, p) => {
    const { u } = member(req, p.room);
    const a = inRoom(p);
    const staff = ['owner', 'admin'].includes(crew.rooms.roleOf(p.room, u.id));
    const mayReadTask = (t) => a.owner_id === u.id || staff || crew.work.isMember(t.project_id, u.id);
    const tasks = db.all('SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY updated_at DESC LIMIT 40', a.id).filter(mayReadTask).map(crew.work.shapeTask);
    const projects = db.all('SELECT project_id FROM project_grants WHERE agent_id = ?', a.id).map((g) => crew.work.getProject(g.project_id)).filter(Boolean).map((pr) => ({ id: pr.id, name: pr.name, status: pr.status }));
    const visible = new Set(crew.bus.channelsFor(p.room, u.id).map((c) => c.id));
    return {
      agent: crew.agents.shape(a, u.id), tasks, projects, jobs: a.owner_id === u.id || staff ? crew.jobs.forAgent(a.id) : [],
      messages: crew.bus.forAgent(a.id, 60).filter((m) => visible.has(m.channelId)),
      dmChannelId: a.owner_id === u.id ? crew.bus.dmChannel(p.room, u.id, a.id).id : null,
    };
  });
  route('POST', '/api/crew/rooms/:room/agents/:agent/chat', async (req, res, p, b) => {
    const { u } = member(req, p.room, 'chat');
    const a = inRoom(p);
    if (a.owner_id !== u.id) throw httpError(403, 'Direct chat runs on the owner’s worker and budget, so only the owner can chat with this agent. Mention it in a project channel instead.');
    crew.safety.refuseIfStopped(p.room);
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
    const { pr } = projectAccess(req, p.room, p.project);
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
    const { pr, u } = projectAccess(req, p.room, p.project);
    const text = crew.work.readFile(pr, decodeURIComponent(p.rest));
    crew.audit(p.room, u.id, 'file.read', {}, { projectId: pr.id, resource: decodeURIComponent(p.rest).slice(0, 200) });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.end(text);
    return undefined;
  }, { stream: true });
  route('POST', '/api/crew/rooms/:room/tasks/:task/cancel', async (req, res, p) => { crew.work.cancelTask(p.room, requireUser(req).id, p.task); return { ok: true }; });
  route('POST', '/api/crew/rooms/:room/tasks/:task/retry', async (req, res, p) => { crew.work.retryTask(p.room, requireUser(req).id, p.task); return { ok: true }; });
  route('GET', '/api/crew/rooms/:room/jobs/:job/logs', async (req, res, p) => {
    const { u } = member(req, p.room);
    const j = crew.jobs.get(p.job);
    if (!j || j.room_id !== p.room) throw httpError(404, 'No such job.');
    const jobAgent = crew.agents.get(j.agent_id) ?? db.get('SELECT owner_id FROM agents WHERE id = ?', j.agent_id);
    const jobTask = j.type === 'task' ? crew.work.getTask(j.ref_id) : null;
    const staff = ['owner', 'admin'].includes(crew.rooms.roleOf(p.room, u.id));
    if (jobAgent?.owner_id !== u.id && !staff && !(jobTask && crew.work.isMember(jobTask.project_id, u.id))) throw httpError(403, 'These logs belong to a project you are not on.');
    return { job: crew.jobs.shape(j), logs: crew.jobs.logs(j.id) };
  });

  route('POST', '/api/crew/rooms/:room/approvals/:approval', async (req, res, p, b) => ({ approval: crew.work.decide(p.room, requireUser(req).id, p.approval, b.decision, b.note) }));
  route('POST', '/api/crew/rooms/:room/notifications/read', async (req, res, p) => {
    const { u } = member(req, p.room);
    db.run('UPDATE notifications SET read = 1 WHERE room_id = ? AND user_id = ?', p.room, u.id);
    return { ok: true };
  });

  // --- workers (browser side: mint and revoke) ---

  // Add a worker with no terminal: only for the app on the computer it would run on.
  route('POST', '/api/crew/rooms/:room/workers/start-here', async (req, res, p, b) => {
    requireOwnerOfComputer(req);
    const { u } = member(req, p.room);
    return crew.localWorker.startFor(p.room, u.id, { name: b.name, alwaysOn: b.alwaysOn });
  });
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

  route('GET', '/api/crew/rooms/:room/playbooks', async (req, res, p) => { member(req, p.room); return { playbooks: crew.playbooks.list(p.room), runs: crew.playbooks.listRuns(p.room), templates: crew.playbooks.templates() }; });
  route('POST', '/api/crew/rooms/:room/playbooks', async (req, res, p, b) => ({ playbook: crew.playbooks.create(p.room, requireUser(req).id, b) }));
  route('PUT', '/api/crew/rooms/:room/playbooks/:playbook', async (req, res, p, b) => { member(req, p.room); return { playbook: crew.playbooks.update(p.room, requireUser(req).id, p.playbook, b) }; });
  route('DELETE', '/api/crew/rooms/:room/playbooks/:playbook', async (req, res, p) => { member(req, p.room); crew.playbooks.remove(p.room, requireUser(req).id, p.playbook); return { ok: true }; });
  route('POST', '/api/crew/rooms/:room/playbooks/:playbook/run', async (req, res, p, b) => ({ run: crew.playbooks.start(p.room, requireUser(req).id, p.playbook, b) }));
  route('GET', '/api/crew/rooms/:room/runs/:run', async (req, res, p) => { member(req, p.room); return { run: crew.playbooks.getRun(p.room, p.run, requireUser(req).id) }; });
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
  route('GET', '/api/crew/rooms/:room/projects/:project/blobs', async (req, res, p) => { projectAccess(req, p.room, p.project); return crew.files.list(crew.work.projectFor(p.room, p.project)); });
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

  route('POST', '/api/crew/worker/notice', async (req, res, p, b) => { const wk = w(req); crew.work.notify(wk.room_id, wk.user_id, String(b.text ?? '').slice(0, 300), 'warn', 'usage'); return { ok: true }; }, { worker: true });
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
      projects, tasks: projects.filter((pr) => crew.work.isMember(pr.id, u.id) || ['owner', 'admin'].includes(crew.rooms.roleOf(room.id, u.id))).flatMap((pr) => crew.work.listTasks(pr.id)), channels: crew.bus.channelsFor(room.id, u.id),
      approvals: crew.work.approvalsFor(room.id, u.id), notifications: crew.work.notificationsFor(room.id, u.id), workers: crew.workers.list(room.id, u.id),
      feed: crew.bus.feed(room.id, u.id), seq: crew.hub.seq(room.id), permissions: PERMISSIONS, providers: PROVIDERS,
      repos: projects.flatMap((pr) => crew.git.forProject(pr.id)), merges: projects.flatMap((pr) => crew.reviews.forProject(pr.id)),
      providerStates: Object.fromEntries(crew.rooms.members(room.id).map((m) => [m.userId, crew.workers.providersOf(room.id, m.userId)])),
      emergency: crew.safety.stopState(room.id), gitAvailable: crew.git.hasGit(), rulesCatalog: crew.policies.RULES, riskTable: crew.policies.RISK,
      artifacts: projects.flatMap((pr) => crew.work.listFiles(crew.work.getProject(pr.id)).map((f) => ({ ...f, projectId: pr.id, projectName: pr.name }))),
      host: { internet: crew.relay.status(), lanAddresses: lanAddresses(), port: crew.port(), mode: crew.mode, workerPort: Number(process.env.CREW_WORKER_PORT || 8790) },
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
        if (err.status === 401 || err.status === 403) {
          const room = url.pathname.match(/\/rooms\/(room_[\w-]+)/)?.[1] ?? null;
          crew.safety.denied(req.crewClientIp ?? req.socket.remoteAddress ?? 'x', room, user(req)?.id ?? 'anonymous', 'request.denied', `${req.method} ${url.pathname.replace(/[\w-]{16,}/g, '…')}: ${err.message}`);
        }
        send(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong on the host. A crash log was written.', ...(err.needsPassword ? { needsPassword: true } : {}) });
      }
      return true;
    }
    send(res, 404, { error: 'No such crew route.' });
    return true;
  }

  /** Whether this request may see inside a hosted office's 3D data. Other offices are not ours to gate. */
  function mayEnterOffice(req, code) {
    const room = crew.rooms.byCode(code);
    if (!room) return true;
    const u = user(req);
    return Boolean(u && crew.rooms.roleOf(room.id, u.id));
  }

  return { handle, snapshot, mayEnterOffice };
}

module.exports = { createApi };

