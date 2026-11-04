#!/usr/bin/env node
// The software-bot demo: three players, five agents, one Git repository, on the host's own
// Git. Each agent works on its owner's worker in its own clone. Smart Sync on, progress
// reports on, a 25% estimated task budget, paid API off (the default).
//
//   npm run host            # in one terminal
//   npm run demo:bot        # in another (scripted provider: no AI, no key, no cost)
//
// Real models instead, each player's own connection on their own worker:
//   npm run demo:bot -- --provider codex-cli
// Then sign in at the printed address and open Dashboard → Git / Sync.

'use strict';

const { player, startWorker } = require('../lib/crew/demo-kit.cjs');
const { flags } = require('./lib/cli-flags.cjs');

const { flag, value } = flags(process.argv.slice(2));
const HOST = value('--host', process.env.CREW_HOST || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const PROVIDER = value('--provider', 'scripted');
const MODEL = value('--model', PROVIDER === 'scripted' ? 'scripted' : 'default');
const MANUAL = flag('--manual');
if (PROVIDER === 'scripted' && !process.env.CREW_SCRIPTED_DELAY_MS) process.env.CREW_SCRIPTED_DELAY_MS = value('--pace', '1500');

const PLAYERS = {
  ana: { displayName: 'Ana', password: 'demo-ana-pass', color: '#e07a5f' },
  ben: { displayName: 'Ben', password: 'demo-ben-pass', color: '#3d85c6' },
  cleo: { displayName: 'Cleo', password: 'demo-cleo-pass', color: '#81b29a' },
};
const GIT_TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'git'];
const say = (s) => console.log(`[demo] ${s}`);

/** The settings this demo applies; see docs/developer/upgrade-report.md. */
const PROJECT_RULES = { approvalMode: 'balanced', syncMode: 'smart', testsBeforeDone: true, requireReview: true, progressReports: true, handoffNotes: true, updateReadme: false };
const TASK_BUDGET_PCT = 25;

async function main() {
  try { await fetch(`${HOST}/api/crew/host-info`); } catch { throw new Error(`No host at ${HOST}. Start one with: npm run host`); }
  const people = {};
  for (const [username, p] of Object.entries(PLAYERS)) {
    people[username] = player(HOST);
    const r = await people[username].post('/api/crew/register', { username, password: p.password, displayName: p.displayName, color: p.color });
    if (r.status === 409) await people[username].post('/api/crew/login', { username, password: p.password });
  }
  const { ana, ben, cleo } = people;
  const { room } = await ana.post('/api/crew/rooms', { name: 'Bot workshop', privacy: 'password', password: 'demo-room', maxPlayers: 6 });
  for (const p of [ben, cleo]) await p.post('/api/crew/rooms/join', { code: room.code, password: 'demo-room' });
  const R = `/api/crew/rooms/${room.id}`;
  for (const p of [ana, ben, cleo]) await p.enter(room.id);
  say(`Ana hosted “${room.name}” (code ${room.code}, password demo-room). Ben and Cleo joined.`);

  const mk = async (p, name, role, skills, extra = {}) => {
    const r = await p.post(`${R}/agents`, { name, role, skills, provider: PROVIDER, model: MODEL, tools: GIT_TOOLS, budgetUsd: 20, ...extra });
    if (r.status !== 200) throw new Error(r.error);
    return r.agent;
  };
  const pm = await mk(ana, 'Paige', 'Project Manager', ['planning'], { isManager: true });
  const coder = await mk(ana, 'Rita', 'Code Reviewer', ['review']);
  const scripter = await mk(ben, 'Boris', 'Python Scripter', ['scripting', 'automation']);
  const qa = await mk(ben, 'Quinn', 'QA Engineer', ['testing']);
  const dev = await mk(cleo, 'Dev', 'Developer', ['javascript']);
  say('Five agents: Paige and Rita (Ana), Boris and Quinn (Ben), Dev (Cleo).');

  const workers = [];
  for (const [name, p] of Object.entries(people)) {
    const { worker } = await p.post(`${R}/workers`, { name: `${PLAYERS[name].displayName}’s computer` });
    workers.push(startWorker({ hostUrl: HOST, token: worker.token, log: (s) => console.log(`  ${s}`) }));
  }

  const { project } = await ana.post(`${R}/projects`, { name: 'Greeting bot', goal: 'Build a small greeting bot module, with tests, reviewed and merged.', managerAgentId: pm.id });
  const P = `${R}/projects/${project.id}`;
  await ana.post(`${P}/grants`, { agentId: pm.id, budgetUsd: 5, requiresApproval: false, tools: GIT_TOOLS });
  await ana.post(`${P}/grants`, { agentId: coder.id, budgetUsd: 5, requiresApproval: false, tools: GIT_TOOLS });
  await ben.post(`${P}/join`);
  await cleo.post(`${P}/join`);
  await ben.post(`${P}/grants`, { agentId: scripter.id, budgetUsd: 5, requiresApproval: true, tools: GIT_TOOLS });
  await ben.post(`${P}/grants`, { agentId: qa.id, budgetUsd: 5, requiresApproval: true, tools: GIT_TOOLS });
  await cleo.post(`${P}/grants`, { agentId: dev.id, budgetUsd: 5, requiresApproval: true, tools: GIT_TOOLS });
  const repo = await ana.post(`${P}/repos`, { name: 'bot' });
  if (repo.status !== 200) throw new Error(repo.error);
  await ana.req('PUT', `${R}/rules/project/${project.id}`, { rules: PROJECT_RULES });
  await ana.post(`${P}/start`);
  say('Project started: Smart Sync, progress reports on, review required, Balanced approvals, paid API off.');
  say(`Watch it: ${HOST}/office/${room.code}  (sign in as ana / ${PLAYERS.ana.password})  then Dashboard → Git / Sync`);
  if (MANUAL) say('Manual mode: approve in Dashboard → Approvals as each player.');

  const decided = new Set();
  const budgeted = new Set();
  let finished = false;
  const loop = setInterval(async () => {
    try {
      for (const [name, p] of Object.entries(people)) {
        const s = await p.get(`${R}/state`);
        if (!MANUAL) {
          for (const a of s.approvals.filter((x) => x.status === 'pending' && x.approverId === s.me.id && !decided.has(x.id))) {
            decided.add(a.id);
            await p.post(`${R}/approvals/${a.id}`, { decision: 'approved', note: 'Approved by the demo script' });
            say(`${PLAYERS[name].displayName} approved: ${a.kind}${a.detail?.title ? ` “${a.detail.title}”` : ''}`);
          }
        }
        if (name === 'ana') {
          for (const t of s.tasks.filter((x) => x.kind === 'work' && !budgeted.has(x.id))) {
            budgeted.add(t.id);
            await p.post(`${R}/tasks/${t.id}/budget`, { pct: TASK_BUDGET_PCT });
          }
          const pr = s.projects.find((x) => x.id === project.id);
          if (pr?.status === 'completed' && !finished) {
            finished = true;
            const g = await p.get(`${P}/git`);
            say(`Project complete. Merged: ${g.merges.filter((m) => m.status === 'merged').map((m) => m.branch).join(', ')}`);
            console.log(`\n${pr.summary}\n`);
            say(`Clone it: git clone ${HOST}${g.repos[0].url}  (Git / Sync → Get a Git password). Ctrl-C to end.`);
          }
        }
      }
    } catch (err) { say(`(status check failed: ${err.message})`); }
  }, 1500);

  process.on('SIGINT', () => { clearInterval(loop); for (const w of workers) w.stop(); for (const p of Object.values(people)) p.leaveAll(); process.exit(0); });
}

main().catch((err) => { console.error(`[demo] ${err.message}`); process.exit(1); });
