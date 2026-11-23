'use strict';
// A worktree's node_modules link must be unlinked, never followed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeWorktree } = require('../bin/worktree-remove.cjs');

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const pkg = path.join(repo, 'node_modules', 'pkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'index.js'), 'x');
  const wt = path.join(repo, '.worktrees', 'w');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'worktree-w');
  // Keep the link out of `git status`, as AGENTS.md does.
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n.worktrees\n');
  // 'junction' is honoured on Windows and ignored elsewhere (a plain symlink).
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'), 'junction');
  return { root, repo, wt };
}

const survived = (repo) => fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js'));

test('removes the worktree and leaves the link target intact', () => {
  const { root, repo, wt } = fixture();
  try {
    const r = removeWorktree(wt, { cwd: repo });
    assert.ok(r.linkRemoved);
    assert.ok(!fs.existsSync(wt), 'worktree gone');
    assert.ok(survived(repo), 'node_modules survived');
    assert.ok(r.branchDeleted, 'merged branch deleted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('refuses a dirty worktree and touches nothing', () => {
  const { root, repo, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, 'new.txt'), 'wip');
    assert.throws(() => removeWorktree(wt, { cwd: repo }), /not clean/);
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('refuses the primary checkout and keeps an unmerged branch', () => {
  const { root, repo, wt } = fixture();
  try {
    assert.throws(() => removeWorktree(repo, { cwd: repo }), /primary/);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'unmerged');
    const r = removeWorktree(wt, { cwd: repo });
    assert.strictEqual(r.branchDeleted, false);
    assert.ok(git(repo, 'branch', '--list', 'worktree-w'));
    assert.ok(survived(repo));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
