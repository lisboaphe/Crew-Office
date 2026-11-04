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

const folderFor = (dataDir, jobId) => path.join(dataDir, 'handoffs', jobId.replace(/[^\w-]/g, ''));

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
  const folder = folderFor(dataDir, ctx.job.id);
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
  fs.writeFileSync(path.join(folder, 'handoff.json'), JSON.stringify({ jobId: ctx.job.id, agent: ctx.agent.name, title: ctx.task.title, folder, workDir, branch, kind: ctx.task.kind, createdAt: Date.now(), done: false }));
  log(`${ctx.agent.name}: handoff ready in ${folder}`);
  return finish('waiting', { pause: { kind: 'handoff', reason: 'Waiting for its owner to run this in Claude Code (manual handoff). See the worker page.', resumeAfter: null } }, 'manual handoff');
}

/** The owner pressed Done: turn what they produced into the ordinary tool calls. */
async function finishHandoff({ ctx, host, localTools, dataDir, finish, log }) {
  const folder = folderFor(dataDir, ctx.job.id);
  const metaFile = path.join(folder, 'handoff.json');
  const tool = async (name, args) => {
    const r = await host.post('/api/crew/worker/tool', { jobId: ctx.job.id, name, args });
    if (!r.ok) throw new Error(r.error ?? `${name} failed`);
    return r.result;
  };
  const park = (reason) => finish('waiting', { pause: { kind: 'handoff', reason, resumeAfter: null } }, reason);
  try {
    if (ctx.task.kind === 'plan') {
      const planFile = path.join(folder, 'PLAN.json');
      if (!fs.existsSync(planFile)) return park('PLAN.json was not found. Save it and press Done again.');
      await tool('submit_plan', JSON.parse(fs.readFileSync(planFile, 'utf8')));
    } else {
      const resultFile = path.join(folder, 'RESULT.md');
      if (!fs.existsSync(resultFile)) return park('RESULT.md was not found. Write it and press Done again.');
      const result = fs.readFileSync(resultFile, 'utf8').trim();
      if (ctx.task.kind === 'review' && ctx.task.mergeRequest) {
        const m = result.match(/^VERDICT:\s*(approve|request_changes)\s*\n?([\s\S]*)$/i);
        if (!m) return park('The first line of RESULT.md must be VERDICT: approve or VERDICT: request_changes.');
        await tool('review_decision', { verdict: m[1].toLowerCase(), summary: m[2].trim() || 'Reviewed by hand in Claude Code.', comments: [] });
      } else if (ctx.project?.repos?.length && ctx.tools.includes('repo_sync')) {
        const message = result.split('\n')[0].slice(0, 120) || ctx.task.title;
        const auth = await host.post('/api/crew/worker/authorize', { jobId: ctx.job.id, name: 'repo_sync', summary: `sync repository: ${message.slice(0, 100)}` });
        if (!auth.allowed) return park(auth.waiting ? 'Publishing needs approval first; see Approvals, then press Done again.' : 'Publishing was not approved.');
        const sync = await localTools.repo_sync(ctx, { message, final: true });
        await host.post('/api/crew/worker/local-done', { jobId: ctx.job.id, name: 'repo_sync', status: sync.synced ? 'ok' : 'error' }).catch(() => {});
        if (!sync.synced) return park(`Not published yet: ${sync.note ?? sync.pushError ?? 'tests failed'}\n${sync.output ?? ''}`.slice(0, 480));
        await tool('request_merge', { summary: `${result}\n\n(Done by hand in Claude Code by this agent's owner.)` });
      } else {
        await tool('complete_task', { summary: result, artifacts: [] });
      }
    }
    fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), done: true }));
    log(`${ctx.agent.name}: handoff imported`);
    return finish('done', { text: 'Handoff imported.', summary: 'Handoff imported.' });
  } catch (err) {
    return park(`Could not import: ${err.message}`);
  }
}

module.exports = { prepareHandoff, finishHandoff, pendingHandoffs };
