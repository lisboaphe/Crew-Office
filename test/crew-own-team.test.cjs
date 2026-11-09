// A project has all of its creator's own agents on it: the manager can see, plan for and hand work
// to them without anyone lending them one by one. Another player's agents still come only by loan.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCrew, room, agent } = require('./lib/crew-unit.cjs');
const { openDb } = require('../lib/crew/db.cjs');

const team = (crew, p) => crew.work.shapeProject(crew.work.getProject(p.id)).grants.map((g) => crew.agents.get(g.agentId).name).sort();

test('creating a project puts all of the creator’s agents on it, and nobody else’s', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const kai = agent(crew, r.id, alice.id, 'Kai', 'Project Manager', { isManager: true });
  agent(crew, r.id, alice.id, 'Software Developer', 'Developer');
  agent(crew, r.id, bob.id, 'Boris', 'Backend');
  const p = crew.work.createProject(r.id, alice.id, { name: 'As Above So Below', goal: 'g', managerAgentId: kai.id });
  assert.deepEqual(team(crew, p), ['Kai', 'Software Developer']);
});

test('an agent made later joins its owner’s projects that are still going', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, bob, room: r } = room(crew);
  const kai = agent(crew, r.id, alice.id, 'Kai', 'PM', { isManager: true });
  const going = crew.work.createProject(r.id, alice.id, { name: 'Going', goal: 'g', managerAgentId: kai.id });
  const done = crew.work.createProject(r.id, alice.id, { name: 'Done', goal: 'g', managerAgentId: kai.id });
  crew.db.run("UPDATE projects SET status = 'completed' WHERE id = ?", done.id);
  agent(crew, r.id, alice.id, 'Dev', 'Developer');
  agent(crew, r.id, bob.id, 'Boris', 'Backend');
  assert.deepEqual(team(crew, going), ['Dev', 'Kai']);
  assert.deepEqual(team(crew, done), ['Kai'], 'a finished project is left as it was');
});

test('the manager can hand work to a teammate it could not see before', async (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const kai = agent(crew, r.id, alice.id, 'Kai', 'PM', { isManager: true });
  agent(crew, r.id, alice.id, 'Software Developer', 'Developer');
  const p = crew.work.createProject(r.id, alice.id, { name: 'P', goal: 'g', managerAgentId: kai.id });
  crew.db.run("UPDATE projects SET status = 'active' WHERE id = ?", p.id);
  const task = crew.work.addTask(r.id, alice.id, p.id, { title: 'Build it', agentId: crew.agents.resolve(r.id, 'Software Developer').id });
  assert.equal(task.assignedAgentName, 'Software Developer');
});

test('a project made before this gets its creator’s agents when the office is opened', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp_rovo_ownteam-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crew.db');
  // An office one migration behind, with a project that has only its manager.
  const first = openDb(file);
  const v = first.get('SELECT v FROM schema_version').v;
  first.close?.();
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE schema_version SET v = ${v - 1}`);
  raw.exec(`INSERT INTO agents (id, room_id, owner_id, name, role, skills, instructions, provider, model, tools, color, autonomy, budget_usd, is_manager, created_at)
            VALUES ('agt_kai', 'room1', 'usr_a', 'Kai', 'PM', '[]', '', 'scripted', 'scripted', '["messaging"]', '#fff', 'auto', 10, 1, 0),
                   ('agt_dev', 'room1', 'usr_a', 'Dev', 'Developer', '[]', '', 'scripted', 'scripted', '["exec"]', '#fff', 'auto', 3, 0, 0),
                   ('agt_bob', 'room1', 'usr_b', 'Boris', 'Backend', '[]', '', 'scripted', 'scripted', '[]', '#fff', 'auto', 10, 0, 0)`);
  raw.exec(`INSERT INTO projects (id, room_id, name, goal, created_by, manager_agent_id, status, channel_id, created_at, updated_at)
            VALUES ('prj_1', 'room1', 'Old', 'g', 'usr_a', 'agt_kai', 'active', 'ch1', 0, 0)`);
  raw.exec(`INSERT INTO project_grants (project_id, agent_id, granted_by, tools, budget_usd, requires_approval, created_at)
            VALUES ('prj_1', 'agt_kai', 'usr_a', '["messaging"]', 5, 0, 0)`);
  raw.close();
  const db = openDb(file);
  const grants = db.all('SELECT agent_id, tools, budget_usd, requires_approval FROM project_grants WHERE project_id = ? ORDER BY agent_id', 'prj_1');
  db.close?.();
  assert.deepEqual(grants.map((g) => g.agent_id), ['agt_dev', 'agt_kai'], 'Alice’s developer joined; Bob’s agent did not');
  const dev = grants.find((g) => g.agent_id === 'agt_dev');
  assert.deepEqual([dev.tools, dev.budget_usd, dev.requires_approval], ['["exec"]', 3, 0]);
});
