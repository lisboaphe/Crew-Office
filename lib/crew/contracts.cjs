// Cross-project dependency intelligence: explicit links from a dependent project to a
// contract file in another project's repository (an OpenAPI spec, a JSON Schema, a typed
// interface). When a merge into that repository's main changes the contract, the host
// compares old and new, and only the dependent projects are told — with a summary, the
// compatibility verdict and the new contract itself, not the provider's whole codebase —
// and each gets an adaptation task for its own agents, on their own branch, under the
// usual assignment approvals.

'use strict';

const { newId, now } = require('./db.cjs');
const { httpError } = require('./auth.cjs');

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS project_links (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, dependent_project_id TEXT NOT NULL, provider_repo_id TEXT NOT NULL,
    contract_path TEXT NOT NULL, created_by TEXT NOT NULL, last_commit TEXT, created_at INTEGER NOT NULL);
`;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** Compare two versions of a contract. OpenAPI is understood; anything else is diffed as text. */
function compare(oldText, newText) {
  let a = null;
  let b = null;
  try { a = JSON.parse(oldText ?? 'null'); b = JSON.parse(newText ?? 'null'); } catch { /* not JSON */ }
  if (a?.paths && b?.paths) {
    const ops = (spec) => new Set(Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item ?? {}).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${p}`)));
    const before = ops(a);
    const after = ops(b);
    const removed = [...before].filter((o) => !after.has(o));
    const added = [...after].filter((o) => !before.has(o));
    const required = (spec) => {
      const out = {};
      for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) out[name] = new Set(schema.required ?? []);
      return out;
    };
    const ra = required(a);
    const rb = required(b);
    const newlyRequired = [];
    for (const [name, set] of Object.entries(rb)) for (const f of set) if (!ra[name]?.has(f)) newlyRequired.push(`${name}.${f}`);
    const breaking = removed.length > 0 || newlyRequired.length > 0;
    return {
      kind: 'openapi', breaking, removed, added, newlyRequired,
      summary: [breaking ? 'BREAKING change' : 'Compatible change', removed.length ? `removed: ${removed.join(', ')}` : null,
        added.length ? `added: ${added.join(', ')}` : null, newlyRequired.length ? `newly required fields: ${newlyRequired.join(', ')}` : null, `version ${a.info?.version ?? '?'} → ${b.info?.version ?? '?'}`].filter(Boolean).join('; '),
    };
  }
  if (oldText === newText) return { kind: 'text', breaking: false, summary: 'unchanged' };
  return { kind: 'text', breaking: null, summary: 'contract text changed (not a format the host can check automatically)' };
}

function createContracts(crew) {
  const { db } = crew;
  db.raw.exec(MIGRATION);

  function link(roomId, userId, { dependentProjectId, providerRepoId, contractPath }) {
    const dep = crew.work.projectFor(roomId, dependentProjectId);
    if (dep.created_by !== userId) throw httpError(403, 'Only the dependent project’s creator can link it to a contract.');
    const repo = crew.git.get(providerRepoId);
    if (!repo || repo.room_id !== roomId) throw httpError(404, 'No such repository.');
    if (repo.project_id === dep.id) throw httpError(400, 'Link to another project’s repository.');
    const p = String(contractPath ?? '').replace(/^\/+/, '');
    if (!p || p.includes('..')) throw httpError(400, 'Name the contract file, e.g. openapi.json.');
    const id = newId('lnk');
    db.run('INSERT INTO project_links (id, room_id, dependent_project_id, provider_repo_id, contract_path, created_by, last_commit, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, roomId, dep.id, repo.id, p, userId, crew.git.branchHead(repo, repo.default_branch), now());
    crew.audit(roomId, userId, 'contract.link', { id, dependentProjectId: dep.id, providerRepoId: repo.id, contractPath: p });
    return shape(db.get('SELECT * FROM project_links WHERE id = ?', id));
  }

  const shape = (l) => ({ id: l.id, dependentProjectId: l.dependent_project_id, providerRepoId: l.provider_repo_id, repoName: crew.git.get(l.provider_repo_id)?.name, contractPath: l.contract_path, lastCommit: l.last_commit });
  const forProject = (projectId) => db.all('SELECT * FROM project_links WHERE dependent_project_id = ? OR provider_repo_id IN (SELECT id FROM repos WHERE project_id = ?)', projectId, projectId).map(shape);

  /** Called by git.merge() whenever a repository's main moves. */
  function onMainChanged(repo, oldCommit, newCommit, files) {
    const changed = new Set(files.map((f) => f.path));
    for (const l of db.all('SELECT * FROM project_links WHERE provider_repo_id = ?', repo.id)) {
      if (!changed.has(l.contract_path)) continue;
      const before = crew.git.readFile(repo, oldCommit, l.contract_path);
      const after = crew.git.readFile(repo, newCommit, l.contract_path);
      const verdict = compare(before, after);
      db.run('UPDATE project_links SET last_commit = ? WHERE id = ?', newCommit, l.id);
      const dep = crew.work.getProject(l.dependent_project_id);
      const provider = crew.work.getProject(repo.project_id);
      if (!dep) continue;
      const body = `Contract update from “${provider.name}” (${repo.name}/${l.contract_path} at ${newCommit.slice(0, 10)}): ${verdict.summary}.`;
      crew.bus.post({ roomId: repo.room_id, channelId: dep.channel_id, senderType: 'system', senderId: 'system', kind: 'system', body });
      crew.work.notify(repo.room_id, dep.created_by, body, verdict.breaking ? 'warn' : 'info', `contract:${l.id}`);
      if (['active', 'planning', 'completed'].includes(dep.status)) {
        if (dep.status === 'completed') db.run("UPDATE projects SET status = 'active' WHERE id = ?", dep.id);
        const agentId = crew.work.pickAgent(dep, 'integration developer api');
        const t = crew.work.createTask(crew.work.getProject(dep.id), {
          kind: 'work', title: `Adapt to ${repo.name} contract ${newCommit.slice(0, 8)}`, roleHint: 'integration developer', by: { type: 'agent', id: dep.manager_agent_id },
          description: `${body}\n\nThe new ${l.contract_path} is below. Check your project's integration against it, change your code on your own branch, add or update the contract/integration tests, run them (repo_sync), and request_merge. If nothing needs to change, say so in your merge request with the test evidence.\n\n${String(after ?? '').slice(0, 20_000)}`,
        });
        if (agentId) crew.work.assign(t.id, agentId, { by: { type: 'agent', id: dep.manager_agent_id } });
      }
    }
  }

  return { link, forProject, onMainChanged, compare };
}

module.exports = { createContracts, compare };
