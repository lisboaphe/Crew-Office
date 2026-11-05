// The durable job queue: every unit of agent execution is a row here before it runs.
//
// Jobs are claimed by workers under a lease. A worker that stops heartbeating loses its
// lease and the job goes back to the queue, so neither a closed laptop nor a restarted
// host loses work. `idem_key` makes enqueueing idempotent: asking twice for "run task T,
// attempt 2" yields one job. Results are applied exactly once, by the lease holder.
//
// Types: `task` (a project task), `reply` (answer another agent's question), `chat` (answer
// a human in a direct message).

'use strict';

const { newId, now, json, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');

const LEASE_MS = 90_000;
const TYPE_ORDER = { reply: 0, chat: 1, task: 2 };

function createJobs(crew) {
  const { db } = crew;

  function enqueue({ roomId, agentId, type, refId = null, payload = {}, idemKey = null, maxAttempts = 2, depth = 0 }) {
    if (idemKey) {
      const existing = db.get('SELECT * FROM jobs WHERE idem_key = ?', idemKey);
      if (existing) return existing;
    }
    const id = newId('job');
    db.run(`INSERT INTO jobs (id, room_id, agent_id, type, ref_id, idem_key, status, max_attempts, depth, payload, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, roomId, agentId, type, refId, idemKey, 'queued', maxAttempts, depth, json(payload), now(), now());
    const job = get(id);
    const agent = crew.agents.get(agentId);
    if (agent) crew.workers.notify(roomId, agent.owner_id, 'jobs', { jobId: id });
    crew.hub.broadcast(roomId, 'job', shape(job));
    return job;
  }

  const get = (id) => db.get('SELECT * FROM jobs WHERE id = ?', id);

  function shape(j) {
    return { id: j.id, agentId: j.agent_id, type: j.type, refId: j.ref_id, status: j.status, attempts: j.attempts, maxAttempts: j.max_attempts, error: j.error, createdAt: j.created_at, updatedAt: j.updated_at };
  }

  /** Hand one runnable job for this worker's agents to this worker, under a lease. */
  function claim(worker, { blockedProviders = [] } = {}) {
    // A worker declines providers it cannot use right now (paid API off, budget used up,
    // concurrency reached). Those jobs simply stay queued; nothing is charged or retried.
    if (crew.safety.isStopped(worker.room_id)) return null;
    const blocked = new Set(blockedProviders);
    const agents = crew.agents.ofOwner(worker.room_id, worker.user_id).filter((a) => crew.agents.available(a) && (!blocked.has(a.provider) || crew.profiles.fallbacks(a.id).some((n) => !blocked.has(n))));
    if (!agents.length) return null;
    const ids = agents.map((a) => a.id);
    const marks = ids.map(() => '?').join(',');
    const candidates = db.all(`SELECT * FROM jobs WHERE status = 'queued' AND cancel = 0 AND agent_id IN (${marks}) ORDER BY created_at`, ...ids)
      .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.created_at - b.created_at);
    for (const job of candidates) {
      if (job.type === 'task') {
        const busy = db.get("SELECT 1 FROM jobs WHERE agent_id = ? AND type = 'task' AND status = 'leased'", job.agent_id);
        if (busy) continue;
        const agent = agents.find((a) => a.id === job.agent_id);
        if (agent.spent_usd >= agent.budget_usd) continue;
      }
      const took = db.run(`UPDATE jobs SET status = 'leased', lease_worker = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
                           WHERE id = ? AND status = 'queued'`, worker.id, now() + LEASE_MS, now(), job.id);
      if (took.changes !== 1) continue;
      const leased = get(job.id);
      crew.hub.broadcast(worker.room_id, 'job', shape(leased));
      crew.work.onJobStarted(leased);
      return leased;
    }
    return null;
  }

  /** The job, if and only if this worker holds its lease. Extends the lease as a side effect. */
  function held(worker, jobId) {
    const job = get(jobId);
    if (!job || job.lease_worker !== worker.id || job.status !== 'leased') throw httpError(409, 'This worker does not hold that job (lease lost or job finished).');
    db.run('UPDATE jobs SET lease_until = ? WHERE id = ?', now() + LEASE_MS, jobId);
    return job;
  }

  /**
   * Apply a worker's outcome. `waiting` parks the job (an approval is pending) without
   * using up an attempt; it is requeued when the approval is decided.
   */
  function finish(job, { status, result = null, error = null }) {
    if (!['done', 'failed', 'waiting', 'cancelled'].includes(status)) throw httpError(400, 'Bad job status.');
    let next = status;
    if (status === 'failed' && job.attempts < job.max_attempts && !job.cancel) next = 'queued';
    db.run('UPDATE jobs SET status = ?, result = ?, error = ?, lease_worker = NULL, lease_until = 0, updated_at = ? WHERE id = ?',
      next, json(result), error ? String(error).slice(0, 2000) : null, now(), job.id);
    if (status === 'waiting') db.run('UPDATE jobs SET attempts = MAX(0, attempts - 1) WHERE id = ?', job.id);
    const after = get(job.id);
    crew.hub.broadcast(job.room_id, 'job', shape(after));
    crew.work.onJobFinished(after, { status: next === 'queued' ? 'retrying' : status, result, error });
    if (next === 'queued') {
      const agent = crew.agents.get(job.agent_id);
      if (agent) crew.workers.notify(job.room_id, agent.owner_id, 'jobs', { jobId: job.id });
    }
    return after;
  }

  function requeue(jobId, payloadPatch = {}) {
    const job = get(jobId);
    if (!job || !['waiting', 'failed', 'cancelled'].includes(job.status)) return null;
    const payload = { ...parse(job.payload, {}), ...payloadPatch };
    db.run("UPDATE jobs SET status = 'queued', cancel = 0, payload = ?, updated_at = ? WHERE id = ?", json(payload), now(), jobId);
    const agent = crew.agents.get(job.agent_id);
    if (agent) crew.workers.notify(job.room_id, agent.owner_id, 'jobs', { jobId });
    crew.hub.broadcast(job.room_id, 'job', shape(get(jobId)));
    return get(jobId);
  }

  function cancel(jobId, reason = 'cancelled') {
    const job = get(jobId);
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'leased') {
      // The worker learns on its next heartbeat or tool call and stops; the lease holder
      // reports the cancellation, which is when the task is updated.
      db.run('UPDATE jobs SET cancel = 1, error = ? WHERE id = ?', reason, jobId);
      return;
    }
    db.run("UPDATE jobs SET status = 'cancelled', cancel = 1, error = ?, updated_at = ? WHERE id = ?", reason, now(), jobId);
    crew.work.onJobFinished(get(jobId), { status: 'cancelled', error: reason });
  }

  function cancelForAgent(agentId, reason, { keepTasks = false } = {}) {
    for (const j of db.all("SELECT id, type, status FROM jobs WHERE agent_id = ? AND status IN ('queued','leased','waiting')", agentId)) {
      if (keepTasks && j.type === 'task') {
        // A paused agent's task waits for it; only a running one is interrupted.
        if (j.status === 'leased') db.run('UPDATE jobs SET cancel = 1, error = ? WHERE id = ?', reason, j.id);
        continue;
      }
      cancel(j.id, reason);
    }
  }

  /** A worker went away: its leases go back to the queue without costing an attempt. */
  function releaseWorker(workerId) {
    for (const j of db.all("SELECT * FROM jobs WHERE lease_worker = ? AND status = 'leased'", workerId)) {
      db.run("UPDATE jobs SET status = 'queued', lease_worker = NULL, lease_until = 0, attempts = MAX(0, attempts - 1), updated_at = ? WHERE id = ?", now(), j.id);
      crew.work.onJobInterrupted(get(j.id), 'worker disconnected');
    }
  }

  /** Leases that ran out while their worker still looked alive (hung, crashed mid-job). */
  function sweep() {
    // Jobs paused for a limit or budget come back when their owner's worker said they may.
    // A provider limit with no known reset comes back slowly; the worker re-checks it and
    // parks the job again rather than retrying the provider.
    for (const j of db.all("SELECT * FROM jobs WHERE status = 'waiting' AND result IS NOT NULL")) {
      const pause = parse(j.result, null)?.pause;
      if (pause?.resumeAfter && pause.resumeAfter <= now()) {
        requeue(j.id, { resume: { kind: 'pause', reason: pause.kind } });
        const t = j.type === 'task' ? crew.work.getTask(j.ref_id) : null;
        if (t?.status === 'waiting') crew.work.setTask(t.id, { status: 'queued', paused_reason: null });
      }
    }
    for (const j of db.all("SELECT * FROM jobs WHERE status = 'leased' AND lease_until < ?", now())) {
      if (j.cancel) { db.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), j.id); crew.work.onJobFinished(get(j.id), { status: 'cancelled', error: j.error }); continue; }
      finish(j, { status: 'failed', error: 'lease expired: the worker stopped reporting' });
    }
  }

  const forAgent = (agentId, limit = 30) => db.all('SELECT * FROM jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?', agentId, limit).map(shape);

  function log(job, level, text) {
    db.run('INSERT INTO exec_logs (job_id, agent_id, ts, level, text) VALUES (?,?,?,?,?)', job.id, job.agent_id, now(), level, String(text).slice(0, 4000));
    crew.hub.broadcast(job.room_id, 'log', { jobId: job.id, agentId: job.agent_id, level, text: String(text).slice(0, 500), ts: now() });
  }

  const logs = (jobId) => db.all('SELECT ts, level, text FROM exec_logs WHERE job_id = ? ORDER BY id', jobId);

  return { enqueue, get, shape, claim, held, finish, requeue, cancel, cancelForAgent, releaseWorker, sweep, forAgent, log, logs, LEASE_MS };
}

module.exports = { createJobs };
