'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  claudeCli, claudeInvocation, packagedArchive, stageMarketplace, stagedDrift, SNAPSHOT_FILES,
} = require('../bin/aop-claude-install.cjs');

// --- finding the CLI --------------------------------------------------------

test('on Windows the CLI is the PATHEXT match `where` lists, not the extensionless shim', () => {
  // What an npm install of Claude Code looks like: a Git Bash script and a .cmd,
  // extensionless first. Only the second is something Windows can start.
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    return 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n';
  };
  assert.equal(claudeCli({ platform: 'win32', exec }), 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  assert.deepEqual(calls, [['where.exe', 'claude']]);
});

test('on Windows a native claude.exe is taken as it is', () => {
  const exec = () => 'C:\\Users\\me\\.local\\bin\\claude.exe\r\n';
  assert.equal(claudeCli({ platform: 'win32', exec }), 'C:\\Users\\me\\.local\\bin\\claude.exe');
});

test('on Windows, nothing runnable or `where` failing both mean not installed', () => {
  assert.equal(claudeCli({ platform: 'win32', exec: () => 'C:\\npm\\claude\r\n' }), null);
  assert.equal(claudeCli({ platform: 'win32', exec: () => { throw new Error('exit 1'); } }), null);
});

test('elsewhere the CLI is still found by `command -v` as the script sh runs', () => {
  const calls = [];
  const exec = (file, args) => { calls.push([file, ...args]); return '/usr/local/bin/claude\n'; };
  for (const platform of ['darwin', 'linux']) {
    calls.length = 0;
    assert.equal(claudeCli({ platform, exec }), '/usr/local/bin/claude');
    assert.deepEqual(calls, [['/bin/sh', '-c', 'command -v claude']]);
  }
  assert.equal(claudeCli({ platform: 'linux', exec: () => '' }), null);
});

// --- running it -------------------------------------------------------------

test('an executable is run directly, with its args untouched', () => {
  const args = ['plugin', 'marketplace', 'add', '/Users/me/Library/Application Support/x'];
  assert.deepEqual(claudeInvocation('/usr/local/bin/claude', args), { file: '/usr/local/bin/claude', args, options: {} });
  assert.deepEqual(claudeInvocation('C:\\bin\\claude.exe', args).file, 'C:\\bin\\claude.exe');
});

test('a .cmd goes through cmd.exe with a quoted command line, spaces and all', () => {
  const run = claudeInvocation(
    'C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd',
    ['plugin', 'marketplace', 'add', 'C:\\Users\\A B\\.roving-office\\claude-plugin'],
    { comspec: 'C:\\Windows\\system32\\cmd.exe' },
  );
  assert.equal(run.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(run.args, [
    '/d', '/s', '/c',
    '""C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd" plugin marketplace add "C:\\Users\\A B\\.roving-office\\claude-plugin""',
  ]);
  // Without this Node re-quotes the line and cmd sees the quotes doubled.
  assert.equal(run.options.windowsVerbatimArguments, true);
});

test('the .cmd route really runs on Windows', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro claude '));
  try {
    const cli = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cli, '@echo off\r\necho [%1] [%~2]\r\n');
    const run = claudeInvocation(cli, ['plugin', 'C:\\a b\\c']);
    const out = execFileSync(run.file, run.args, { encoding: 'utf8', ...run.options }).trim();
    assert.equal(out, '[plugin] [C:\\a b\\c]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- staging the packaged plugin ------------------------------------------

test('the packaged plugin is staged as a local marketplace, not the checkout', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'roving-office-claude-stage-'));
  try {
    assert.ok(fs.existsSync(packagedArchive()), 'the archive for this version is committed');
    // Leftovers from an older stage must not survive into the new one.
    fs.mkdirSync(path.join(target, 'plugin', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(target, 'plugin', 'bin', 'stale.cjs'), '');

    assert.equal(stageMarketplace({ target }), target);

    const market = JSON.parse(fs.readFileSync(path.join(target, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(market.name, source.name);
    assert.deepEqual(market.owner, source.owner);
    assert.deepEqual(market.plugins, [{
      name: source.plugins[0].name,
      description: source.plugins[0].description,
      version,
      source: './plugin',
    }]);

    assert.ok(!fs.existsSync(path.join(target, 'plugin', 'bin', 'stale.cjs')));
    assert.ok(!fs.existsSync(path.join(target, 'plugin', '.worktrees')));
    assert.ok(!fs.existsSync(path.join(target, 'plugin', 'node_modules')));
    for (const rel of SNAPSHOT_FILES) assert.ok(fs.existsSync(path.join(target, 'plugin', rel)), rel);
    // A committed archive is the checkout, so `--status` reads the install as current.
    assert.deepEqual(stagedDrift(target), []);
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test('staging reports the files an out-of-date archive would leave behind', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'roving-office-claude-stage-'));
  try {
    stageMarketplace({ target });
    fs.appendFileSync(path.join(target, 'plugin', 'bin', 'mappers', 'claude-code.cjs'), '\n// older\n');
    assert.deepEqual(stagedDrift(target), [path.join('bin', 'mappers', 'claude-code.cjs')]);
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test('an archive member that climbs out of the stage is refused', () => {
  const { zip } = require('../bin/lib/zip.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roving-office-claude-stage-'));
  try {
    // zip() itself refuses `..`, so the bad name is patched into the bytes after.
    const bytes = zip([{ path: 'xx/evil.txt', data: Buffer.from('x') }]);
    const patched = Buffer.from(bytes.toString('latin1').replaceAll('xx/evil.txt', '../evil.txt'), 'latin1');
    const archive = path.join(dir, 'bad.zip');
    fs.writeFileSync(archive, patched);
    assert.throws(() => stageMarketplace({ archive, target: path.join(dir, 'stage') }), /escapes/);
    assert.ok(!fs.existsSync(path.join(dir, 'stage', 'evil.txt')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
