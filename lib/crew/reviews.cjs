// Merge requests and pull-request-style AI review, on top of the host's Git (git.cjs).
//
//   author agent: repo_sync (tests → commit → push its branch) → request_merge
//   host: checks the Definition of Done for the task (tests passed in the pushed commit,
//         progress report if the rules ask for one), then picks an independent reviewer —
//         a different agent, preferably another player's — and gives it a review task
//   reviewer: reads the real diff → review_decision(approve | request_changes, comments)
//   changes requested → the author's task is reopened with the comments (rework)
//   approved → the approval policy decides whether a human must approve the merge
//   merge → host merges into protected main; a conflict stops it and goes back to the author
//
// The author's task is completed only by a successful merge. No agent can mark its own
// work done in a Git project.

'use strict';

const { newId, now, json, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');
const { slug } = require('./git.cjs');

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS merge_requests (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL, repo_id TEXT NOT NULL, task_id TEXT,
    branch TEXT NOT NULL, head TEXT NOT NULL, author_agent_id TEXT NOT NULL, reviewer_agent_id TEXT, review_task_id TEXT,
    status TEXT NOT NULL, summary TEXT NOT NULL, tests TEXT, merge_commit TEXT, rounds INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY, mr_id TEXT NOT NULL, round INTEGER NOT NULL, author_type TEXT NOT NULL, author_id TEXT NOT NULL,
    verdict TEXT, file TEXT, line INTEGER, body TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

const MAX_ROUNDS = 4;

function createReviews(crew) {
  const { db } = crew;
  db.raw.exec(MIGRATION);
  // Columns added to tasks by this module, if an older database lacks them.
  const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
  if (!cols.includes('mr_id')) db.raw.exec('ALTER TABLE tasks ADD COLUMN mr_id TEXT');
  if (!cols.includes('budget_pct')) db.raw.exec('ALTER TABLE tasks ADD COLUMN budget_pct REAL');
  if (!cols.includes('paused_reason')) db.raw.exec('ALTER TABLE tasks ADD COLUMN paused_reason TEXT');

  const get = (id) => db.get('SELECT * FROM merge_requests WHERE id = ?', id);
  const comments = (mrId) => db.all('SELECT * FROM review_comments WHERE mr_id = ? ORDER BY created_at', mrId).map((c) => ({
    id: c.id, round: c.round, authorType: c.author_type, authorName: c.author_type === 'agent' ? crew.agents.get(c.author_id)?.name : crew.auth.getUser(c.author_id)?.displayName,
    verdict: c.verdict, file: c.file, line: c.line, body: c.body, createdAt: c.created_at,
  }));

  function shape(m) {
    if (!m) return null;
    const repo = crew.git.get(m.repo_id);
    return {
      id: m.id, projectId: m.project_id, repoId: m.repo_id, repoName: repo?.name, taskId: m.task_id, branch: m.branch, head: m.head,
      authorAgentId: m.author_agent_id, authorName: crew.agents.get(m.author_agent_id)?.name, reviewerAgentId: m.reviewer_agent_id,
      reviewerName: m.reviewer_agent_id ? crew.agents.get(m.reviewer_agent_id)?.name : null, status: m.status, summary: m.summary, tests: m.tests,
      mergeCommit: m.merge_commit, rounds: m.rounds, comments: comments(m.id), createdAt: m.created_at, updatedAt: m.updated_at,
    };
  }

  function update(id, patch) {
    const keys = Object.keys(patch);
    db.run(`UPDATE merge_requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k]), now(), id);
    const m = get(id);
    crew.hub.broadcast(m.room_id, 'merge', shape(m));
    return m;
  }

  const branchFor = (agent, task) => `agent/${slug(agent.name)}/${task ? task.id.slice(-8).toLowerCase() : 'work'}`;

  /** Called by the request_merge tool: the author asks for its pushed branch to be merged. */
  function request({ job, agent, task, project }, { repo: repoRef, branch, summary }) {
    if (!task || task.kind === 'review') throw httpError(400, 'request_merge is for the task you are working on.');
    const repo = crew.git.byName(project.id, repoRef ?? crew.git.forProject(project.id)[0]?.name);
    if (!repo) throw httpError(404, `No repository ${repoRef} in this project.`);
    const br = branch || branchFor(agent, task);
    if (!br.startsWith(`agent/${slug(agent.name)}/`)) throw httpError(403, 'You can only request merges of your own branches.');
    const head = crew.git.branchHead(repo, br);
    if (!head) throw httpError(400, `The host has no branch ${br}. Push it first with repo_sync.`);
    const info = crew.git.branches(repo).find((b) => b.name === br);
    if (!info?.ahead) throw httpError(400, `${br} has nothing that main does not already have.`);
    const text = String(summary ?? '').trim();
    if (text.length < 20) throw httpError(400, 'Describe the change for the reviewer (a couple of sentences).');

    // Definition of Done checks that can be verified from the pushed commit itself.
    const eff = crew.policies.effective(project.room_id, { projectId: project.id, agentId: agent.id, taskId: task.id });
    const top = crew.git.log(repo, head, 1)[0];
    const tests = top?.trailers?.['Crew-Tests'] ?? 'none';
    if (eff.testsBeforeDone.value && tests !== 'passed') throw httpError(400, `The rules require passing tests before review, and the head commit ${head.slice(0, 8)} records tests: ${tests}. Run repo_sync in smart mode (it runs the tests) and try again.`);
    if (eff.progressReports.value) {
      const report = crew.git.readFile(repo, head, `docs/progress/${agent.id}.md`);
      if (!report || !report.includes(task.id)) throw httpError(400, `Progress reports are on: docs/progress/${agent.id}.md must exist on your branch and mention task ${task.id}.`);
    }

    const open = db.get("SELECT * FROM merge_requests WHERE repo_id = ? AND branch = ? AND status IN ('open','changes_requested','approved','conflict','needs_reviewer','awaiting_merge_approval')", repo.id, br);
    let mr;
    if (open) mr = update(open.id, { head, summary: text, tests, status: 'open', rounds: open.rounds + 1 });
    else {
      const id = newId('mr');
      db.run('INSERT INTO merge_requests (id, room_id, project_id, repo_id, task_id, branch, head, author_agent_id, status, summary, tests, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, project.room_id, project.id, repo.id, task.id, br, head, agent.id, 'open', text, tests, now(), now());
      mr = get(id);
      crew.hub.broadcast(mr.room_id, 'merge', shape(mr));
    }
    if (mr.rounds >= MAX_ROUNDS) {
      update(mr.id, { status: 'needs_human' });
      crew.work.notify(project.room_id, project.created_by, `Merge request for “${task.title}” went ${MAX_ROUNDS} review rounds without agreement. A human needs to decide.`, 'warn', `mr:${mr.id}`);
      return { mergeRequest: mr.id, status: 'needs_human' };
    }
    db.run('UPDATE tasks SET mr_id = ? WHERE id = ?', mr.id, task.id);
    crew.work.setTask(task.id, { status: 'review', result_summary: text });
    if (eff.requireReview.value) return { mergeRequest: mr.id, status: assignReviewer(mr, project, agent) };
    return { mergeRequest: mr.id, status: proceedToMerge(get(mr.id), 'no review required by the rules') };
  }

  /** An independent reviewer: not the author; prefers review-ish roles and another owner. */
  function pickReviewer(project, author) {
    const candidates = db.all('SELECT agent_id FROM project_grants WHERE project_id = ?', project.id).map((g) => crew.agents.get(g.agent_id))
      .filter((a) => a && a.id !== author.id && parse(a.tools, []).includes('git'));
    let best = null;
    for (const a of candidates) {
      const hay = `${a.role} ${parse(a.skills, []).join(' ')}`.toLowerCase();
      let score = /review|qa|security|test/.test(hay) ? 4 : 0;
      if (a.owner_id !== author.owner_id) score += 2;
      if (crew.agents.available(a)) score += 1;
      if (a.id === project.manager_agent_id) score -= 3;
      if (!best || score > best.score) best = { a, score };
    }
    return best?.a ?? null;
  }

  function assignReviewer(mr, project, author) {
    const reviewer = mr.reviewer_agent_id ? crew.agents.get(mr.reviewer_agent_id) : pickReviewer(project, author);
    if (!reviewer) {
      update(mr.id, { status: 'needs_reviewer' });
      crew.work.notify(project.room_id, project.created_by, `No independent reviewer with Git access is on “${project.name}”. Lend a reviewer agent to the project.`, 'warn', `mr:${mr.id}`);
      return 'needs_reviewer';
    }
    const p = crew.work.getProject(project.id);
    const author_ = crew.agents.get(mr.author_agent_id);
    const t = crew.work.createTask(p, {
      kind: 'review', title: `Review ${author_.name}'s ${mr.branch}`, parentId: mr.task_id, by: { type: 'agent', id: mr.author_agent_id },
      description: `Review merge request ${mr.id} in repository ${crew.git.get(mr.repo_id).name}: branch ${mr.branch} at ${mr.head.slice(0, 10)}.\nAuthor's summary: ${mr.summary}\nRead the diff, then call review_decision with approve or request_changes and precise comments (file + line).`,
    });
    db.run('UPDATE tasks SET mr_id = ? WHERE id = ?', mr.id, t.id);
    crew.work.assign(t.id, reviewer.id, { by: { type: 'agent', id: mr.author_agent_id } });
    update(mr.id, { reviewer_agent_id: reviewer.id, review_task_id: t.id, status: 'open' });
    crew.bus.post({ roomId: mr.room_id, channelId: p.channel_id, senderType: 'agent', senderId: mr.author_agent_id, toAgentId: reviewer.id, kind: 'review_request',
      body: `Please review ${mr.branch}: ${mr.summary}`, taskId: t.id });
    return 'in_review';
  }

  /** The reviewer's verdict. Independence is checked here, not trusted from the prompt. */
  function decide({ job, agent, task }, { verdict, comments = [], summary }) {
    const mr = task?.mr_id ? get(task.mr_id) : null;
    if (!mr || task.kind !== 'review') throw httpError(400, 'review_decision belongs to a review task.');
    if (mr.author_agent_id === agent.id) throw httpError(403, 'An author cannot review its own work.');
    if (mr.reviewer_agent_id !== agent.id) throw httpError(403, 'You are not the assigned reviewer.');
    if (!['approve', 'request_changes'].includes(verdict)) throw httpError(400, 'verdict is approve or request_changes.');
    const text = String(summary ?? '').trim();
    if (text.length < 10) throw httpError(400, 'Summarise your review.');
    const round = mr.rounds;
    db.run('INSERT INTO review_comments (id, mr_id, round, author_type, author_id, verdict, body, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('rvc'), mr.id, round, 'agent', agent.id, verdict, text, now());
    for (const c of (Array.isArray(comments) ? comments : []).slice(0, 50)) {
      db.run('INSERT INTO review_comments (id, mr_id, round, author_type, author_id, file, line, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        newId('rvc'), mr.id, round, 'agent', agent.id, String(c.file ?? '').slice(0, 200) || null, Number.isFinite(Number(c.line)) ? Number(c.line) : null, String(c.body ?? '').slice(0, 2000), now());
    }
    const p = crew.work.getProject(mr.project_id);
    const report = [`# Review of ${mr.branch} (round ${round + 1})`, '', `Reviewer: ${agent.name} · verdict: **${verdict.replace('_', ' ')}**`, '', text, '',
      ...comments.map((c) => `- \`${c.file ?? ''}${c.line ? `:${c.line}` : ''}\` — ${c.body}`)].join('\n');
    crew.work.writeFile(p, agent, task, `reviews/${mr.id}-round${round + 1}.md`, report, 'review');
    crew.work.setTask(task.id, { status: 'completed', result_summary: `${verdict === 'approve' ? 'Approved' : 'Changes requested'}: ${text}`.slice(0, 4000) });
    crew.bus.post({ roomId: mr.room_id, channelId: p.channel_id, senderType: 'agent', senderId: agent.id, toAgentId: mr.author_agent_id, kind: verdict === 'approve' ? 'chat' : 'review_request',
      body: `${verdict === 'approve' ? 'Approved' : 'Changes requested on'} ${mr.branch}: ${text}${comments.length ? `\n${comments.map((c) => `• ${c.file ?? ''}${c.line ? `:${c.line}` : ''} ${c.body}`).join('\n')}` : ''}`, taskId: mr.task_id });

    if (verdict === 'request_changes') {
      update(mr.id, { status: 'changes_requested' });
      reopen(mr, `Your reviewer ${agent.name} requested changes (round ${round + 1}):\n${text}\n${comments.map((c) => `- ${c.file ?? ''}${c.line ? `:${c.line}` : ''}: ${c.body}`).join('\n')}\nFix these on the same branch, run repo_sync, then request_merge again.`);
      return { recorded: true, status: 'changes_requested' };
    }
    update(mr.id, { status: 'approved' });
    return { recorded: true, status: proceedToMerge(get(mr.id), `approved by ${agent.name}`) };
  }

  /** Reopen the author's task for rework without counting it as a failure. */
  function reopen(mr, feedback) {
    const t = crew.work.getTask(mr.task_id);
    if (!t) return;
    db.run('UPDATE tasks SET max_attempts = max_attempts + 1 WHERE id = ?', t.id);
    crew.work.setTask(t.id, { status: 'pending', result_summary: feedback.slice(0, 4000) });
    crew.work.kick();
  }

  /** Approved (or no review required): the policy decides whether a human signs off the merge. */
  function proceedToMerge(mr, why) {
    const p = crew.work.getProject(mr.project_id);
    const eff = crew.policies.effective(mr.room_id, { projectId: p.id, agentId: mr.author_agent_id, taskId: mr.task_id });
    const reason = crew.policies.needsApproval('merge_main', eff);
    if (reason) {
      update(mr.id, { status: 'awaiting_merge_approval' });
      const repo = crew.git.get(mr.repo_id);
      crew.work.requestApproval({ roomId: mr.room_id, kind: 'merge', taskId: mr.task_id, agentId: mr.author_agent_id, approverId: p.created_by,
        detail: { mrId: mr.id, repo: repo.name, branch: mr.branch, summary: mr.summary, tests: mr.tests, why, reason, project: p.name, agentName: crew.agents.get(mr.author_agent_id)?.name, title: `Merge ${mr.branch}` } });
      return 'awaiting_merge_approval';
    }
    return doMerge(mr, { agentId: null, userId: null }, `${why}; merged under ${eff.approvalMode.value} approval mode`);
  }

  function onMergeDecision(approval, approved, userId) {
    const mr = get(parse(approval.detail, {}).mrId);
    if (!mr || mr.status !== 'awaiting_merge_approval') return;
    if (!approved) {
      update(mr.id, { status: 'changes_requested' });
      reopen(mr, 'A human declined the merge. Read the project channel for why, adjust the branch, and request_merge again.');
      return;
    }
    doMerge(mr, { userId }, `merge approved by ${crew.auth.getUser(userId)?.displayName}`);
  }

  function doMerge(mr, by, why) {
    const repo = crew.git.get(mr.repo_id);
    let r = crew.git.merge(repo, mr.branch, { by, message: `Merge ${mr.branch} (${mr.id})\n\n${mr.summary}\n\nCrew-Task: ${mr.task_id}\nCrew-Review: ${why}`, taskId: mr.task_id });
    if (r.retry) r = crew.git.merge(repo, mr.branch, { by, message: `Merge ${mr.branch} (${mr.id})`, taskId: mr.task_id });
    if (r.conflict) {
      update(mr.id, { status: 'conflict' });
      reopen(mr, `Merging ${mr.branch} into main conflicts in: ${r.files.join(', ') || 'some files'}. Run repo_fetch and repo_merge_main to bring main into your branch, resolve the conflicts, run repo_sync, then request_merge again. Nothing was overwritten.`);
      return 'conflict';
    }
    if (!r.merged) return 'retry_later';
    update(mr.id, { status: 'merged', merge_commit: r.commit });
    const t = crew.work.getTask(mr.task_id);
    if (t) crew.work.setTask(t.id, { status: 'completed', result_summary: `${mr.summary}\n\nMerged into ${repo.name}/main as ${r.commit.slice(0, 10)} (${why}).` });
    crew.work.kick();
    return 'merged';
  }

  const forProject = (projectId) => db.all('SELECT * FROM merge_requests WHERE project_id = ? ORDER BY updated_at DESC', projectId).map(shape);

  /** What a reviewer's job is given: the diff itself, from the host's copy of the branch. */
  function contextFor(task) {
    if (!task?.mr_id) return null;
    const mr = get(task.mr_id);
    const repo = crew.git.get(mr.repo_id);
    const d = crew.git.diff(repo, mr.branch, { maxBytes: 120_000 });
    return { id: mr.id, repo: repo.name, branch: mr.branch, head: mr.head, summary: mr.summary, tests: mr.tests, author: crew.agents.get(mr.author_agent_id)?.name, stat: d.stat, patch: d.patch, previous: comments(mr.id).slice(-20) };
  }

  /** Feedback for an author whose branch came back. */
  function feedbackFor(task) {
    if (!task?.mr_id || task.kind === 'review') return null;
    const mr = get(task.mr_id);
    return mr ? { mergeRequest: mr.id, status: mr.status, branch: mr.branch, comments: comments(mr.id).slice(-20) } : null;
  }

  return { request, decide, onMergeDecision, forProject, get, shape, contextFor, feedbackFor, branchFor };
}

module.exports = { createReviews };
