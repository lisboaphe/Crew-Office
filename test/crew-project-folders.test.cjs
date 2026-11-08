// A folder per project on the worker's machine, hand-offs inside it, and the worker letting go of
// what is gone: a connection whose token the office no longer knows, and a hand-off whose task is.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { projectFolder, folderName, taskFolderName, MARKER } = require('../lib/crew-worker/project-folders.cjs');
const { prepareHandoff, pendingHandoffs, removeHandoff } = require('../lib/crew-worker/handoff.cjs');
const { createConnection } = require('../lib/crew-worker/worker.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-projects-'));
const ctxFor = (project, room = 'Paper’s office') => ({ room: { name: room }, project });

test('a project gets its own folder, inside one for its office, made the first time it is needed', () => {
  const root = path.join(tmp(), 'Crew Office Projects');
  assert.equal(fs.existsSync(root), false);
  const dir = projectFolder(ctxFor({ id: 'prj_abc123', name: 'Yumi Hustle character' }), root);
  assert.equal(dir, path.join(root, 'Paper’s office', 'Yumi Hustle character'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).id, 'prj_abc123');
  assert.ok(fs.existsSync(path.join(root, 'README.txt')), 'the folder says what it is for');
  assert.equal(projectFolder(ctxFor({ id: 'prj_abc123', name: 'Yumi Hustle character' }), root), dir, 'and the same folder next time');
});

test('a renamed project keeps its folder, and two projects of one name never share one', () => {
  const root = tmp();
  const first = projectFolder(ctxFor({ id: 'prj_first1', name: 'Site' }), root);
  assert.equal(projectFolder(ctxFor({ id: 'prj_first1', name: 'Website, renamed' }), root), first);
  const second = projectFolder(ctxFor({ id: 'prj_other2', name: 'Site' }), root);
  assert.notEqual(second, first);
  assert.match(path.basename(second), /^Site \(other2\)$/);
});

test('a folder somebody made themselves is never taken over', () => {
  const root = tmp();
  const theirs = path.join(root, 'Office', 'Notes');
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, 'mine.txt'), 'keep');
  const dir = projectFolder(ctxFor({ id: 'prj_notes9', name: 'Notes' }, 'Office'), root);
  assert.notEqual(dir, theirs);
  assert.equal(fs.existsSync(path.join(theirs, MARKER)), false);
});

test('work outside a project has no project folder', () => {
  assert.equal(projectFolder({ room: { name: 'Office' } }, tmp()), null);
});

test('names become folder names on every system', () => {
  assert.equal(folderName('a/b\\c:d*e?"f<g>h|i'), 'a b c d e f g h i');
  assert.equal(folderName('Trailing dots...'), 'Trailing dots');
  assert.equal(folderName('CON'), 'Untitled');
  assert.equal(folderName(''), 'Untitled');
  assert.equal(taskFolderName('Plan: Priston', 'job_cc2uSqhJojrv'), 'Plan Priston (hJojrv)');
});

test('a hand-off is written in its project’s folder, listed for the worker page, and can be removed', async () => {
  const dataDir = tmp();
  const projects = path.join(dataDir, 'Projects');
  const ctx = {
    room: { name: 'Paper’s office' },
    project: { id: 'prj_priston', name: 'Priston' },
    agent: { name: 'Developer' },
    job: { id: 'job_cc2uSqhJojrv' },
    task: { title: 'Plan: Priston', kind: 'plan' },
  };
  let finished = null;
  await prepareHandoff({
    ctx, localTools: { projectsDir: projects }, dataDir,
    finish: (status, extra) => { finished = { status, extra }; },
    systemPrompt: () => 'role', taskPrompt: () => 'task', log: () => {},
  });
  assert.equal(finished.status, 'waiting');
  const listed = pendingHandoffs(dataDir);
  assert.equal(listed.length, 1);
  const expected = path.join(projects, 'Paper’s office', 'Priston', 'handoffs', 'Plan Priston (hJojrv)');
  assert.equal(listed[0].folder, expected);
  assert.ok(fs.existsSync(path.join(expected, 'HANDOFF.md')), 'the brief is in the project’s folder');
  assert.match(fs.readFileSync(path.join(expected, 'HANDOFF.md'), 'utf8'), /PLAN\.json/);

  assert.equal(removeHandoff(dataDir, 'job_cc2uSqhJojrv'), true);
  assert.equal(pendingHandoffs(dataDir).length, 0, 'gone from the list');
  assert.ok(fs.existsSync(path.join(expected, 'HANDOFF.md')), 'and its files stay');
  assert.equal(removeHandoff(dataDir, 'job_nothing'), false);
});

test('a worker the office no longer knows stops asking, once, instead of every 10 seconds', async (t) => {
  let asked = 0;
  const server = http.createServer((req, res) => {
    asked += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown or revoked worker token.' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dataDir = tmp();
  let refused = 0;
  const lines = [];
  const conn = createConnection({
    hostUrl: `http://127.0.0.1:${server.address().port}`, token: 'old', vault: { get: () => ({}) }, dataDir,
    localToolsFor: () => ({}), log: (l) => lines.push(l), onRefused: () => { refused += 1; },
  });
  await conn.start();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.equal(refused, 1);
  assert.equal(asked, 1, 'asked once, not again');
  assert.equal(conn.status.refused, true);
  assert.ok(!lines.some((l) => /Retrying/.test(l)), 'no retry scheduled');
});

test('an office that is only out of reach is still retried', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(503); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let refused = 0;
  const lines = [];
  const conn = createConnection({
    hostUrl: `http://127.0.0.1:${server.address().port}`, token: 't', vault: { get: () => ({}) }, dataDir: tmp(),
    localToolsFor: () => ({}), log: (l) => lines.push(l), onRefused: () => { refused += 1; },
  });
  await conn.start();
  conn.stop();
  assert.equal(refused, 0);
  assert.ok(lines.some((l) => /Retrying in 10 s/.test(l)));
});
