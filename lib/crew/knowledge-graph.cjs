// The optional Graphify engine: a map of a project's code, built from what has really been merged.
//
// A build works on a private export of one commit of the default branch, so unreviewed work is never
// in the graph. Files that hold secrets are removed before Graphify looks. It runs code-only, with no
// API keys in its environment, so it has nothing it could send anywhere. What it wrote is then read
// as untrusted input and rebuilt field by field: this stored copy, not Graphify's file, is all anyone
// ever sees. Graphify keeps its own cache between builds, which makes a rebuild incremental.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { newId, now } = require('./db.cjs');
const { clean, SENSITIVE_FILE } = require('./scrub.cjs');

const BUILD_MS = 10 * 60_000;
const MAX_NODES = 20_000;
const MAX_EDGES = 60_000;
const CHECK_MS = 10 * 60_000;

function cleanEnv() {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  // Rebuilding after code was deleted is expected to make a smaller graph.
  return { ...env, GRAPHIFY_FORCE: '1', PYTHONIOENCODING: 'utf-8' };
}

/** A path inside the repository, or null for anything else. */
function safeFile(value, root) {
  let p = String(value ?? '').replace(/\\/g, '/');
  if (!p) return null;
  const base = root.replace(/\\/g, '/');
  if (p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) p = p.slice(base.length + 1);
  p = p.replace(/^\.\//, '');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p.startsWith('graphify-out/')) return null;
  return p.slice(0, 400);
}

const short = (value, max = 200) => clean(String(value ?? '')).slice(0, max);

/**
 * Graphify's output, reduced to the fields this app shows. Anything else in that file, and any node
 * from outside the repository or from a file that holds secrets, does not survive.
 */
function sanitizeGraph(raw, root) {
  const nodes = [];
  const ids = new Map();
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    if (nodes.length >= MAX_NODES) break;
    if (n?.id === undefined || n?.id === null) continue;
    const file = n.source_file ? safeFile(n.source_file, root) : null;
    if (n.source_file && !file) continue;
    if (file && SENSITIVE_FILE.test(file)) continue;
    const id = `n${nodes.length}`;
    ids.set(String(n.id), id);
    const line = /(\d+)/.exec(String(n.source_location ?? ''))?.[1];
    nodes.push({ id, label: short(n.label ?? n.id, 160), file, line: line ? Number(line) : null, type: short(n.file_type ?? n.type ?? '', 24), community: Number.isInteger(n.community) ? n.community : null });
  }
  const edges = [];
  for (const e of Array.isArray(raw?.links) ? raw.links : Array.isArray(raw?.edges) ? raw.edges : []) {
    if (edges.length >= MAX_EDGES) break;
    const from = ids.get(String(e?.source?.id ?? e?.source));
    const to = ids.get(String(e?.target?.id ?? e?.target));
    if (!from || !to) continue;
    edges.push({ from, to, relation: short(e.relation ?? 'related', 40), confidence: ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(e.confidence) ? e.confidence : null });
  }
  return { nodes, edges };
}

function createGraphs(crew, { onChange = () => {}, onStatus = () => {} } = {}) {
  const { db } = crew;
  const home = path.join(crew.dataDir, 'knowledge', 'graphs');
  let check = { at: 0, installed: false, version: null, reason: 'Checking this computer…', checking: true };
  let looking = null;
  const running = new Map();
  const queued = new Map();

  /**
   * Ways it might be reached, as a program and any leading arguments. Never through a shell: paths
   * here come from repositories. pip can put the program somewhere that is not on the PATH,
   * especially on Windows, so the Python module is tried as well.
   */
  function candidates() {
    const set = process.env.CREW_GRAPHIFY_CMD;
    if (set) return [set.startsWith('[') ? JSON.parse(set) : [set]];
    return [['graphify'], ['py', '-m', 'graphify'], ['python3', '-m', 'graphify'], ['python', '-m', 'graphify']];
  }
  let resolved = null;
  const command = () => resolved ?? candidates()[0];

  const askVersion = ([cmd, ...pre]) => new Promise((resolve) => {
    execFile(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: cleanEnv() }, (error, stdout, stderr) => {
      resolve(error ? null : (`${stdout}${stderr}`.match(/\d+\.\d+[.\w-]*/)?.[0] ?? 'installed'));
    });
  });

  function refresh() {
    looking ??= (async () => {
      let version = null;
      for (const way of candidates()) {
        version = await askVersion(way);
        if (version) { resolved = way; break; }
      }
      check = { at: Date.now(), installed: Boolean(version), version, reason: version ? null : 'Graphify is not installed on this computer.' };
      looking = null;
      onStatus();
      return check;
    })();
    return looking;
  }

  const status = () => { if (Date.now() - check.at > CHECK_MS) refresh(); return check; };

  const row = (repoId) => db.get('SELECT * FROM knowledge_graphs WHERE repo_id = ?', repoId);
  const fileOf = (repoId) => path.join(home, repoId, 'graph.json');
  const treeOf = (repoId) => path.join(home, repoId, 'tree');

  function save(repo, fields) {
    const existing = row(repo.id);
    const next = { commit_sha: existing?.commit_sha ?? null, state: 'idle', error: null, nodes: existing?.nodes ?? 0, edges: existing?.edges ?? 0, built_at: existing?.built_at ?? null, engine_version: existing?.engine_version ?? null, ...fields };
    db.run(`INSERT INTO knowledge_graphs (id, room_id, project_id, repo_id, commit_sha, state, error, nodes, edges, built_at, engine_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo_id) DO UPDATE SET commit_sha = excluded.commit_sha, state = excluded.state, error = excluded.error, nodes = excluded.nodes, edges = excluded.edges, built_at = excluded.built_at, engine_version = excluded.engine_version`,
    existing?.id ?? newId('kgr'), repo.room_id, repo.project_id, repo.id, next.commit_sha, next.state, next.error, next.nodes, next.edges, next.built_at, next.engine_version);
    onChange(repo);
  }

  /** The export, minus anything secret. Graphify's folder stays, because that is its cache. */
  function exportTree(repo, commit) {
    const tree = treeOf(repo.id);
    fs.mkdirSync(tree, { recursive: true });
    for (const name of fs.readdirSync(tree)) if (name !== 'graphify-out') fs.rmSync(path.join(tree, name), { recursive: true, force: true });
    crew.git.exportTree(repo, commit, tree);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'graphify-out' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (SENSITIVE_FILE.test(path.relative(tree, full))) fs.rmSync(full, { force: true });
      }
    };
    walk(tree);
    return tree;
  }

  function runGraphify(tree) {
    return new Promise((resolve, reject) => {
      const [cmd, ...pre] = command();
      const child = spawn(cmd, [...pre, 'update', tree], { cwd: tree, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const take = (x) => { out = (out + x).slice(-4000); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Graphify took too long.')); }, BUILD_MS);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(clean(out).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `Graphify stopped with code ${code}.`)); });
    });
  }

  async function build(repo, commit) {
    save(repo, { state: 'building', error: null });
    try {
      const tree = exportTree(repo, commit);
      await runGraphify(tree);
      const raw = JSON.parse(fs.readFileSync(path.join(tree, 'graphify-out', 'graph.json'), 'utf8'));
      const graph = sanitizeGraph(raw, tree);
      fs.writeFileSync(fileOf(repo.id), JSON.stringify(graph));
      save(repo, { state: 'ready', commit_sha: commit, nodes: graph.nodes.length, edges: graph.edges.length, built_at: now(), engine_version: clean(String(raw?.graph?.graphify_version ?? status().version ?? '')).slice(0, 40) || null });
      crew.audit(repo.room_id, 'system', 'graph.build', { repo: repo.name, commit: commit.slice(0, 12), nodes: graph.nodes.length }, { projectId: repo.project_id });
    } catch (err) {
      save(repo, { state: 'failed', error: clean(err.message).slice(0, 500) });
    }
  }

  /** At most one build per repository, and at most one more waiting: the newest commit wins. */
  function schedule(repo, commit = crew.git.branchHead(repo, repo.default_branch)) {
    if (!commit) return Promise.resolve();
    if (running.has(repo.id)) { queued.set(repo.id, commit); return running.get(repo.id); }
    const job = build(repo, commit).finally(() => {
      running.delete(repo.id);
      const next = queued.get(repo.id);
      queued.delete(repo.id);
      if (next && next !== commit) schedule(repo, next);
    });
    running.set(repo.id, job);
    return job;
  }

  function read(repoId) {
    try { return JSON.parse(fs.readFileSync(fileOf(repoId), 'utf8')); } catch { return null; }
  }

  function info(repo) {
    const r = row(repo.id);
    const head = crew.git.branchHead(repo, repo.default_branch);
    return {
      repoId: repo.id, repoName: repo.name, state: r?.state ?? 'none', commit: r?.commit_sha ?? null, head,
      stale: Boolean(r?.commit_sha && head && r.commit_sha !== head), nodes: r?.nodes ?? 0, edges: r?.edges ?? 0, builtAt: r?.built_at ?? null, engineVersion: r?.engine_version ?? null, error: r?.error ?? null,
    };
  }

  /** The places in the code that match some words, and what each is connected to. */
  function query(repoId, words, limit = 12) {
    const g = read(repoId);
    if (!g) return { matches: [] };
    const terms = String(words ?? '').toLowerCase().split(/[^a-z0-9_.$/-]+/).filter((t) => t.length > 1).slice(0, 12);
    if (!terms.length) return { matches: [] };
    const scored = [];
    for (const n of g.nodes) {
      const label = n.label.toLowerCase();
      const file = (n.file ?? '').toLowerCase();
      let score = 0;
      for (const t of terms) { if (label === t) score += 5; else if (label.includes(t)) score += 3; else if (file.includes(t)) score += 1; }
      if (score) scored.push({ n, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const describe = (n) => `${n.label}${n.file ? ` (${n.file}${n.line ? `:${n.line}` : ''})` : ''}`;
    return {
      matches: scored.slice(0, limit).map(({ n }) => ({
        name: n.label, file: n.file, line: n.line,
        uses: g.edges.filter((e) => e.from === n.id).slice(0, 8).map((e) => `${e.relation} ${describe(byId.get(e.to))}`),
        usedBy: g.edges.filter((e) => e.to === n.id).slice(0, 8).map((e) => `${describe(byId.get(e.from))} ${e.relation} this`),
      })),
    };
  }

  function remove(repoId) {
    db.run('DELETE FROM knowledge_graphs WHERE repo_id = ?', repoId);
    fs.rmSync(path.join(home, repoId), { recursive: true, force: true });
  }

  /** Let any build still running finish or fail on its own; only wait for the tests that ask. */
  const settled = () => Promise.allSettled([...running.values()]);

  return { status, refresh, schedule, info, read, query, remove, settled };
}

module.exports = { createGraphs, sanitizeGraph, safeFile };
