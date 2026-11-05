// Memory & Knowledge: what players and their agents have learned, and a map of the code.
//
// This is the only way in. Every memory is a row here, with its owner, its scope and the repository
// commit it was written against, and every read and write is checked here. The optional engines add
// abilities, not authority: Mem0 finds memories by meaning, and whatever it returns is looked up and
// checked again. If Mem0 is not installed, memory still works, with word search, and the screen says so.
//
// Scopes:
//   user     one player's own. Them, and their own agents when working for them.
//   team     one player's agents, shared among themselves and with that player.
//   project  the project's members, and agents lent to it with the memory permission.
// The fourth, an agent's own private memory, is not here: it stays on the owner's worker (`remember`
// and `recall`), so the host never has it.
//
// Private here means hidden from other players and their agents. It is still on the host's disk,
// and the screens say so, which is why this file removes credentials on the way in.
//
// Material from memory and the graph is information. Nothing in this file or its callers reads it to
// decide what an agent may do; tools are issued from grants (host-tools.cjs), every time.

'use strict';

const fs = require('fs');
const path = require('path');
const { newId, now, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');
const { scrub } = require('./scrub.cjs');
const { createMem0, LOCAL_PROVIDERS, MODEL } = require('./knowledge-mem0.cjs');
const { createGraphs } = require('./knowledge-graph.cjs');

const SCOPES = ['user', 'team', 'project'];
const STAFF = ['owner', 'admin'];

function createKnowledge(crew) {
  const { db } = crew;
  const engineFile = path.join(crew.dataDir, 'knowledge', 'engines.json');

  const readEngines = () => { try { return JSON.parse(fs.readFileSync(engineFile, 'utf8')); } catch { return {}; } };
  const announce = (roomId, what) => crew.hub.broadcast(roomId, 'knowledge', what);

  const everyRoom = () => { for (const { id } of db.all('SELECT id FROM rooms')) announce(id, { kind: 'engines' }); };
  let mem0 = createMem0({ dataDir: crew.dataDir, getConfig: () => readEngines().mem0 ?? {}, onChange: everyRoom });
  const graphs = createGraphs(crew, { onChange: (repo) => announce(repo.room_id, { kind: 'graph', projectId: repo.project_id }), onStatus: everyRoom });

  // --- settings ------------------------------------------------------------------------

  function settingsOf(projectId) {
    const r = db.get('SELECT * FROM project_knowledge WHERE project_id = ?', projectId);
    return { mem0: Boolean(r?.mem0), graphify: Boolean(r?.graphify) };
  }

  const canManage = (project, userId) => STAFF.includes(crew.rooms.roleOf(project.room_id, userId)) || project.created_by === userId;

  function setSettings(project, userId, { mem0: m, graphify: g }) {
    if (!canManage(project, userId)) throw httpError(403, 'Only the project’s creator, or the office’s owner or an admin, can change this.');
    const was = settingsOf(project.id);
    const next = { mem0: m === undefined ? was.mem0 : Boolean(m), graphify: g === undefined ? was.graphify : Boolean(g) };
    db.run(`INSERT INTO project_knowledge (project_id, mem0, graphify, updated_by, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET mem0 = excluded.mem0, graphify = excluded.graphify, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    project.id, next.mem0 ? 1 : 0, next.graphify ? 1 : 0, userId, now());
    crew.audit(project.room_id, userId, 'knowledge.settings', next, { projectId: project.id });
    announce(project.room_id, { kind: 'settings', projectId: project.id });
    if (next.graphify && !was.graphify) buildAll(project.id).catch((err) => crew.crash.record('graphify', err));
    if (next.mem0 && !was.mem0) mirrorProject(project.id).catch(() => {});
    return next;
  }

  async function buildAll(projectId) {
    const { installed } = await graphs.refresh();
    if (!installed) return;
    for (const r of crew.git.forProject(projectId)) graphs.schedule(crew.git.get(r.id));
  }

  /** Only from the app on the host's own computer (api.cjs): this decides what runs and downloads there. */
  function setMem0Model({ provider, model }) {
    if (!LOCAL_PROVIDERS.includes(provider)) throw httpError(400, `Choose a local provider: ${LOCAL_PROVIDERS.join(', ')}.`);
    if (!MODEL.test(String(model ?? ''))) throw httpError(400, 'Name the model exactly, such as BAAI/bge-small-en-v1.5.');
    const engines = readEngines();
    const changed = engines.mem0?.provider !== provider || engines.mem0?.model !== model;
    fs.mkdirSync(path.dirname(engineFile), { recursive: true });
    fs.writeFileSync(engineFile, JSON.stringify({ ...engines, mem0: { provider, model } }, null, 2));
    if (changed) {
      mem0.reset();
      db.run('UPDATE memory SET mem0_id = NULL');
    }
    return mem0.status();
  }

  const engineStatus = () => ({ mem0: mem0.status(), graphify: graphs.status(), providers: LOCAL_PROVIDERS });
  const checkEngines = async () => { await Promise.all([mem0.refresh(), graphs.refresh()]); return engineStatus(); };

  // --- who may do what ------------------------------------------------------------------

  /** An actor is a player, or an agent working for its owner in one project. */
  const person = (userId) => ({ userId });
  const agentActor = (agent, projectId) => ({ userId: agent.owner_id, agent, projectId });

  function agentHasMemory(agent, projectId) {
    const g = crew.work.grantOf(projectId, agent.id);
    if (!g) return false;
    return parse(g.tools, []).includes('memory') && parse(agent.tools, []).includes('memory');
  }

  function mayRead(row, actor) {
    if (!crew.rooms.roleOf(row.room_id, actor.userId)) return false;
    if (actor.agent) {
      // An agent only ever sees what belongs to the project it is working in, or to nothing in particular.
      if (!actor.projectId || !agentHasMemory(actor.agent, actor.projectId)) return false;
      if (row.project_id && row.project_id !== actor.projectId) return false;
    }
    if (row.scope === 'user' || row.scope === 'team') return row.scope_id === actor.userId;
    if (row.scope === 'project') {
      if (actor.agent) return row.scope_id === actor.projectId;
      return crew.work.isMember(row.scope_id, actor.userId) || STAFF.includes(crew.rooms.roleOf(row.room_id, actor.userId));
    }
    return false;
  }

  function checkWrite(roomId, actor, scope, projectId) {
    const role = crew.rooms.roleOf(roomId, actor.userId);
    if (!role || role === 'guest') throw httpError(403, 'Guests can watch, but not add memories.');
    if (scope === 'project') {
      const project = crew.work.projectFor(roomId, projectId);
      const allowed = actor.agent
        ? actor.projectId === project.id && agentHasMemory(actor.agent, project.id)
        : crew.work.isMember(project.id, actor.userId);
      if (!allowed) throw httpError(403, 'Join this project to add to its memory.');
    } else if (projectId) crew.work.projectFor(roomId, projectId);
    if (actor.agent && scope === 'user') throw httpError(403, 'An agent cannot write to its owner’s private memory.');
  }

  /** Editing and removing are for people. An agent can add, and its owner can tidy up after it. */
  function mayChange(row, userId) {
    if (!crew.rooms.roleOf(row.room_id, userId)) return false;
    if (row.scope !== 'project') return row.scope_id === userId;
    if (STAFF.includes(crew.rooms.roleOf(row.room_id, userId))) return true;
    if (row.author_type === 'human') return row.author_id === userId;
    return crew.agents.get(row.author_id)?.owner_id === userId;
  }

  const denied = (roomId, userId, what, resource) => {
    crew.audit(roomId, userId, 'memory.denied', { what }, { outcome: 'denied', resource });
    return httpError(403, 'You do not have access to that memory.');
  };

  // --- memory ----------------------------------------------------------------------------

  const namespace = (row) => `crew-${row.room_id}-${row.scope}-${row.scope_id}`;

  function repoVersion(projectId) {
    const first = projectId ? crew.git.forProject(projectId)[0] : null;
    if (!first) return { repoId: null, commit: null };
    const repo = crew.git.get(first.id);
    return { repoId: repo.id, commit: crew.git.branchHead(repo, repo.default_branch) };
  }

  function shape(row, viewerId) {
    let head = null;
    if (row.repo_id) { const repo = crew.git.get(row.repo_id); if (repo) head = crew.git.branchHead(repo, repo.default_branch); }
    const author = row.author_type === 'agent' ? crew.agents.get(row.author_id)?.name : crew.auth.getUser(row.author_id)?.displayName;
    return {
      id: row.id, scope: row.scope, scopeId: row.scope_id, projectId: row.project_id ?? (row.scope === 'project' ? row.scope_id : null),
      title: row.title, body: row.body, authorType: row.author_type, authorName: author ?? 'someone', createdAt: row.created_at, updatedAt: row.updated_at ?? row.created_at,
      repoId: row.repo_id, commit: row.repo_commit, codeMovedOn: Boolean(row.repo_commit && head && head !== row.repo_commit),
      canChange: viewerId ? mayChange(row, viewerId) : false,
    };
  }

  const mirrorable = (row) => {
    const projectId = row.project_id ?? (row.scope === 'project' ? row.scope_id : null);
    return projectId && settingsOf(projectId).mem0 && mem0.status().ready;
  };

  async function mirror(row) {
    if (!mirrorable(row)) return;
    const text = `${row.title}\n${row.body}`;
    try {
      if (row.mem0_id) await mem0.update(row.mem0_id, text);
      else {
        const { mem0Id } = await mem0.add(namespace(row), row.id, text);
        db.run('UPDATE memory SET mem0_id = ? WHERE id = ?', mem0Id, row.id);
      }
    } catch (err) { crew.crash.record('mem0', err); }
  }

  const mirroring = new Set();
  async function mirrorProject(projectId) {
    if (mirroring.has(projectId)) return;
    mirroring.add(projectId);
    try { await mirrorRows(projectId); } finally { mirroring.delete(projectId); }
  }

  async function mirrorRows(projectId) {
    const rows = db.all('SELECT * FROM memory WHERE mem0_id IS NULL AND (project_id = ? OR (scope = \'project\' AND scope_id = ?))', projectId, projectId);
    for (const row of rows) await mirror(row);
  }

  function add(roomId, actor, { scope, projectId = null, title, body }) {
    if (!SCOPES.includes(scope)) throw httpError(400, 'A memory is private to you (user), for your team, or for a project.');
    const text = String(body ?? '').trim();
    if (!text) throw httpError(400, 'Write something to remember.');
    checkWrite(roomId, actor, scope, projectId);
    const cleanBody = scrub(text.slice(0, 8000));
    const cleanTitle = scrub(String(title ?? '').trim().slice(0, 120) || text.split('\n')[0].slice(0, 80));
    const version = repoVersion(projectId);
    const id = newId('mem');
    const stamp = now();
    db.run(`INSERT INTO memory (id, room_id, scope, scope_id, title, body, author_type, author_id, created_at, project_id, repo_id, repo_commit, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, roomId, scope, scope === 'project' ? projectId : actor.userId, cleanTitle.text, cleanBody.text, actor.agent ? 'agent' : 'human', actor.agent?.id ?? actor.userId, stamp,
    projectId, version.repoId, version.commit, stamp, actor.agent?.id ?? actor.userId);
    const row = db.get('SELECT * FROM memory WHERE id = ?', id);
    crew.audit(roomId, actor.userId, 'memory.add', { scope, removedSecrets: cleanBody.removed + cleanTitle.removed }, { projectId, agentId: actor.agent?.id ?? null, resource: id });
    announce(roomId, { kind: 'memory' });
    mirror(row).catch(() => {});
    return { ...shape(row, actor.agent ? null : actor.userId), removedSecrets: cleanBody.removed + cleanTitle.removed };
  }

  function requireRow(roomId, id) {
    const row = db.get('SELECT * FROM memory WHERE id = ? AND room_id = ?', id, roomId);
    if (!row) throw httpError(404, 'No such memory.');
    return row;
  }

  function update(roomId, userId, id, { title, body }) {
    const row = requireRow(roomId, id);
    if (!mayChange(row, userId)) throw denied(roomId, userId, 'edit', id);
    const nextBody = body === undefined ? { text: row.body, removed: 0 } : scrub(String(body).trim().slice(0, 8000));
    // A title that was only ever the start of the text follows the text, or old words stay findable.
    const derived = row.body.split('\n')[0].slice(0, 80) === row.title;
    const nextTitle = title === undefined ? (derived ? { text: nextBody.text.split('\n')[0].slice(0, 80), removed: 0 } : { text: row.title, removed: 0 }) : scrub(String(title).trim().slice(0, 120));
    if (!nextBody.text) throw httpError(400, 'A memory cannot be empty. Remove it instead.');
    // Editing means someone looked at it again, so it now speaks for the code as it is today.
    const version = repoVersion(row.project_id ?? (row.scope === 'project' ? row.scope_id : null));
    db.run('UPDATE memory SET title = ?, body = ?, updated_at = ?, updated_by = ?, repo_id = ?, repo_commit = ? WHERE id = ?', nextTitle.text || row.title, nextBody.text, now(), userId, version.repoId, version.commit, id);
    const fresh = db.get('SELECT * FROM memory WHERE id = ?', id);
    crew.audit(roomId, userId, 'memory.edit', {}, { resource: id });
    announce(roomId, { kind: 'memory' });
    mirror(fresh).catch(() => {});
    return { ...shape(fresh, userId), removedSecrets: nextBody.removed + nextTitle.removed };
  }

  function remove(roomId, userId, id) {
    const row = requireRow(roomId, id);
    if (!mayChange(row, userId)) throw denied(roomId, userId, 'remove', id);
    db.run('DELETE FROM memory WHERE id = ?', id);
    crew.audit(roomId, userId, 'memory.remove', { scope: row.scope }, { resource: id });
    announce(roomId, { kind: 'memory' });
    if (row.mem0_id && mem0.status().installed) mem0.remove(row.mem0_id).catch((err) => crew.crash.record('mem0', err));
  }

  /** Everything this actor may read, filtered. Word search, ranked by how many words match. */
  function readable(roomId, actor, { scope = null, projectId = null } = {}) {
    const rows = db.all('SELECT * FROM memory WHERE room_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 2000', roomId);
    return rows.filter((row) => {
      if (scope && row.scope !== scope) return false;
      const belongsTo = row.project_id ?? (row.scope === 'project' ? row.scope_id : null);
      // An agent at work also has its owner's memories that belong to no project in particular.
      if (projectId && belongsTo !== projectId && !(actor.agent && !belongsTo)) return false;
      return mayRead(row, actor);
    });
  }

  function wordSearch(rows, query, limit) {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
    if (!terms.length) return rows.slice(0, limit);
    return rows
      .map((row) => {
        const hay = `${row.title}\n${row.body}`.toLowerCase();
        return { row, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.row);
  }

  /**
   * Search as this actor. Mem0 is asked only about namespaces this actor may read, and only when the
   * project has it on. Whatever comes back is found again in the actor's own readable rows, so a
   * result can never be something they may not see, whatever the engine holds.
   */
  async function search(roomId, actor, { query = '', scope = null, projectId = null, limit = 20 } = {}) {
    const rows = readable(roomId, actor, { scope, projectId });
    const q = String(query ?? '').trim().slice(0, 300);
    const useEngine = q && projectId && settingsOf(projectId).mem0 && mem0.status().ready;
    if (!useEngine) return { engine: 'words', memories: wordSearch(rows, q, limit), note: q && projectId && settingsOf(projectId).mem0 ? mem0.status().reason : null };
    mirrorProject(projectId).catch(() => {}); // anything written before Mem0 was ready
    const byId = new Map(rows.map((r) => [r.id, r]));
    const namespaces = [...new Set(rows.filter((r) => r.mem0_id).map(namespace))];
    try {
      const found = [];
      for (const ns of namespaces) {
        const { hits } = await mem0.search(ns, q, limit);
        for (const hit of hits) if (byId.has(hit.crewId)) found.push({ row: byId.get(hit.crewId), score: hit.score ?? 0 });
      }
      found.sort((a, b) => b.score - a.score);
      const seen = new Set();
      const memories = found.filter(({ row }) => (seen.has(row.id) ? false : seen.add(row.id))).slice(0, limit).map((x) => x.row);
      // A memory that has not reached the engine yet is still findable by its words.
      for (const row of wordSearch(rows.filter((r) => !r.mem0_id), q, limit)) if (!seen.has(row.id)) memories.push(row);
      return { engine: 'mem0', memories: memories.slice(0, limit), note: null };
    } catch (err) {
      crew.crash.record('mem0', err);
      return { engine: 'words', memories: wordSearch(rows, q, limit), note: `Mem0 could not answer, so this is word search: ${err.message.slice(0, 200)}` };
    }
  }

  // --- what agents get ---------------------------------------------------------------------

  const REFERENCE_CAP = 6000;

  /** What to put in front of an agent before it starts. Nothing, unless the project has it on. */
  function contextFor(agent, project, task) {
    if (!project) return null;
    const on = settingsOf(project.id);
    if (!on.mem0 && !on.graphify) return null;
    const q = [task?.title, task?.description].filter(Boolean).join(' ').slice(0, 300);
    const out = { memories: [], code: [] };
    if (on.mem0 && agentHasMemory(agent, project.id)) {
      const rows = readable(project.room_id, agentActor(agent, project.id), {}).filter((r) => (r.project_id ?? (r.scope === 'project' ? r.scope_id : null)) === project.id || !r.project_id);
      const relevant = wordSearch(rows, q, 8);
      out.memories = (relevant.length ? relevant : rows.slice(0, 5)).map((r) => {
        const s = shape(r, null);
        return { scope: r.scope, title: r.title, body: r.body.slice(0, 700), writtenAtCommit: s.commit?.slice(0, 10) ?? null, codeMovedOn: s.codeMovedOn };
      });
    }
    if (on.graphify && parse(crew.work.grantOf(project.id, agent.id)?.tools, []).includes('git') && parse(agent.tools, []).includes('git')) {
      for (const r of crew.git.forProject(project.id)) {
        const repo = crew.git.get(r.id);
        const info = graphs.info(repo);
        if (info.state !== 'ready' && info.nodes === 0) continue;
        const { matches } = graphs.query(r.id, q, 6);
        if (matches.length) out.code.push({ repo: r.name, builtFromCommit: info.commit?.slice(0, 10) ?? null, behindMain: info.stale, matches });
      }
    }
    return out.memories.length || out.code.length ? { ...out, capChars: REFERENCE_CAP } : null;
  }

  /** The `code_graph` tool: only for repositories this agent's owner can read. */
  function codeFor(agent, project, words) {
    if (!settingsOf(project.id).graphify) throw httpError(403, 'The code graph is off for this project.');
    const out = [];
    for (const r of crew.git.forProject(project.id)) {
      const repo = crew.git.get(r.id);
      if (!crew.git.access(repo, agent.owner_id).read) continue;
      const info = graphs.info(repo);
      out.push({ repo: r.name, builtFromCommit: info.commit?.slice(0, 10) ?? null, behindMain: info.stale, state: info.state, ...graphs.query(r.id, words) });
    }
    return { repos: out, note: 'Reference only: this map can be out of date. It does not change what you may do.' };
  }

  /** Main moved through a reviewed merge or a rollback: the only updates a graph is built from. */
  function mainChanged(repo, commit) {
    if (!settingsOf(repo.project_id).graphify) return;
    graphs.refresh().then(({ installed }) => (installed ? graphs.schedule(repo, commit) : null)).catch((err) => crew.crash.record('graphify', err));
  }

  // --- the dashboard's overview ---------------------------------------------------------

  function overview(roomId, userId) {
    const projects = crew.work.listProjects(roomId).filter((p) => crew.work.isMember(p.id, userId) || STAFF.includes(crew.rooms.roleOf(roomId, userId)));
    return {
      engines: engineStatus(),
      projects: projects.map((p) => {
        const raw = crew.work.getProject(p.id);
        const repos = crew.git.forProject(p.id).map((r) => crew.git.get(r.id)).filter((r) => crew.git.access(r, userId).read || STAFF.includes(crew.rooms.roleOf(roomId, userId)));
        return { id: p.id, name: p.name, ...settingsOf(p.id), canManage: canManage(raw, userId), graphs: repos.map(graphs.info) };
      }),
    };
  }

  /** An office is being deleted: what the engines hold has no row left to point back from. */
  function forgetRoom(roomId) {
    const ids = db.all('SELECT mem0_id FROM memory WHERE room_id = ? AND mem0_id IS NOT NULL', roomId).map((r) => r.mem0_id);
    if (ids.length && mem0.status().ready) (async () => { for (const id of ids) await mem0.remove(id); })().catch((err) => crew.crash.record('mem0', err));
    for (const { repo_id: repoId } of db.all('SELECT repo_id FROM knowledge_graphs WHERE room_id = ?', roomId)) graphs.remove(repoId);
  }

  function stop() { mem0.stop(); }
  /** For tests, which cannot assume Python. */
  const useMem0 = (engine) => { mem0 = engine; };

  return { overview, engineStatus, checkEngines, forgetRoom, useMem0, setMem0Model, settingsOf, setSettings, add, update, remove, search, readable, shape, person, agentActor, contextFor, codeFor, mainChanged, graphs, stop };
}

module.exports = { createKnowledge };
