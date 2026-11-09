// The manual route for Claude plans. Anthropic does not permit third-party apps to route
// requests through Claude plan credentials on behalf of their users, but an end user may use
// their own unmodified Claude Code with their own subscription. So this app does not call it:
// it prepares the task — the agent's Git clone and a HANDOFF.md with the full brief — and the
// job waits. The owner opens the folder in their own Claude Code, does the work however
// they like, writes RESULT.md and presses Done on the worker page. Then the app tests,
// commits, pushes and requests the merge exactly as for any other agent.

'use strict';

const fs = require('fs');
const path = require('path');

const { projectFolder, taskFolderName } = require('./project-folders.cjs');

// Every hand-off is listed in the worker's own folder, which is what the worker page reads. Its
// brief and results go in the project's folder, where the work is, or here when there is none.
const folderFor = (dataDir, jobId) => path.join(dataDir, 'handoffs', jobId.replace(/[^\w-]/g, ''));
const metaOf = (dataDir, jobId) => {
  try { return JSON.parse(fs.readFileSync(path.join(folderFor(dataDir, jobId), 'handoff.json'), 'utf8')); } catch { return null; }
};
/** Where this job's brief and results are: as recorded when it was prepared. */
const workFolderOf = (dataDir, jobId) => metaOf(dataDir, jobId)?.folder ?? folderFor(dataDir, jobId);

/** Takes a hand-off off the worker page, for one whose office or task is gone. Its files stay. */
function removeHandoff(dataDir, jobId) {
  const metaFile = path.join(folderFor(dataDir, jobId), 'handoff.json');
  const meta = metaOf(dataDir, jobId);
  if (!meta) return false;
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, done: true, removedAt: Date.now() }));
  return true;
}

function pendingHandoffs(dataDir) {
  const root = path.join(dataDir, 'handoffs');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, d, 'handoff.json'), 'utf8'));
      if (!meta.done) out.push(meta);
    } catch { /* not a handoff */ }
  }
  return out;
}

async function prepareHandoff({ ctx, localTools, dataDir, finish, systemPrompt, taskPrompt, log }) {
  const listed = folderFor(dataDir, ctx.job.id);
  fs.mkdirSync(listed, { recursive: true });
  let project = null;
  try { project = projectFolder(ctx, localTools?.projectsDir ?? path.join(dataDir, 'Projects')); } catch (err) { log(`${ctx.agent.name}: no project folder (${err.message}); using ${listed}`); }
  const folder = project ? path.join(project, 'handoffs', taskFolderName(ctx.task?.title ?? 'Task', ctx.job.id)) : listed;
  fs.mkdirSync(folder, { recursive: true });
  let workDir = folder;
  let branch = null;
  if (ctx.project?.repos?.length && localTools.ensure) {
    const e = await localTools.ensure(ctx);
    workDir = e.dir;
    branch = e.branch;
  }
  const isReview = ctx.task.kind === 'review';
  const isPlan = ctx.task.kind === 'plan';
  const brief = [
    `# Task for ${ctx.agent.name}, to run in your own Claude Code`, '',
    `Work in: ${workDir}`, branch ? `Branch: ${branch} (already checked out)` : null, '',
    '## How to do this', '',
    `1. Open a terminal in that folder and start Claude Code (\`claude\`), signed in with your own account.`,
    '2. Give it this file as the brief, or paste the sections below.',
    isPlan ? `3. When done, save the plan as JSON in ${path.join(folder, 'PLAN.json')}: {"tasks":[{"key","title","description","role","assignee","depends_on":[],"deliverables":[]}]}.`
      : isReview ? `3. When done, write ${path.join(folder, 'RESULT.md')}. Its first line must be \`VERDICT: approve\` or \`VERDICT: request_changes\`; the rest is your review with file and line references.`
        : `3. When done, write ${path.join(folder, 'RESULT.md')}: what changed, how it was tested, anything left open. Leave the changes uncommitted, or commit them; the app handles either.`,
    '4. Press **Done** for this task on your worker page. The app then tests, commits, pushes and requests the review.', '',
    '## Role and rules', '', systemPrompt(ctx), '', '## The task', '', taskPrompt(ctx), '',
  ].filter((l) => l !== null).join('\n');
  fs.writeFileSync(path.join(folder, 'HANDOFF.md'), brief);
  fs.writeFileSync(path.join(listed, 'handoff.json'), JSON.stringify({ jobId: ctx.job.id, agent: ctx.agent.name, title: ctx.task.title, office: ctx.room?.name ?? null, project: ctx.project?.name ?? null, folder, workDir, branch, kind: ctx.task.kind, createdAt: Date.now(), done: false }));
  log(`${ctx.agent.name}: handoff ready in ${folder}`);
  return finish('waiting', { pause: { kind: 'handoff', reason: 'Waiting for its owner to run this in Claude Code (manual handoff). See the worker page.', resumeAfter: null } }, 'manual handoff');
}

/**
 * What a run in Claude Code produced, turned into the ordinary tool calls: PLAN.json for a plan,
 * RESULT.md with VERDICT for a review, and RESULT.md otherwise, published through the repository
 * when the project has one. Shared by the manual handoff and an autonomous run (native.cjs).
 * Returns null when it is done, or why it is not.
 *
 * @param {{again: string, by: string, artifacts?: string[]}} words  how to ask for another try,
 *   who did the work, for the merge request, and the files it produced, as evidence
 */
async function importResult({ ctx, host, localTools, folder }, { again, by, artifacts = [] }) {
  const tool = async (name, args) => {
    const r = await host.post('/api/crew/worker/tool', { jobId: ctx.job.id, name, args });
    if (!r.ok) throw new Error(r.error ?? `${name} failed`);
    return r.result;
  };
  if (ctx.task.kind === 'plan') {
    const planFile = path.join(folder, 'PLAN.json');
    if (!fs.existsSync(planFile)) return `PLAN.json was not found. ${again}`;
    await tool('submit_plan', JSON.parse(fs.readFileSync(planFile, 'utf8')));
    return null;
  }
  const resultFile = path.join(folder, 'RESULT.md');
  if (!fs.existsSync(resultFile)) return `RESULT.md was not found. ${again}`;
  const result = fs.readFileSync(resultFile, 'utf8').trim();
  if (ctx.task.kind === 'review' && ctx.task.mergeRequest) {
    const m = result.match(/^VERDICT:\s*(approve|request_changes)\s*\n?([\s\S]*)$/i);
    if (!m) return `The first line of RESULT.md must be VERDICT: approve or VERDICT: request_changes. ${again}`;
    await tool('review_decision', { verdict: m[1].toLowerCase(), summary: m[2].trim() || `Reviewed in Claude Code (${by}).`, comments: [] });
    return null;
  }
  if (ctx.project?.repos?.length && ctx.tools.includes('repo_sync')) {
    const message = result.split('\n')[0].slice(0, 120) || ctx.task.title;
    const auth = await host.post('/api/crew/worker/authorize', { jobId: ctx.job.id, name: 'repo_sync', summary: `sync repository: ${message.slice(0, 100)}` });
    if (!auth.allowed) return auth.waiting ? `Publishing needs approval first; see Approvals. ${again}` : 'Publishing was not approved.';
    const sync = await localTools.repo_sync(ctx, { message, final: true });
    await host.post('/api/crew/worker/local-done', { jobId: ctx.job.id, name: 'repo_sync', status: sync.synced ? 'ok' : 'error' }).catch(() => {});
    if (!sync.synced) return `Not published yet: ${sync.note ?? sync.pushError ?? 'tests failed'}\n${sync.output ?? ''}`.slice(0, 480);
    await tool('request_merge', { summary: `${result}\n\n(${by}.)` });
    return null;
  }
  await tool('complete_task', { summary: result, artifacts });
  return null;
}

/** The owner pressed Done: turn what they produced into the ordinary tool calls. */
async function finishHandoff({ ctx, host, localTools, dataDir, finish, log }) {
  const folder = workFolderOf(dataDir, ctx.job.id);
  const metaFile = path.join(folderFor(dataDir, ctx.job.id), 'handoff.json');
  const park = (reason) => finish('waiting', { pause: { kind: 'handoff', reason, resumeAfter: null } }, reason);
  try {
    const why = await importResult({ ctx, host, localTools, folder }, { again: 'Fix it and press Done again.', by: 'Done by hand in Claude Code by this agent\'s owner' });
    if (why) return park(why);
    fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), done: true }));
    log(`${ctx.agent.name}: handoff imported`);
    return finish('done', { text: 'Handoff imported.', summary: 'Handoff imported.' });
  } catch (err) {
    return park(`Could not import: ${err.message}`);
  }
}

module.exports = { prepareHandoff, finishHandoff, importResult, pendingHandoffs, removeHandoff };
