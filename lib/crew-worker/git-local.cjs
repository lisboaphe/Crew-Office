// Git on the agent owner's machine: every agent works in its own clone, per task, on its own
// branch. Saving a file (repo_write) is local. A commit is a local version. A push publishes
// to the room host. Other agents fetch, inspect and merge deliberately; nothing here ever
// rewrites someone else's working tree, force-pushes, or discards uncommitted work.
//
// repo_sync follows the project's sync mode:
//   smart  (default) tests → commit → push. Failing tests stop it before the commit, and the
//                    work stays in the working tree for the agent to fix.
//   live   commit and push a draft to draft/<agent>/<task>, unapproved and untested, kept
//          apart from the branch that gets reviewed. `final: true` runs the smart flow.
//   manual commit locally; push only when asked with `push: true`.
//
// The worker's token reaches Git through environment configuration, so it never appears in
// a command line, a remote URL or a .git/config file.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const sandbox = require('./sandbox.cjs');
const { subscriptionEnv } = require('./cli-providers.cjs');

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const MAX_WRITE = 512 * 1024;
const SECRET_FILES = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key|credentials\.json|\.npmrc|\.netrc)$/i;
const SECRET_TEXT = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|sk-proj-[A-Za-z0-9_-]{20,}|wk_[A-Za-z0-9_-]{20,}|gt_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x';

function createRepoTools({ dataDir, host, token }) {
  const auth = `Authorization: Basic ${Buffer.from(`crew:${token}`).toString('base64')}`;

  function git(cwd, args, { agent = null, allowFail = false } = {}) {
    const env = {
      ...subscriptionEnv(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_LFS_SKIP_SMUDGE: '1',
      // A repository is untrusted input: no hooks, no links out of the clone, no submodules or
      // other fetches of its choosing, whatever it contains or this machine's Git is set to do.
      GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: NULL_DEVICE, GIT_CONFIG_KEY_4: 'core.symlinks', GIT_CONFIG_VALUE_4: 'false',
      GIT_CONFIG_KEY_5: 'core.fsmonitor', GIT_CONFIG_VALUE_5: 'false', GIT_CONFIG_KEY_6: 'submodule.recurse', GIT_CONFIG_VALUE_6: 'false',
      GIT_CONFIG_KEY_7: 'protocol.file.allow', GIT_CONFIG_VALUE_7: 'never', GIT_CONFIG_KEY_8: 'protocol.ext.allow', GIT_CONFIG_VALUE_8: 'never',
      GCM_INTERACTIVE: 'never', GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_CONFIG_KEY_0: `http.${host.base}/.extraHeader`, GIT_CONFIG_VALUE_0: auth, GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false',
      ...(agent ? { GIT_AUTHOR_NAME: agent.name, GIT_AUTHOR_EMAIL: `${agent.id}@crew.local`, GIT_COMMITTER_NAME: agent.name, GIT_COMMITTER_EMAIL: `${agent.id}@crew.local` } : {}),
    };
    return new Promise((resolve, reject) => {
      execFile(process.env.CREW_GIT || 'git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180_000 }, (err, stdout, stderr) => {
        if (err && !allowFail) return reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).replaceAll(token, '[token]').slice(0, 800)}`));
        resolve({ ok: !err, out: String(stdout), err: String(stderr).replaceAll(token, '[token]') });
      });
    });
  }

  function repoOf(ctx, name) {
    const repos = ctx.project?.repos ?? [];
    if (!repos.length) throw new Error('This project has no Git repository you can use.');
    const r = name ? repos.find((x) => x.name === String(name).toLowerCase() || x.id === name) : repos[0];
    if (!r) throw new Error(`No repository called ${name}. Available: ${repos.map((x) => x.name).join(', ')}.`);
    return r;
  }

  const branchOf = (ctx) => ctx.task?.branch ?? `agent/${slug(ctx.agent.name)}/work`;
  const folderOf = (ctx, r) => path.join(dataDir, 'worktrees', ctx.agent.id.replace(/[^\w-]/g, ''), (ctx.task?.id ?? ctx.job.id).slice(-10).replace(/[^\w-]/g, ''), r.name);

  /** This agent's clone for this task. Reused if it exists, so uncommitted work is never lost. */
  async function ensure(ctx, name) {
    const r = repoOf(ctx, name);
    const dir = folderOf(ctx, r);
    if (fs.existsSync(path.join(dir, '.git'))) return { repo: r, dir, branch: branchOf(ctx) };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), ['clone', '--quiet', `${host.base}${r.url}`, dir]);
    const branch = branchOf(ctx);
    const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true });
    await git(dir, ['checkout', '--quiet', '-B', branch, remote.ok ? `origin/${branch}` : `origin/${r.defaultBranch}`]);
    return { repo: r, dir, branch };
  }

  /** A path inside the clone, never inside .git, and not through a link that leaves it. */
  function inside(dir, rel) {
    const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some((p) => p === '..' || p === '.git') || /\p{Cc}/u.test(s)) throw new Error(`Not an allowed path: ${rel}`);
    const full = path.join(dir, s);
    let probe = full;
    while (!fs.existsSync(probe) && probe !== dir) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const root = fs.realpathSync(dir);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${rel} points outside the repository.`);
    return { full, rel: s };
  }

  function walk(dir, base = dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, base, out);
      else out.push(path.relative(base, p).replace(/\\/g, '/'));
    }
    return out;
  }

  /** The test command: `.crew.json` says, else any Node test files present. */
  function testCommand(dir) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, '.crew.json'), 'utf8'));
      if (c.test) return String(c.test);
    } catch { /* no config */ }
    const tests = walk(dir).filter((f) => /\.test\.(c|m)?js$/.test(f));
    return tests.length ? `node --test ${tests.join(' ')}` : null;
  }

  function filesForSandbox(dir) {
    const files = {};
    let total = 0;
    for (const f of walk(dir)) {
      const size = fs.statSync(path.join(dir, f)).size;
      if (size > 1024 * 1024 || total + size > 16 * 1024 * 1024) continue;
      total += size;
      files[f] = fs.readFileSync(path.join(dir, f));
    }
    return files;
  }

  async function scanStaged(dir) {
    const names = (await git(dir, ['diff', '--cached', '--name-only', '--diff-filter=AM'])).out.split('\n').filter(Boolean);
    for (const n of names) {
      if (SECRET_FILES.test(n) && !/\.env\.example$/i.test(n)) return `${n} looks like a secrets file`;
      const full = path.join(dir, n);
      if (fs.existsSync(full) && fs.statSync(full).size < 2 * 1024 * 1024 && SECRET_TEXT.test(fs.readFileSync(full, 'utf8'))) return `${n} contains something that looks like a credential`;
    }
    return null;
  }

  async function commit(ctx, dir, message, tests) {
    await git(dir, ['add', '-A']);
    const problem = await scanStaged(dir);
    if (problem) { await git(dir, ['reset', '--quiet']); throw new Error(`Refused to commit: ${problem}. Remove it first.`); }
    const staged = await git(dir, ['diff', '--cached', '--quiet'], { allowFail: true });
    const merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
    if (staged.ok && !merging) return null;
    const text = `${String(message ?? '').trim() || 'Work in progress'}\n\nCrew-Agent: ${ctx.agent.id}\nCrew-Task: ${ctx.task?.id ?? '-'}\nCrew-Tests: ${tests}\n`;
    await git(dir, ['commit', '--quiet', '-m', text], { agent: ctx.agent });
    return (await git(dir, ['rev-parse', 'HEAD'])).out.trim();
  }

  async function changed(dir) {
    return (await git(dir, ['status', '--porcelain'])).out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  }

  return {
    ensure,

    async repo_files(ctx, { repo } = {}) {
      const { dir, branch, repo: r } = await ensure(ctx, repo);
      return { repo: r.name, branch, files: walk(dir) };
    },

    async repo_read(ctx, { repo, path: rel, ref }) {
      const { dir } = await ensure(ctx, repo);
      if (ref) {
        if (!/^[\w./-]+$/.test(String(ref))) throw new Error('Bad ref.');
        const r = await git(dir, ['show', `${ref}:${String(rel).replace(/\\/g, '/')}`], { allowFail: true });
        if (!r.ok) throw new Error(`No ${rel} at ${ref}. Try repo_fetch first.`);
        return { path: rel, ref, content: r.out.slice(0, 60_000) };
      }
      const { full, rel: safe } = inside(dir, rel);
      if (!fs.existsSync(full)) throw new Error(`No such file: ${safe}`);
      return { path: safe, content: fs.readFileSync(full, 'utf8').slice(0, 60_000) };
    },

    /** Save: local only. Nothing leaves this machine until repo_sync. */
    async repo_write(ctx, { repo, path: rel, content }) {
      const { dir } = await ensure(ctx, repo);
      const { full, rel: safe } = inside(dir, rel);
      const body = String(content ?? '');
      if (Buffer.byteLength(body) > MAX_WRITE) throw new Error(`Files are limited to ${MAX_WRITE / 1024} KB here; binaries belong in the shared file store (publish_file).`);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
      return { saved: safe, note: 'Saved locally. repo_sync tests, commits and publishes it.' };
    },

    async repo_status(ctx, { repo } = {}) {
      const { dir, branch, repo: r } = await ensure(ctx, repo);
      const ahead = (await git(dir, ['rev-list', '--count', `origin/${r.defaultBranch}..HEAD`], { allowFail: true })).out.trim();
      const diff = await git(dir, ['diff', '--no-color', 'HEAD']);
      return { repo: r.name, branch, changed: await changed(dir), commitsAheadOfMain: Number(ahead) || 0, uncommittedDiff: diff.out.slice(0, 30_000) };
    },

    async repo_sync(ctx, { repo, message, final = false, push = false } = {}) {
      const { dir, branch } = await ensure(ctx, repo);
      const mode = final ? 'smart' : ctx.rules?.syncMode ?? 'smart';
      let tests = 'none';
      let output = '';
      if (mode === 'smart') {
        const cmd = testCommand(dir);
        if (cmd) {
          const r = await sandbox.forContext(ctx, { hostBase: host.base, dataDir })(cmd, filesForSandbox(dir));
          output = r.output;
          // Refused is not failed: nothing ran, so the reviewer is told tests did not run.
          tests = r.refused ? 'none' : r.exitCode === 0 ? 'passed' : 'failed';
          if (tests === 'failed') return { synced: false, mode, tests, testCommand: cmd, output: output.slice(-6000), note: 'Tests failed, so nothing was committed or pushed. Your changes are still in the working tree: fix them and sync again.' };
        }
      }
      const hash = await commit(ctx, dir, message, mode === 'live' ? 'draft' : tests);
      if (mode === 'manual' && !push) return { synced: false, mode, committed: hash, branch, note: 'Committed locally (manual sync). Nothing was published; call repo_sync with push: true when ready.' };
      const head = (await git(dir, ['rev-parse', 'HEAD'])).out.trim();
      const target = mode === 'live' ? `draft/${branch.replace(/^agent\//, '')}` : branch;
      const pushed = await git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${target}`], { allowFail: true });
      if (!pushed.ok) {
        return { synced: false, mode, committed: hash, head, pushError: pushed.err.slice(0, 800), note: 'Committed locally but the host refused or could not be reached. Nothing is lost; fetch, resolve anything it reports, and sync again.' };
      }
      return { synced: true, mode, committed: hash, head, branch: target, tests, draft: mode === 'live', output: output.slice(-1500), note: mode === 'live' ? 'Draft published. Drafts cannot be merged; run repo_sync with final: true for the reviewed branch.' : 'Published. Next: request_merge.' };
    },

    /** What others published, without touching this working tree. */
    async repo_fetch(ctx, { repo } = {}) {
      const { dir, repo: r } = await ensure(ctx, repo);
      await git(dir, ['fetch', '--quiet', '--prune', 'origin']);
      const newOnMain = await git(dir, ['log', '--format=%h %an: %s', `HEAD..origin/${r.defaultBranch}`, '--max-count=30'], { allowFail: true });
      const branches = await git(dir, ['for-each-ref', 'refs/remotes/origin', '--format=%(refname:short)']);
      return { mainHasNew: newOnMain.out.split('\n').filter(Boolean), branches: branches.out.split('\n').filter(Boolean) };
    },

    /** Bring main into this branch. Conflicts stay in the files for the agent to resolve. */
    async repo_merge_main(ctx, { repo } = {}) {
      const { dir, repo: r } = await ensure(ctx, repo);
      const dirty = await changed(dir);
      if (dirty.length) return { merged: false, note: `You have uncommitted changes (${dirty.map((d) => d.path).join(', ')}). Sync or commit them first; a merge will not overwrite them.` };
      await git(dir, ['fetch', '--quiet', 'origin']);
      const m = await git(dir, ['merge', '--no-edit', `origin/${r.defaultBranch}`], { allowFail: true, agent: ctx.agent });
      if (m.ok) return { merged: true, head: (await git(dir, ['rev-parse', 'HEAD'])).out.trim() };
      const conflicted = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
      return { merged: false, conflict: true, files: conflicted, note: 'Conflicts are marked in these files. Resolve them with repo_write, then repo_sync to commit the merge.' };
    },

    /** A binary or release from the clone into the shared store: only changed bytes travel. */
    async publish_file(ctx, { repo, path: rel, as, note }) {
      const { dir } = await ensure(ctx, repo);
      const { full, rel: safe } = inside(dir, rel);
      if (!fs.existsSync(full)) throw new Error(`No such file: ${safe}`);
      const { uploadFile } = require('./upload.cjs');
      const file = await uploadFile({ host, jobId: ctx.job.id, source: full, target: as || safe, note });
      return { published: file.path, version: file.version, sha256: file.sha256, size: file.size };
    },
  };
}

module.exports = { createRepoTools };
