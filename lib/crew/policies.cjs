// Agent working rules and approval policy, inherited down five levels:
//
//   office (room) → project → team (an owner's agents) → agent → task
//
// Each level may set any rule or leave it unset; the effective value is the most specific
// one set, and the UI shows which level it came from. Every change is a new version, kept.
//
// Some rules are enforced by the host — a task cannot be completed, merged or delegated
// without what they require. The rest are working instructions given to the model, and are
// labelled as such: the app does not pretend a prompt is a guarantee.
//
// Approval mode (manual / balanced / autonomous) only decides which *discretionary*
// actions wait for a human. Authentication, project grants, sandboxing, the protected
// branch and destructive-action safeguards apply in every mode.

'use strict';

const { newId, now, json, parse } = require('./db.cjs');
const { httpError, cleanName } = require('./auth.cjs');

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS rule_sets (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, rules TEXT NOT NULL,
    version INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS rule_sets_scope ON rule_sets(room_id, scope, scope_id);
  CREATE TABLE IF NOT EXISTS rule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rule_set_id TEXT NOT NULL, version INTEGER NOT NULL, rules TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, skills TEXT NOT NULL, tools TEXT NOT NULL,
    rules TEXT NOT NULL, instructions TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
`;

/**
 * The rules. `enforced` ones are checked by the host; the others are instructions.
 * Defaults are the office's starting point and can be changed at office level.
 */
const RULES = {
  approvalMode: { label: 'Approval mode', type: 'enum', values: ['manual', 'balanced', 'autonomous'], default: 'balanced', enforced: true },
  readContextFirst: { label: 'Read project instructions and relevant context first', type: 'bool', default: true, enforced: false },
  planFirst: { label: 'Write a short plan before starting', type: 'bool', default: true, enforced: false },
  styleGuide: { label: 'Style guide to follow', type: 'text', default: '', enforced: false },
  testsBeforeDone: { label: 'Run suitable tests before marking done', type: 'bool', default: true, enforced: true },
  requireReview: { label: 'Require a second-agent review before merge', type: 'bool', default: true, enforced: true },
  updateReadme: { label: 'Update README.md after an approved milestone', type: 'bool', default: false, enforced: true, optional: true },
  progressReports: { label: 'Write docs/progress/<agent-id>.md after each task', type: 'bool', default: false, enforced: true, optional: true },
  handoffNotes: { label: 'Write docs/handoffs/<task-id>.md when delegating', type: 'bool', default: false, enforced: true, optional: true },
  reportDetails: { label: 'Reports include changed files, tests, blockers and next steps', type: 'bool', default: true, enforced: false, optional: true },
  approveDocs: { label: 'Ask for approval before publishing documentation', type: 'bool', default: false, enforced: true, optional: true },
  syncMode: { label: 'Git sync mode', type: 'enum', values: ['smart', 'live', 'manual'], default: 'smart', enforced: true },
};

const SCOPES = ['office', 'project', 'team', 'agent', 'task'];

/**
 * Which actions wait for a human, per mode. `always` is a safeguard no mode removes.
 * Anything not listed is allowed in every mode (it is still subject to permissions).
 */
const RISK = {
  delete_shared: { always: true, label: 'Delete a shared file' },
  merge_main: { manual: true, balanced: true, autonomous: false, label: 'Merge into the protected main branch' },
  push_branch: { manual: true, balanced: false, autonomous: false, label: 'Push a branch to the host' },
  run_code: { manual: true, balanced: false, autonomous: false, label: 'Run code in the sandbox' },
  web_fetch: { manual: true, balanced: false, autonomous: false, label: 'Fetch a web page' },
  delegate: { manual: true, balanced: false, autonomous: false, label: 'Create a subtask for another agent' },
  publish_docs: { manual: true, balanced: false, autonomous: false, label: 'Publish documentation', ruleGated: 'approveDocs' },
  rollback_main: { always: true, label: 'Roll the main branch back' },
};

const PRESETS = [
  { name: 'Project Manager', role: 'Project Manager', skills: ['planning', 'coordination'], tools: ['messaging', 'files.read', 'memory', 'delegate'], rules: { planFirst: true, handoffNotes: true }, instructions: 'Break goals into small, testable tasks with clear owners. Keep the team unblocked; do not do the implementation yourself.' },
  { name: 'Developer', role: 'Developer', skills: ['javascript', 'node', 'web'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'exec', 'git'], rules: { testsBeforeDone: true, requireReview: true }, instructions: 'Make small, focused changes on your own branch. Add or update tests with every change.' },
  { name: 'Python Scripter', role: 'Python Scripter', skills: ['python', 'scripting', 'automation'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'exec', 'git'], rules: { testsBeforeDone: true, requireReview: true }, instructions: 'Write clear, typed Python with docstrings. Prefer the standard library.' },
  { name: 'Code Reviewer', role: 'Code Reviewer', skills: ['review', 'code quality'], tools: ['messaging', 'files.read', 'memory', 'git'], rules: { readContextFirst: true }, instructions: 'Review diffs for correctness, tests and clarity. Comment with exact file and line. Request changes when something is wrong; approve only what you would merge.' },
  { name: 'QA Tester', role: 'QA Engineer', skills: ['testing', 'qa'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'exec', 'git'], rules: { testsBeforeDone: true }, instructions: 'Write and run tests against the real code. Report defects with steps to reproduce.' },
  { name: 'Researcher', role: 'Researcher', skills: ['research'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'web'], rules: { reportDetails: true }, instructions: 'Cite sources. Separate facts from your own conclusions.' },
  { name: 'Designer', role: 'UI Designer', skills: ['design', 'css', 'accessibility'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'git'], rules: {}, instructions: 'Keep layouts simple and accessible; check contrast.' },
  { name: 'Technical Writer', role: 'Technical Writer', skills: ['documentation', 'writing'], tools: ['messaging', 'files.read', 'files.write', 'memory', 'git'], rules: { approveDocs: true, updateReadme: true }, instructions: 'Keep README for setup and stable architecture; put activity in progress reports.' },
  { name: 'Security Reviewer', role: 'Security Reviewer', skills: ['security', 'review'], tools: ['messaging', 'files.read', 'memory', 'git'], rules: { readContextFirst: true }, instructions: 'Look for injection, missing validation, secrets in code and unsafe defaults. Report severity and a fix.' },
];

function createPolicies(crew) {
  const { db } = crew;
  db.raw.exec(MIGRATION);

  function validate(rules) {
    const out = {};
    for (const [k, v] of Object.entries(rules ?? {})) {
      const def = RULES[k];
      if (!def) throw httpError(400, `Unknown rule ${k}.`);
      if (v === null || v === undefined) continue; // unset = inherit
      if (def.type === 'bool') out[k] = Boolean(v);
      else if (def.type === 'enum') { if (!def.values.includes(v)) throw httpError(400, `${k} must be one of ${def.values.join(', ')}.`); out[k] = v; }
      else out[k] = String(v).slice(0, 4000);
    }
    return out;
  }

  /** Who may set rules at each level: never a lower authority than the thing it governs. */
  function mayEdit(roomId, userId, scope, scopeId) {
    if (scope === 'office') return crew.rooms.can(roomId, userId, 'room.settings');
    if (scope === 'project') return crew.work.getProject(scopeId)?.created_by === userId;
    if (scope === 'team') return scopeId === userId;
    if (scope === 'agent') return crew.agents.get(scopeId)?.owner_id === userId;
    if (scope === 'task') {
      const t = crew.work.getTask(scopeId);
      if (!t) return false;
      const p = crew.work.getProject(t.project_id);
      return p.created_by === userId || crew.agents.get(t.assigned_agent_id)?.owner_id === userId;
    }
    return false;
  }

  function set(roomId, userId, scope, scopeId, rules) {
    if (!SCOPES.includes(scope)) throw httpError(400, 'Scope is office, project, team, agent or task.');
    if (!mayEdit(roomId, userId, scope, scopeId)) throw httpError(403, `You cannot change ${scope} rules here.`);
    const clean = validate(rules);
    const existing = db.get('SELECT * FROM rule_sets WHERE room_id = ? AND scope = ? AND scope_id = ?', roomId, scope, scopeId);
    const version = (existing?.version ?? 0) + 1;
    if (existing) db.run('UPDATE rule_sets SET rules = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?', json(clean), version, userId, now(), existing.id);
    else db.run('INSERT INTO rule_sets (id, room_id, scope, scope_id, rules, version, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)', newId('rul'), roomId, scope, scopeId, json(clean), version, userId, now());
    const row = db.get('SELECT * FROM rule_sets WHERE room_id = ? AND scope = ? AND scope_id = ?', roomId, scope, scopeId);
    db.run('INSERT INTO rule_history (rule_set_id, version, rules, updated_by, updated_at) VALUES (?,?,?,?,?)', row.id, version, json(clean), userId, now());
    crew.audit(roomId, userId, 'rules.set', { scope, scopeId, version, rules: clean });
    crew.hub.broadcast(roomId, 'rules', { scope, scopeId, version });
    return { scope, scopeId, version, rules: clean };
  }

  const raw = (roomId, scope, scopeId) => (scopeId ? parse(db.get('SELECT rules FROM rule_sets WHERE room_id = ? AND scope = ? AND scope_id = ?', roomId, scope, scopeId)?.rules, {}) : {});

  /** The effective rules for a context, each with the level it came from. */
  function effective(roomId, { projectId = null, ownerId = null, agentId = null, taskId = null } = {}) {
    if (agentId && !ownerId) ownerId = crew.agents.get(agentId)?.owner_id ?? null;
    if (taskId && !projectId) projectId = crew.work.getTask(taskId)?.project_id ?? null;
    const chain = [['office', roomId], ['project', projectId], ['team', ownerId], ['agent', agentId], ['task', taskId]];
    const out = {};
    for (const [k, def] of Object.entries(RULES)) out[k] = { value: def.default, source: 'default', enforced: def.enforced, label: def.label, optional: Boolean(def.optional) };
    for (const [scope, id] of chain) {
      const r = raw(roomId, scope, id);
      for (const [k, v] of Object.entries(r)) if (out[k]) { out[k].value = v; out[k].source = scope; }
    }
    // An agent configured to ask first (older setting) means manual approvals for it.
    const agent = agentId ? crew.agents.get(agentId) : null;
    if (agent?.autonomy === 'ask' && out.approvalMode.source === 'default') { out.approvalMode.value = 'manual'; out.approvalMode.source = 'agent'; }
    return out;
  }

  const value = (eff, k) => eff[k]?.value;

  /** Does this action need a human here? Returns null (go ahead) or the reason. */
  function needsApproval(action, eff) {
    const r = RISK[action];
    if (!r) return null;
    if (r.always) return `${r.label} always needs a human, in every approval mode.`;
    if (r.ruleGated && !value(eff, r.ruleGated)) return null;
    const mode = value(eff, 'approvalMode') ?? 'balanced';
    return r[mode] ? `${r.label} needs approval in ${mode} mode.` : null;
  }

  function history(roomId, scope, scopeId) {
    const row = db.get('SELECT * FROM rule_sets WHERE room_id = ? AND scope = ? AND scope_id = ?', roomId, scope, scopeId);
    return row ? db.all('SELECT version, rules, updated_by, updated_at FROM rule_history WHERE rule_set_id = ? ORDER BY version DESC', row.id)
      .map((h) => ({ version: h.version, rules: parse(h.rules, {}), updatedBy: crew.auth.getUser(h.updated_by)?.displayName, updatedAt: h.updated_at })) : [];
  }

  /** Instructions for the model, from the rules that are not host-enforced (and those that are, so it knows). */
  function promptLines(eff, agentId, taskId) {
    const lines = [];
    if (value(eff, 'readContextFirst')) lines.push('Read the project instructions, notes and the files relevant to your task before changing anything.');
    if (value(eff, 'planFirst')) lines.push('Before your first change, post a short plan with report_progress.');
    if (value(eff, 'styleGuide')) lines.push(`Follow this style guide:\n${value(eff, 'styleGuide')}`);
    if (value(eff, 'testsBeforeDone')) lines.push('Run suitable tests before finishing; work without passing tests is not accepted.');
    if (value(eff, 'requireReview')) lines.push('Your code is merged only after another agent reviews and approves it.');
    if (value(eff, 'progressReports')) lines.push(`Before finishing, write docs/progress/${agentId}.md with an entry for task ${taskId}: date, summary, changed files, commit hashes, tests, blockers, next steps, handoff target. The host checks it exists.`);
    if (value(eff, 'handoffNotes')) lines.push('When you delegate, include a handoff note; it is saved as docs/handoffs/<task-id>.md.');
    if (value(eff, 'updateReadme')) lines.push('After an approved milestone, update README.md (setup and stable architecture only, not an activity log).');
    if (value(eff, 'reportDetails')) lines.push('Summaries list changed files, tests run, what was completed, blockers and next steps.');
    return lines;
  }

  // --- presets ---

  function ensureBuiltins(roomId) {
    if (db.get('SELECT 1 FROM presets WHERE room_id = ? AND builtin = 1', roomId)) return;
    for (const p of PRESETS) {
      db.run('INSERT INTO presets (id, room_id, name, role, skills, tools, rules, instructions, builtin, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)',
        newId('pre'), roomId, p.name, p.role, json(p.skills), json(p.tools), json(p.rules), p.instructions, now());
    }
  }

  const shapePreset = (p) => ({ id: p.id, name: p.name, role: p.role, skills: parse(p.skills, []), tools: parse(p.tools, []), rules: parse(p.rules, {}), instructions: p.instructions, builtin: Boolean(p.builtin) });

  function listPresets(roomId) { ensureBuiltins(roomId); return db.all('SELECT * FROM presets WHERE room_id = ? ORDER BY builtin DESC, name', roomId).map(shapePreset); }

  function savePreset(roomId, userId, { id = null, name, role, skills = [], tools = [], rules = {}, instructions = '' }) {
    crew.rooms.require(roomId, userId, 'agents.create');
    const clean = validate(rules);
    const n = cleanName(name, 60);
    if (!n) throw httpError(400, 'Name the preset.');
    if (id) {
      const p = db.get('SELECT * FROM presets WHERE id = ? AND room_id = ?', id, roomId);
      if (!p) throw httpError(404, 'No such preset.');
      if (p.builtin) throw httpError(403, 'Built-in presets cannot be edited; clone it instead.');
      if (p.created_by !== userId) throw httpError(403, 'Only its author can edit this preset.');
      db.run('UPDATE presets SET name=?, role=?, skills=?, tools=?, rules=?, instructions=? WHERE id=?', n, cleanName(role, 60), json(skills), json(tools), json(clean), String(instructions).slice(0, 4000), id);
      return shapePreset(db.get('SELECT * FROM presets WHERE id = ?', id));
    }
    const nid = newId('pre');
    db.run('INSERT INTO presets (id, room_id, name, role, skills, tools, rules, instructions, builtin, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)',
      nid, roomId, n, cleanName(role, 60), json(skills), json(tools), json(clean), String(instructions).slice(0, 4000), userId, now());
    return shapePreset(db.get('SELECT * FROM presets WHERE id = ?', nid));
  }

  return { RULES, RISK, SCOPES, set, effective, value, needsApproval, history, promptLines, listPresets, savePreset, mayEdit };
}

module.exports = { createPolicies, RULES, RISK, PRESETS };
