#!/usr/bin/env node
// The multiplayer demo: Alice hosts, Bob joins, each brings three AI employees on their
// own worker, and Alice's project manager runs "Build a simple working task management
// web application" with the whole team.
//
//   npm run host                          # in one terminal: the room host
//   npm run demo                          # in another: scripted provider, no API key needed
//   npm run demo -- --provider anthropic  # real Claude models (ANTHROPIC_API_KEY in this shell)
//   npm run demo -- --manual              # leave every approval to you, in the browser
//   npm run demo -- --alice claude-cli --bob codex-cli   # Alice's team on her Claude
//                                         # subscription, Bob's on his ChatGPT one
//
// Then run `npm run app` and choose Alice or Bob from the players it lists, and
// watch the office. Both players stay "in the office" while this runs, because their
// workers are attended. Ctrl-C stops the workers, and the agents leave the floor.

'use strict';

// A demo's players share one computer and run each other's scripted code.
process.env.CREW_ALLOW_WEAK_SANDBOX ??= '1';

const { player, startWorker } = require('../lib/crew/demo-kit.cjs');
const { flags } = require('./lib/cli-flags.cjs');

const { flag, value } = flags(process.argv.slice(2));
const HOST = value('--host', process.env.CREW_HOST || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const PROVIDER = value('--provider', 'scripted');
const DEFAULT_MODEL = { anthropic: 'claude-opus-5-5', openai: 'gpt-5', local: 'llama3.1', scripted: 'scripted', 'claude-cli': 'default', 'codex-cli': 'default' };
// Each player's team can run on a different AI: --alice / --bob override --provider.
const TEAM = { alice: value('--alice', PROVIDER), bob: value('--bob', PROVIDER) };
const MANUAL = flag('--manual');
// The scripted provider answers instantly; pace it so the office is worth watching.
if (Object.values(TEAM).includes('scripted') && !process.env.CREW_SCRIPTED_DELAY_MS) process.env.CREW_SCRIPTED_DELAY_MS = value('--pace', '2500');
const PASS = { alice: 'demo-alice-pass', bob: 'demo-bob-pass' };

const say = (s) => console.log(`[demo] ${s}`);

async function account(p, username, displayName, color) {
  const r = await p.post('/api/crew/register', { username, password: PASS[username], displayName, color });
  if (r.status === 409) {
    const l = await p.post('/api/crew/login', { username, password: PASS[username] });
    if (l.status !== 200) throw new Error(`${username} exists on this host with another password: ${l.error}`);
  } else if (r.status !== 200) throw new Error(r.error);
}

async function main() {
  try { await fetch(`${HOST}/api/crew/host-info`); } catch { throw new Error(`No host at ${HOST}. Start one with: npm run host`); }
  const alice = player(HOST);
  const bob = player(HOST);
  await account(alice, 'alice', 'Alice', '#e07a5f');
  await account(bob, 'bob', 'Bob', '#3d85c6');

  const { room } = await alice.post('/api/crew/rooms', { name: 'Alice & Bob’s studio', privacy: 'password', password: 'demo-room', maxPlayers: 6 });
  say(`Alice hosted “${room.name}” — code ${room.code}, password demo-room`);
  const j = await bob.post('/api/crew/rooms/join', { code: room.code, password: 'demo-room' });
  if (j.status !== 200) throw new Error(j.error);
  say('Bob joined with the room code and password');
  const R = `/api/crew/rooms/${room.id}`;
  await alice.enter(room.id);
  await bob.enter(room.id);

  const tools = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec'];
  const mk = async (p, name, role, skills, color, extra = {}) => {
    const provider = TEAM[p === alice ? 'alice' : 'bob'];
    const model = value('--model', DEFAULT_MODEL[provider]);
    const r = await p.post(`${R}/agents`, { name, role, skills, color, provider, model, tools, budgetUsd: 20, ...extra });
    if (r.status !== 200) throw new Error(r.error);
    return r.agent;
  };
  const pm = await mk(alice, 'Paige', 'Project Manager', ['planning', 'coordination'], '#e07a5f', { isManager: true, instructions: 'Keep plans small and concrete. Make sure there is testing and a security review.' });
  const fe = await mk(alice, 'Felix', 'Frontend Developer', ['html', 'css', 'javascript'], '#f2a541');
  const ds = await mk(alice, 'Uma', 'UI Designer', ['css', 'design', 'accessibility'], '#f15bb5');
  const be = await mk(bob, 'Boris', 'Backend Developer', ['node', 'api', 'http'], '#3d85c6');
  const qa = await mk(bob, 'Quinn', 'QA Engineer', ['testing', 'node:test'], '#2a9d8f');
  const sec = await mk(bob, 'Sasha', 'Security Reviewer', ['security', 'review'], '#6c4fd1');
  say('Alice’s team: Paige (PM), Felix (frontend), Uma (design). Bob’s team: Boris (backend), Quinn (QA), Sasha (security).');

  const wa = await alice.post(`${R}/workers`, { name: 'Alice’s laptop' });
  const wb = await bob.post(`${R}/workers`, { name: 'Bob’s desktop' });
  const secrets = {
    ...(process.env.ANTHROPIC_API_KEY ? { anthropic: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
  };
  const log = (s) => console.log(`  ${s}`);
  const workers = [startWorker({ hostUrl: HOST, token: wa.worker.token, secrets, log }), startWorker({ hostUrl: HOST, token: wb.worker.token, secrets, log })];
  say(`Workers connected — Alice’s team on ${TEAM.alice}, Bob’s on ${TEAM.bob}${Object.values(TEAM).includes('scripted') ? ' (scripted = the test provider, not an AI model)' : ''}`);

  const { project } = await alice.post(`${R}/projects`, { name: 'Task app', goal: 'Build a simple working task management web application.', managerAgentId: pm.id });
  const P = `${R}/projects/${project.id}`;
  for (const a of [fe, ds]) await alice.post(`${P}/grants`, { agentId: a.id, budgetUsd: 5, requiresApproval: false });
  await bob.post(`${P}/join`);
  for (const a of [be, qa, sec]) await bob.post(`${P}/grants`, { agentId: a.id, budgetUsd: 5, requiresApproval: true });
  await alice.post(`${P}/start`);
  say('Project “Task app” started — Paige is planning.');
  say(`Watch it: run npm run app and choose Alice or Bob, then enter office ${room.code}`);
  if (MANUAL) say('Manual mode: approve the plan as Alice, and the assignments for Bob’s agents as Bob, in Dashboard → Approvals.');

  const decided = new Set();
  let finished = false;
  const loop = setInterval(async () => {
    try {
      for (const [p, who] of [[alice, 'Alice'], [bob, 'Bob']]) {
        const s = await p.get(`${R}/state`);
        if (!MANUAL) {
          for (const a of s.approvals.filter((x) => x.status === 'pending' && x.approverId === s.me.id && !decided.has(x.id))) {
            decided.add(a.id);
            await p.post(`${R}/approvals/${a.id}`, { decision: 'approved', note: 'Approved by the demo script' });
            say(`${who} approved: ${a.kind}${a.detail?.title ? ` “${a.detail.title}”` : ''}`);
          }
        }
        const pr = s.projects.find((x) => x.id === project.id);
        if (pr?.status === 'completed' && !finished) {
          finished = true;
          say(`Project complete: ${pr.progress.done}/${pr.progress.total} tasks. Files and SUMMARY.md are in Dashboard → Deliverables.`);
          console.log(`\n${pr.summary}\n`);
          say('Leaving the workers running so the team stays on the floor. Ctrl-C to end.');
        }
      }
    } catch (err) { say(`(status check failed: ${err.message})`); }
  }, 1500);

  process.on('SIGINT', () => { clearInterval(loop); for (const w of workers) w.stop(); alice.leaveAll(); bob.leaveAll(); process.exit(0); });
}

main().catch((err) => { console.error(`[demo] ${err.message}`); process.exit(1); });
