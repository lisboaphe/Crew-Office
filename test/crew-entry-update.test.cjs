// Name-only entry and in-app updates. Entry runs against a real server; the updater runs
// against a stand-in for GitHub's releases API, serving real bytes and a real checksum.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startHost } = require('./lib/crew-harness.cjs');
const { createUpdater } = require('../lib/crew/update.cjs');

const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };

async function post(host, route, body, headers = {}, cookie = '') {
  const res = await fetch(host.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

test('a name and a colour make a player, and a name is never a way into someone else', async () => {
  const host = await startHost();
  try {
    const remote = await post(host, '/api/crew/enter', { name: 'Ana', color: '#2a9d8f' }, REMOTE);
    assert.equal(remote.status, 200);
    assert.equal(remote.data.user.displayName, 'Ana');
    assert.equal(remote.data.user.color, '#2a9d8f');
    assert.match(remote.cookie, /^crew_session=/, 'the browser is what remembers you');

    // The session it was given really is that player.
    const me = await (await fetch(`${host.url}/api/crew/me`, { headers: { Cookie: remote.cookie } })).json();
    assert.equal(me.user.id, remote.data.user.id);

    const impostor = await post(host, '/api/crew/enter', { name: 'ana' }, REMOTE);
    assert.notEqual(impostor.data.user.id, remote.data.user.id, 'another computer typing the name is someone new');

    assert.equal((await post(host, '/api/crew/enter', { name: '   ' }, REMOTE)).status, 400);
    assert.equal((await post(host, '/api/crew/enter', { name: '<>' }, REMOTE)).status, 400);

    // No password was set, and an empty one does not open it.
    const login = await post(host, '/api/crew/login', { username: remote.data.user.username, password: '' });
    assert.equal(login.status, 401);
  } finally { await host.stop(); }
});

const machineKey = (host) => fs.readFileSync(path.join(host.stateDir, 'crew', 'machine.key'), 'utf8').trim();

async function pair(host, key = machineKey(host), headers = {}) {
  const res = await fetch(`${host.url}/api/crew/this-computer/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1', ...headers }, body: JSON.stringify({ key }) });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: cookies.join('; '), machine: cookies.find((c) => c.startsWith('crew_machine=')) };
}

test('the app window is remembered as its player; being on this computer is not enough', async () => {
  const host = await startHost();
  try {
    // An agent on this computer, without the key, gets nowhere.
    assert.equal((await pair(host, 'x'.repeat(64))).status, 403);
    assert.equal((await post(host, '/api/crew/this-computer/player', { id: 'anyone' })).status, 403);
    assert.deepEqual(await (await fetch(`${host.url}/api/crew/this-computer`)).json(), { owner: false });
    assert.deepEqual((await (await fetch(`${host.url}/api/crew/me`)).json()).user, null, 'no session appears just for asking from here');

    const window1 = await pair(host);
    assert.equal(window1.status, 200);
    assert.equal(window1.data.user, null, 'nobody chosen yet');
    const first = await post(host, '/api/crew/enter', { name: 'Host Person' }, { Cookie: window1.machine });
    await post(host, '/api/crew/rooms', { name: 'Mine', privacy: 'invite' }, {}, first.cookie);

    // Without the key, the same name from this same computer is someone new.
    const noKey = await post(host, '/api/crew/enter', { name: 'Host Person' });
    assert.notEqual(noKey.data.user.id, first.data.user.id, 'an agent cannot take its owner’s identity by typing a name');

    // A new window, cookies gone: the key alone brings the same player back, with no name screen.
    const window2 = await pair(host);
    assert.equal(window2.data.user.id, first.data.user.id);
    assert.match(window2.cookie, /crew_session=/);
    const me = await (await fetch(`${host.url}/api/crew/me`, { headers: { Cookie: window2.cookie } })).json();
    assert.equal(me.user.id, first.data.user.id);

    // The key gets the app past the check only from this computer, not through a tunnel.
    assert.equal((await pair(host, machineKey(host), REMOTE)).status, 403);
    const tunnelled = await post(host, '/api/crew/enter', { name: 'Host Person' }, { ...REMOTE, Cookie: window2.machine });
    assert.notEqual(tunnelled.data.user.id, first.data.user.id, 'forwarded traffic arrives from loopback and is still somebody else');
    const list = await (await fetch(`${host.url}/api/crew/this-computer`, { headers: { Cookie: window2.machine } })).json();
    assert.equal(list.owner, true);
    assert.equal(list.current, first.data.user.id);
    assert.ok(list.players.find((p) => p.id === first.data.user.id).offices === 1);

    // Choosing another player sticks for the next window.
    const switched = await post(host, '/api/crew/this-computer/player', { id: noKey.data.user.id }, { Cookie: window2.machine });
    assert.equal(switched.data.user.id, noKey.data.user.id);
    assert.equal((await pair(host)).data.user.id, noKey.data.user.id);
  } finally { await host.stop(); }
});

test('deleting an office takes everything in it, only for its owner, and only by name', async () => {
  const host = await startHost();
  try {
    const owner = await post(host, '/api/crew/enter', { name: 'Owner' }, REMOTE);
    const stranger = await post(host, '/api/crew/enter', { name: 'Stranger' }, REMOTE);
    const { data: { room } } = await post(host, '/api/crew/rooms', { name: 'Doomed', privacy: 'invite' }, {}, owner.cookie);
    const { data: { room: other } } = await post(host, '/api/crew/rooms', { name: 'Keeper', privacy: 'invite' }, {}, owner.cookie);
    const R = `/api/crew/rooms/${room.id}`;
    const agent = await post(host, `${R}/agents`, { name: 'Ada', role: 'Engineer', provider: 'scripted', model: 'scripted' }, {}, owner.cookie);
    assert.equal(agent.status, 200, JSON.stringify(agent.data));
    await post(host, `/api/crew/rooms/${other.id}/agents`, { name: 'Bea', role: 'Engineer', provider: 'scripted', model: 'scripted' }, {}, owner.cookie);
    const project = await post(host, `${R}/projects`, { name: 'P', goal: 'G', managerAgentId: agent.data.agent.id }, {}, owner.cookie);
    assert.equal(project.status, 200, JSON.stringify(project.data));

    assert.equal((await post(host, `${R}/delete`, { confirm: 'Doomed' }, {}, stranger.cookie)).status, 403);
    assert.equal((await post(host, `${R}/delete`, { confirm: 'doomed' }, {}, owner.cookie)).status, 400, 'the name has to be typed exactly');
    assert.equal((await post(host, `${R}/delete`, {}, {}, owner.cookie)).status, 400);
    assert.equal((await post(host, `${R}/delete`, { confirm: 'Doomed' }, {}, owner.cookie)).status, 200);

    const gone = await fetch(`${host.url}/api/crew/rooms/by-code/${room.code}`, { headers: { Cookie: owner.cookie } });
    assert.equal(gone.status, 404);
    const { rooms } = await (await fetch(`${host.url}/api/crew/rooms`, { headers: { Cookie: owner.cookie } })).json();
    assert.deepEqual(rooms.map((r) => r.name), ['Keeper'], 'the other office is untouched');
    assert.equal((await post(host, `${R}/delete`, { confirm: 'Doomed' }, {}, owner.cookie)).status, 404);

    // No row anywhere still points at it, whatever table it lives in.
    await host.stop();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(host.stateDir, 'crew', 'crew.sqlite'), { readOnly: true });
    const leftovers = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (db.prepare(`PRAGMA table_info("${name}")`).all().some((c) => c.name === 'room_id') && db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE room_id = ?`).get(room.id).n) leftovers.push(name);
    }
    assert.deepEqual(leftovers, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id = ?').get(project.data.project.id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM agents WHERE name = 'Bea'").get().n, 1);
    db.close();
  } finally { await host.stop(); }
});

test('a deleted player takes their offices and leaves everyone else alone', async () => {
  const host = await startHost();
  try {
    const app = await pair(host);
    const keep = await post(host, '/api/crew/enter', { name: 'Keep' }, { Cookie: app.machine });
    const lose = await post(host, '/api/crew/enter', { name: 'Lose' }, REMOTE);
    const { data: { room: theirs } } = await post(host, '/api/crew/rooms', { name: 'Theirs', privacy: 'lan' }, {}, lose.cookie);
    const { data: { room: mine } } = await post(host, '/api/crew/rooms', { name: 'Mine', privacy: 'lan' }, {}, keep.cookie);
    await post(host, '/api/crew/rooms/join', { code: mine.code }, {}, lose.cookie);
    const R = `/api/crew/rooms/${mine.id}`;
    await post(host, `${R}/agents`, { name: 'Visitor', role: 'Engineer', provider: 'scripted', model: 'scripted' }, {}, lose.cookie);

    const del = (id, headers = {}) => fetch(`${host.url}/api/crew/this-computer/player/${id}`, { method: 'DELETE', headers: { 'X-Crew': '1', ...headers } });
    assert.equal((await del(lose.data.user.id)).status, 403, 'not without the key');
    assert.equal((await del(keep.data.user.id, { Cookie: app.machine })).status, 409, 'not the one you are');
    assert.equal((await del(lose.data.user.id, { Cookie: app.machine })).status, 200);

    assert.equal((await fetch(`${host.url}/api/crew/rooms/by-code/${theirs.code}`, { headers: { Cookie: keep.cookie } })).status, 404);
    const state = await (await fetch(`${host.url}${R}/state`, { headers: { Cookie: keep.cookie } })).json();
    assert.deepEqual(state.members.map((m) => m.displayName), ['Keep'], 'gone from the office they had joined');
    assert.deepEqual(state.agents, [], 'and so is their agent');
    assert.equal((await fetch(`${host.url}/api/crew/me`, { headers: { Cookie: lose.cookie } }).then((r) => r.json())).user, null);
  } finally { await host.stop(); }
});

test('a tunnel into the host, or a public hostname, is never the host at its keyboard', async () => {
  const host = await startHost();
  try {
    const app = await pair(host);
    const first = await post(host, '/api/crew/enter', { name: 'Host Person' }, { Cookie: app.machine });
    // fetch will not send a Host header of its choosing, and this one matters.
    const otherHostname = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ name: 'Host Person' });
      const req = http.request({ port: host.port, host: '127.0.0.1', path: '/api/crew/enter', method: 'POST', headers: { Host: 'office.example.com', Cookie: app.machine, 'Content-Type': 'application/json', 'X-Crew': '1', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve(JSON.parse(out)));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.notEqual(otherHostname.user.id, first.data.user.id, 'a public hostname pointed at this port is not the host at its keyboard');
  } finally { await host.stop(); }
});

test('an invitation link lets a name-only player in; a bare code to an invite-only office does not', async () => {
  const host = await startHost();
  try {
    const owner = await post(host, '/api/crew/enter', { name: 'Owner' });
    const { data: { room } } = await post(host, '/api/crew/rooms', { name: 'Private', privacy: 'invite' }, {}, owner.cookie);
    const { data: { invite } } = await post(host, `/api/crew/rooms/${room.id}/invites`, { role: 'member', uses: 2 }, {}, owner.cookie);
    const guest = await post(host, '/api/crew/enter', { name: 'Guest' }, REMOTE);
    assert.equal((await post(host, '/api/crew/rooms/join', { code: room.code }, REMOTE, guest.cookie)).status, 403);
    assert.equal((await post(host, '/api/crew/rooms/join', { invite: invite.code }, REMOTE, guest.cookie)).status, 200);
  } finally { await host.stop(); }
});

test('only the app on the host computer hears about updates or can install one', async () => {
  const host = await startHost();
  try {
    const remote = await (await fetch(`${host.url}/api/crew/update`, { headers: REMOTE })).json();
    assert.deepEqual(remote, { available: false });
    assert.equal((await post(host, '/api/crew/update/install', {}, REMOTE)).status, 403);
    assert.equal((await post(host, '/api/crew/update/install')).status, 403, 'not an agent on this computer either');
    const { machine } = await pair(host);
    const local = await (await fetch(`${host.url}/api/crew/update`, { headers: { Cookie: machine } })).json();
    assert.equal(local.enabled, false, 'a source checkout updates with git');
  } finally { await host.stop(); }
});

function installedCopy(stamp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-upd-'));
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify(stamp));
  fs.mkdirSync(path.join(root, 'installer', 'windows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'installer', 'windows', 'install.ps1'), '# the installer\n');
  fs.mkdirSync(path.join(root, 'installer', 'unix'), { recursive: true });
  fs.writeFileSync(path.join(root, 'installer', 'unix', 'install.sh'), '# the unix installer\n');
  return root;
}

async function fakeGitHub({ tag = 'build-7', zip = Buffer.from('the new app'), checksum, status = 200 } = {}) {
  const hash = checksum ?? crypto.createHash('sha256').update(zip).digest('hex');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/repos/me/app/releases/latest') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: tag, html_url: `${base}/page`, assets: [{ name: 'CrewOffice.zip', browser_download_url: `${base}/zip` }, { name: 'CrewOffice.zip.sha256', browser_download_url: `${base}/sum` }] }));
    }
    if (req.url === '/zip') return res.end(zip);
    if (req.url === '/sum') return res.end(`${hash}  CrewOffice.zip`);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('a copy with no repository in its stamp still finds its updates, from package.json', async () => {
  const github = await fakeGitHub();
  try {
    const root = installedCopy({ build: 0, commit: 'abc', repo: null });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ repository: { type: 'git', url: 'https://github.com/me/app.git' } }));
    const s = await createUpdater({ root, apiBase: github.base, platform: 'win32' }).status();
    assert.equal(s.enabled, true);
    assert.equal(s.repo, 'me/app');
    assert.equal(s.available, true, 'and it is offered the release');

    const fork = installedCopy({ build: 0, commit: 'abc', repo: 'a-fork/project' });
    fs.writeFileSync(path.join(fork, 'package.json'), JSON.stringify({ repository: 'https://github.com/someone/project' }));
    assert.equal((await createUpdater({ root: fork, apiBase: github.base, platform: 'win32' }).status()).repo, 'a-fork/project', 'a fork’s stamp wins');

    const lost = installedCopy({ build: 0, commit: 'abc', repo: null });
    const nowhere = await createUpdater({ root: lost, apiBase: github.base, platform: 'win32' }).status();
    assert.equal(nowhere.enabled, false);
    assert.match(nowhere.reason, /Download the latest version/, 'and with neither, it says what to do');
  } finally { github.close(); }
});

test('this project’s own package.json names where its releases are', () => {
  const root = installedCopy({ build: 0, repo: null });
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(root, 'package.json'));
  assert.equal(createUpdater({ root }).build.repo, 'lisboaphe/Crew-Office');
});

test('the updater offers only a newer build, and says so plainly when it cannot look', async () => {
  const root = installedCopy({ build: 6, commit: 'abc', repo: 'me/app' });
  const newer = await fakeGitHub();
  const same = await fakeGitHub({ tag: 'build-6' });
  const none = await fakeGitHub({ status: 404 });
  const down = await fakeGitHub({ status: 500 });
  try {
    const s = await createUpdater({ root, apiBase: newer.base, platform: 'win32' }).status();
    assert.equal(s.available, true);
    assert.equal(s.latest.build, 7);
    assert.equal(s.canInstall, true);
    assert.equal((await createUpdater({ root, apiBase: same.base, platform: 'win32' }).status()).available, false);
    assert.equal((await createUpdater({ root, apiBase: none.base, platform: 'win32' }).status()).available, false);
    const broken = await createUpdater({ root, apiBase: down.base, platform: 'win32' }).status();
    assert.equal(broken.available, false);
    assert.match(broken.error, /500/);
    const linux = await createUpdater({ root, apiBase: newer.base, platform: 'linux' }).status();
    assert.equal(linux.canInstall, true);
    assert.equal(linux.available, true);
    const mac = await createUpdater({ root, apiBase: newer.base, platform: 'darwin' }).status();
    assert.equal(mac.canInstall, false, 'offered honestly as a download where installing is not built');
    assert.equal(mac.available, true);
  } finally { for (const s of [newer, same, none, down]) s.close(); }
});

test('a download that does not match its checksum is never handed to the installer', async () => {
  const root = installedCopy({ build: 1, repo: 'me/app' });
  const bad = await fakeGitHub({ checksum: '0'.repeat(64) });
  let launched = null;
  try {
    const updater = createUpdater({ root, apiBase: bad.base, platform: 'win32', launchInstaller: (a) => { launched = a; } });
    await assert.rejects(updater.install(), /checksum/);
    assert.equal(launched, null);
  } finally { bad.close(); }
});

test('a verified download reaches the installer, with a copy of the script that outlives the folder', async () => {
  const root = installedCopy({ build: 1, repo: 'me/app' });
  const good = await fakeGitHub();
  let launched = null;
  try {
    const updater = createUpdater({ root, apiBase: good.base, platform: 'win32', dataDir: root, launchInstaller: (a) => { launched = a; } });
    assert.equal((await updater.install({ waitPid: 1234, appArgs: ['--private'] })).build, 7);
    assert.equal(fs.readFileSync(launched.zipFile, 'utf8'), 'the new app');
    assert.ok(!launched.script.startsWith(root), 'the script cannot run from the folder it replaces');
    assert.equal(launched.target, root);
    assert.equal(launched.waitPid, 1234);
    assert.deepEqual(launched.appArgs, ['--private']);
    await assert.rejects(updater.install(), /already being installed/);
  } finally { good.close(); }
});

test('on Linux a verified download reaches the shell installer, copied out of the folder it replaces', async () => {
  const root = installedCopy({ build: 1, repo: 'me/app' });
  const good = await fakeGitHub();
  let launched = null;
  try {
    const updater = createUpdater({ root, apiBase: good.base, platform: 'linux', dataDir: root, launchInstaller: (a) => { launched = a; } });
    assert.equal((await updater.install({ waitPid: 1234 })).build, 7);
    assert.equal(fs.readFileSync(launched.script, 'utf8'), '# the unix installer\n');
    assert.ok(!launched.script.startsWith(root));
  } finally { good.close(); }
});

// The real script against a real folder, in a throwaway home. It needs unzip and a Unix shell.
const unixInstall = path.join(__dirname, '..', 'installer', 'unix', 'install.sh');
const canRunInstaller = process.platform !== 'win32' && spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;

function installerFixture(appBody = "require('fs').writeFileSync(process.argv[2] ?? 'started', 'started')") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-inst-'));
  const target = path.join(home, 'app');
  fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(target, 'bin', 'crew-app.cjs'), '// the old build\n');
  fs.writeFileSync(path.join(target, 'old-only.txt'), 'old');
  fs.writeFileSync(path.join(target, '.env'), 'PORT=9999\n');
  const stage = path.join(home, 'stage');
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'bin', 'crew-app.cjs'), `${appBody}\n`);
  fs.writeFileSync(path.join(stage, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  const zip = path.join(home, 'new.zip');
  assert.equal(spawnSync('zip', ['-qr', zip, '.'], { cwd: stage }).status, 0, 'zip builds the fixture');
  return { home, target, zip };
}

function runInstaller({ home, target }, ...args) {
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'share') };
  return spawnSync('/bin/sh', [unixInstall, ...args, '--target', target], { env, encoding: 'utf8', timeout: 60_000 });
}

const hasZip = canRunInstaller && spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;

test('the Unix installer swaps in the new copy, keeps .env, and restarts the app', { skip: !hasZip }, async () => {
  const fx = installerFixture();
  const r = runInstaller(fx, fx.zip, '--relaunch', '--app-args', path.join(fx.home, 'relaunched'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(fx.target, 'bin', 'crew-app.cjs'), 'utf8'), /started/);
  assert.equal(fs.existsSync(path.join(fx.target, 'old-only.txt')), false, 'nothing of the old copy but its settings');
  assert.equal(fs.readFileSync(path.join(fx.target, '.env'), 'utf8'), 'PORT=9999\n');
  assert.equal(fs.existsSync(`${fx.target}.new`), false);
  assert.equal(fs.existsSync(`${fx.target}.old`), false);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(fx.home, 'relaunched')); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(fs.existsSync(path.join(fx.home, 'relaunched')), 'the app was started again');
});

test('a bad package leaves the Unix install whole and still restarts the old app', { skip: !hasZip }, async () => {
  const fx = installerFixture();
  const marker = path.join(fx.home, 'old-relaunched');
  fs.writeFileSync(path.join(fx.target, 'bin', 'crew-app.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')\n`);
  const garbage = path.join(fx.home, 'garbage.zip');
  fs.writeFileSync(garbage, 'not a zip');
  const r = runInstaller(fx, garbage, '--relaunch');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not updated/);
  assert.equal(fs.readFileSync(path.join(fx.target, 'old-only.txt'), 'utf8'), 'old', 'the old copy is untouched');
  assert.equal(fs.existsSync(`${fx.target}.new`), false);
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(fs.existsSync(marker), 'the old app came back');
});

test('the Unix installer changes nothing while the app it replaces is still running', { skip: !hasZip, timeout: 60_000 }, () => {
  const fx = installerFixture();
  // Replaces `sleep`, so the 30-second wait passes at once while the process stays alive.
  const bin = path.join(fx.home, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HOME: fx.home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = spawnSync('/bin/sh', [unixInstall, fx.zip, '--target', fx.target, '--wait-pid', String(process.pid)], { env, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /did not stop/);
  assert.equal(fs.readFileSync(path.join(fx.target, 'old-only.txt'), 'utf8'), 'old');
});
