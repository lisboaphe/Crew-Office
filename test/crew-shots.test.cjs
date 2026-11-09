// Screenshots the agents took: kept on this computer, shown only to its owner, kept or deleted.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShots } = require('../lib/crew/shots.cjs');
const { captureScreenshots, isScreenshotCall } = require('../bin/lib/shot-capture.cjs');
const { startHost } = require('./lib/crew-harness.cjs');

// The smallest PNG there is: one transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-shots-'));

function browserShot(extra = {}) {
  return {
    hook_event_name: 'PostToolUse', cwd: '/home/me/space-game',
    tool_name: 'mcp__Claude_Browser__computer', tool_input: { action: 'screenshot' },
    tool_response: [{ type: 'text', text: 'Took a screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }],
    ...extra,
  };
}

test('a screenshot Claude takes is written to the folder with who took it', () => {
  const folder = tmp();
  const names = captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload: browserShot(), folder, env: {} });
  assert.equal(names.length, 1);
  assert.match(names[0], /^claude-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(folder, names[0])), PNG);
  const notes = JSON.parse(fs.readFileSync(path.join(folder, `${names[0]}.json`), 'utf8'));
  assert.equal(notes.by, 'Claude');
  assert.equal(notes.title, 'Browser screenshot');
  assert.equal(notes.project, 'space-game');
});

test('an MCP-shaped image result is found too', () => {
  const folder = tmp();
  const payload = browserShot({ tool_name: 'mcp__playwright__browser_take_screenshot', tool_input: {}, tool_response: { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] } });
  assert.equal(captureScreenshots({ harness: 'codex-cli', event: 'PostToolUse', payload, folder, env: {} }).length, 1);
});

test('opening an image file is not a screenshot, and nothing is written', () => {
  const folder = path.join(tmp(), 'shots');
  const payload = browserShot({ tool_name: 'Read', tool_input: { file_path: 'art/ship.png' } });
  assert.deepEqual(captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload, folder, env: {} }), []);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(isScreenshotCall('mcp__Claude_Browser__computer', { action: 'left_click' }), false);
});

test('bytes that are not an image are not written, whatever the payload calls them', () => {
  const folder = tmp();
  const payload = browserShot({ tool_response: [{ type: 'image', source: { media_type: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') } }] });
  assert.deepEqual(captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload, folder, env: {} }), []);
});

test('it can be turned off by setting or by environment', () => {
  const folder = tmp();
  assert.deepEqual(captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload: browserShot(), folder, env: { ROVING_OFFICE_SCREENSHOTS: '0' } }), []);
  assert.deepEqual(captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload: browserShot(), folder, env: {}, settings: { screenshots: 'off' } }), []);
  assert.deepEqual(captureScreenshots({ harness: 'claude-code', event: 'PreToolUse', payload: browserShot(), folder, env: {} }), []);
});

test('the store lists newest first, keeps, deletes, and refuses names outside its folder', () => {
  const dataDir = tmp();
  const shots = createShots({ dataDir });
  assert.deepEqual(shots.list().shots, []);
  fs.mkdirSync(shots.folder);
  fs.writeFileSync(path.join(shots.folder, 'codex-old.png'), PNG);
  fs.utimesSync(path.join(shots.folder, 'codex-old.png'), new Date(1000), new Date(1000));
  captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload: browserShot(), folder: shots.folder, env: {} });
  fs.writeFileSync(path.join(shots.folder, 'notes.txt'), 'not a picture');

  const { shots: listed } = shots.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].by, 'Claude');
  assert.equal(listed[1].by, 'Codex', 'named after its file when it came with no notes');

  shots.keep('codex-old.png');
  assert.equal(shots.list().shots.find((s) => s.name === 'codex-old.png').kept, true);
  assert.deepEqual(shots.clearUnkept(), { deleted: 1 });
  assert.deepEqual(shots.list().shots.map((s) => s.name), ['codex-old.png']);
  shots.remove('codex-old.png');
  assert.equal(shots.list().shots.length, 0);

  for (const bad of ['../crew.sqlite', '..png', 'a/b.png', '.hidden.png', 'notes.txt', 'x.png.json']) {
    assert.throws(() => shots.read(bad), (e) => e.status === 400, bad);
  }
});

test('only the owner of the computer sees, opens or deletes them', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());
  const folder = path.join(host.stateDir, 'crew', 'shots');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'codex-game.png'), PNG);

  // Somebody without this computer's key: a friend who joined, or an agent calling in.
  const stranger = await fetch(`${host.url}/api/crew/shots`).then((r) => r.json());
  assert.equal(stranger.owner, false);
  assert.deepEqual(stranger.shots, []);
  assert.equal((await fetch(`${host.url}/api/crew/shots/codex-game.png`)).status, 403);
  assert.equal((await fetch(`${host.url}/api/crew/shots/codex-game.png`, { method: 'DELETE', headers: { 'X-Crew': '1' } })).status, 403);
  assert.ok(fs.existsSync(path.join(folder, 'codex-game.png')));

  const key = fs.readFileSync(path.join(host.stateDir, 'crew', 'machine.key'), 'utf8').trim();
  const paired = await fetch(`${host.url}/api/crew/this-computer/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: JSON.stringify({ key }) });
  const Cookie = paired.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crew_machine='));

  const mine = await fetch(`${host.url}/api/crew/shots`, { headers: { Cookie } }).then((r) => r.json());
  assert.equal(mine.owner, true);
  assert.deepEqual(mine.shots.map((s) => s.name), ['codex-game.png']);
  const img = await fetch(`${host.url}/api/crew/shots/codex-game.png`, { headers: { Cookie } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  const del = await fetch(`${host.url}/api/crew/shots/codex-game.png`, { method: 'DELETE', headers: { Cookie, 'X-Crew': '1' } });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(path.join(folder, 'codex-game.png')), false);
});
