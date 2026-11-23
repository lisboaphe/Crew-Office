#!/usr/bin/env node
/**
 * Remove a git worktree without taking the primary checkout's node_modules with it.
 *
 *     npm run worktree:remove -- .worktrees/issue-4
 *
 * A worktree's `node_modules` is a symlink (macOS, Linux) or junction (Windows) to the
 * primary checkout's. `git worktree remove` can follow that link and empty the real
 * directory it points at, and a hand-rolled `cmd //c rmdir` that was meant to unlink it
 * first did nothing because of a quoting bug. So this script does the unlinking itself,
 * with `fs`, and never recursively:
 *
 *   1. refuse the primary checkout, and a worktree git does not know;
 *   2. refuse a dirty worktree (uncommitted or untracked work would be lost);
 *   3. if `node_modules` is a link, remove the link only; a real directory is left to git;
 *   4. `git worktree remove` (never --force);
 *   5. `git branch -d`, which git itself refuses unless the branch is merged.
 *
 * Exit 0 on success; non-zero, with the reason, when anything refuses.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Parse `git worktree list --porcelain` into [{ path, branch }]; the first is the primary. */
function listWorktrees(cwd) {
  const r = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(`git worktree list failed: ${r.err}`);
  return r.out.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const wt = {};
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    return wt;
  });
}

const same = (a, b) => {
  const norm = (p) => path.resolve(fs.realpathSync.native(p)).toLowerCase();
  return norm(a) === norm(b);
};

/** Remove `node_modules` only if it is a link. Returns true when a link was removed. */
function unlinkNodeModules(worktreePath) {
  const nm = path.join(worktreePath, 'node_modules');
  const st = fs.lstatSync(nm, { throwIfNoEntry: false });
  if (!st || !st.isSymbolicLink()) return false; // absent, or a real directory: git's to delete
  try {
    fs.unlinkSync(nm);
  } catch {
    fs.rmdirSync(nm); // Windows junctions: non-recursive rmdir removes the link, not the contents
  }
  if (fs.lstatSync(nm, { throwIfNoEntry: false })) throw new Error(`could not unlink ${nm}`);
  return true;
}

/** Returns { removed, branch, branchDeleted, linkRemoved }. Throws with a reason on refusal. */
function removeWorktree(target, { cwd = process.cwd() } = {}) {
  const trees = listWorktrees(cwd);
  const primary = trees[0];
  const abs = path.resolve(cwd, target);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  if (same(abs, primary.path)) throw new Error('refusing to remove the primary checkout');
  const wt = trees.slice(1).find((t) => fs.existsSync(t.path) && same(t.path, abs));
  if (!wt) throw new Error(`${abs} is not a worktree of this repository`);

  const status = git(wt.path, ['status', '--porcelain']);
  if (!status.ok) throw new Error(`git status failed: ${status.err}`);
  if (status.out) throw new Error(`worktree is not clean; commit or discard first:\n${status.out}`);

  const linkRemoved = unlinkNodeModules(wt.path);

  const rm = git(primary.path, ['worktree', 'remove', wt.path]);
  if (!rm.ok) throw new Error(`git worktree remove failed: ${rm.err}`);

  let branchDeleted = false;
  if (wt.branch) branchDeleted = git(primary.path, ['branch', '-d', wt.branch]).ok;
  return { removed: wt.path, branch: wt.branch, branchDeleted, linkRemoved };
}

module.exports = { removeWorktree, listWorktrees, unlinkNodeModules };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg.startsWith('-')) {
    console.error('usage: npm run worktree:remove -- <worktree-path>');
    process.exit(2);
  }
  try {
    const r = removeWorktree(arg);
    console.log(`removed ${r.removed}${r.linkRemoved ? ' (node_modules link unlinked first)' : ''}`);
    if (r.branch) {
      console.log(r.branchDeleted
        ? `deleted branch ${r.branch}`
        : `kept branch ${r.branch} (not merged yet; git branch -d refused)`);
    }
  } catch (e) {
    console.error(`worktree-remove: ${e.message}`);
    process.exit(1);
  }
}
