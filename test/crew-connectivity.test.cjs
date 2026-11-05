// Automatic internet hosting: Host Office finds the service by itself, proves the room is reachable,
// and invitations and room codes resolve through it. Real relay and host processes, real sockets,
// and hosts that listen on loopback only, so a friend can only ever have come through the relay.
//
// All on one computer. It proves the protocol, the permissions and the failure handling. It says
// nothing about real routers, CGNAT, DNS or certificates: docs/security/SECURITY_TESTS.md lists
// what still needs two real connections and a deployed service.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startHost, player, waitFor } = require('./lib/crew-harness.cjs');
const { parseInvitation, normalizeCode, codeHash, safeOrigin, joinUrl, mintShortCode, appLink } = require('../lib/relay/invitation.cjs');
const { TYPE, frame } = require('../lib/relay/frames.cjs');

async function startRelay(t, env = {}, port = 9000 + Math.floor(Math.random() * 400)) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'crew-relay.cjs'), String(port)], { env: { ...process.env, CREW_RELAY_KEY: '', CREW_RELAY_OPEN: '1', ...env }, stdio: 'ignore' });
  const relay = { port, url: `http://127.0.0.1:${port}`, child, stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); }) };
  t.after(() => relay.stop());
  await waitFor(async () => { try { return (await fetch(`${relay.url}/_relay/health`)).ok; } catch { return false; } }, { what: 'the relay', timeout: 8000 });
  return relay;
}

const tunnels = async (relay) => (await (await fetch(`${relay.url}/_relay/health`)).json()).tunnels;

async function ownerOf(host) {
  const key = fs.readFileSync(path.join(host.stateDir, 'crew', 'machine.key'), 'utf8').trim();
  const res = await fetch(`${host.url}/api/crew/this-computer/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: JSON.stringify({ key }) });
  const machine = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crew_machine='));
  const call = async (method, p, body) => {
    const r = await fetch(host.url + p, { method, headers: { 'Content-Type': 'application/json', 'X-Crew': '1', Cookie: call.cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('crew_session='));
    if (set) call.cookie = `${machine}; ${set}`;
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  call.cookie = machine;
  await call('POST', '/api/crew/enter', { name: 'Host' });
  return call;
}

async function hostingApp(t, relay, env = {}) {
  const host = await startHost({ env: { ...(relay ? { CREW_CONNECTIVITY_URL: relay.url } : {}), ...env } });
  t.after(() => host.stop());
  return { host, owner: await ownerOf(host) };
}

async function hostOffice(owner, opts = {}) {
  const { room } = await owner('POST', '/api/crew/rooms', { name: 'Internet office', privacy: 'invite', maxPlayers: 4, ...opts });
  const started = await owner('POST', `/api/crew/rooms/${room.id}/hosting`, { on: true });
  assert.strictEqual(started.status, 200, JSON.stringify(started));
  return room;
}

const available = (owner, room) => waitFor(async () => {
  const s = await owner('GET', `/api/crew/rooms/${room.id}/hosting`);
  return s.link && s.invite?.shortCode ? s : null;
}, { what: 'the room to be available, with a link and a code', timeout: 15_000 });

test('an invitation is only what it should be, whatever is pasted or clicked', () => {
  assert.deepStrictEqual(parseInvitation('abcde-fghjk'), { kind: 'code', code: 'ABCDEFGHJK' });
  assert.strictEqual(normalizeCode(' o1l2i-3456 7 '.replace(' 7', '7')), '01121' + '34567');
  const token = 'a'.repeat(16);
  assert.deepStrictEqual(parseInvitation(`crewoffice://join?host=${encodeURIComponent('https://x.example.org')}&invite=${token}`), { kind: 'invite', origin: 'https://x.example.org', invite: token });
  assert.deepStrictEqual(parseInvitation('crewoffice://join/ABCDE-FGHJK'), { kind: 'code', code: 'ABCDEFGHJK' });
  // Windows adds the slash before the query when it hands a link to the handler.
  assert.deepStrictEqual(parseInvitation(`crewoffice://join/?host=${encodeURIComponent('https://x.example.org')}&invite=${token}`), { kind: 'invite', origin: 'https://x.example.org', invite: token });
  assert.deepStrictEqual(parseInvitation(`https://x.example.org/crew/join?invite=${token}`), { kind: 'invite', origin: 'https://x.example.org', invite: token });
  assert.deepStrictEqual(parseInvitation(appLink('https://x.example.org', token)), { kind: 'invite', origin: 'https://x.example.org', invite: token });
  assert.strictEqual(joinUrl({ kind: 'invite', origin: 'https://x.example.org', invite: token }), `https://x.example.org/crew/join?invite=${token}`);

  for (const bad of [
    '', 'hello', 'javascript:alert(1)', 'file:///c:/windows/system32/cmd.exe', 'data:text/html,hi',
    `crewoffice://evil?host=https://x.example.org&invite=${token}`,
    `crewoffice://join?host=javascript:alert(1)&invite=${token}`,
    `crewoffice://join?host=file:///etc/passwd&invite=${token}`,
    `crewoffice://join?host=${encodeURIComponent('https://user:pw@x.example.org')}&invite=${token}`,
    `crewoffice://join?host=${encodeURIComponent('http://plain.example.org')}&invite=${token}`,
    'crewoffice://join?host=https://x.example.org&invite=short',
    `crewoffice://join?host=https://x.example.org&invite=${token}" --serve`,
    `http://plain.example.org/crew/join?invite=${token}`,
    `https://x.example.org/crew/join?invite=${'../'.repeat(8)}`,
    `https://x.example.org/\n/crew/join?invite=${token}`,
    'x'.repeat(5000),
  ]) assert.strictEqual(parseInvitation(bad), null, `refused: ${bad.slice(0, 60)}`);

  assert.strictEqual(safeOrigin('http://192.168.1.20:8080/x'), 'http://192.168.1.20:8080', 'plain http is for private networks');
  assert.strictEqual(safeOrigin('http://8.8.8.8/'), null);
  const codes = new Set(Array.from({ length: 2000 }, mintShortCode));
  assert.strictEqual(codes.size, 2000, 'codes do not repeat');
  for (const c of codes) assert.strictEqual(normalizeCode(c), c, 'and can all be typed back in');
});

test('with no service deployed it says so, and offers nothing that would not work', { timeout: 30_000 }, async (t) => {
  const { owner, host } = await hostingApp(t, null);
  assert.strictEqual((await owner('GET', '/api/crew/internet')).state, 'off', 'hosting nothing: local');
  const room = await hostOffice(owner);
  const s = await owner('GET', `/api/crew/rooms/${room.id}/hosting`);
  assert.strictEqual(s.internet.state, 'unavailable');
  assert.strictEqual(s.internet.label, 'Internet service unavailable');
  assert.strictEqual(s.internet.blocker, 'no-service');
  assert.match(s.internet.reason, /no internet service set up/);
  assert.strictEqual(s.link, null);
  assert.strictEqual(s.appLink, null);
  assert.strictEqual(s.invite.shortCode, null, 'and no code that could not resolve');
  const looked = await owner('POST', '/api/crew/invitations/resolve', { text: 'ABCDE-FGHJK' });
  assert.strictEqual(looked.status, 503);
  assert.match(looked.error, /invitation link/);
  assert.ok(!/relay\.example|example\.org/.test(host.log()), 'no made-up address anywhere in what it logged');
});

test('Host Office: finds the service, proves the room, and a friend joins by link or by code', { timeout: 60_000 }, async (t) => {
  const relay = await startRelay(t);
  const { owner, host } = await hostingApp(t, relay);

  assert.strictEqual((await owner('GET', '/api/crew/internet')).state, 'off');
  const { room: idle } = await owner('POST', '/api/crew/rooms', { name: 'Not hosted', privacy: 'invite' });
  assert.strictEqual(await tunnels(relay), 0, 'an office not being hosted is not on the internet');

  const room = await hostOffice(owner);
  const s = await available(owner, room);
  assert.strictEqual(s.internet.state, 'online');
  assert.strictEqual(s.internet.label, 'Internet room available');
  assert.strictEqual(s.internet.transport, 'relay');
  assert.strictEqual(s.internet.verified, true);
  assert.strictEqual(s.internet.source, 'automatic');
  assert.ok(s.link.startsWith(`${relay.url}/crew/join?invite=`));
  assert.ok(s.appLink.startsWith('crewoffice://join?'));
  assert.match(s.invite.shortCode, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  assert.deepStrictEqual(parseInvitation(s.appLink), { kind: 'invite', origin: relay.url, invite: s.invite.code });

  // The friend, by the link: sees who invited them before deciding, then is in.
  const friend = player(relay.url);
  t.after(() => friend.leaveAll());
  const preview = await friend.get(`/api/crew/invitations/preview?invite=${s.invite.code}`);
  assert.strictEqual(preview.room.name, 'Internet office');
  assert.strictEqual(preview.room.hostName, 'Host');
  assert.strictEqual(preview.room.needsPassword, false);
  await friend.post('/api/crew/enter', { name: 'Friend' });
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { code: room.code })).status, 403, 'its keycard alone is not enough');
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { invite: s.invite.code })).status, 200);
  const live = await friend.enter(room.id);
  await waitFor(() => live.events.length > 0, { what: 'live events through the relay', timeout: 5000 });
  const after = await available(owner, room);
  assert.ok(after.players.some((p) => p.displayName === 'Friend' && p.online), 'the host sees them connected');
  assert.strictEqual(after.invite.usesLeft, s.invite.usesLeft - 1, 'and the invitation is counted');

  // A second friend, with their own copy of the app and only the code.
  const { owner: second } = await hostingApp(t, relay);
  const found = await second('POST', '/api/crew/invitations/resolve', { text: s.invite.shortCode.toLowerCase() });
  assert.strictEqual(found.status, 200, JSON.stringify(found));
  assert.strictEqual(found.transport, 'relay');
  assert.strictEqual(found.room.name, 'Internet office');
  assert.strictEqual(found.url, `${relay.url}/crew/join?code=${s.invite.shortCode}`);
  const other = player(relay.url);
  await other.post('/api/crew/enter', { name: 'Second' });
  assert.strictEqual((await other.post('/api/crew/rooms/join', { shortCode: s.invite.shortCode })).status, 200);

  // Second friend's app also opens the host's link, after checking it.
  assert.strictEqual((await second('POST', '/api/crew/invitations/resolve', { text: s.appLink })).room.hostName, 'Host');
  assert.strictEqual((await second('POST', '/api/crew/invitations/resolve', { text: 'ZZZZZ-ZZZZZ' })).status, 404, 'an unknown code is not found');

  // The office that was never hosted is not reachable through the same tunnel, invitation or not.
  const { invite: stray } = await owner('POST', `/api/crew/rooms/${idle.id}/invites`, { role: 'member', uses: 2, short: true });
  const outsider = player(relay.url);
  await outsider.post('/api/crew/enter', { name: 'Stray' });
  assert.strictEqual((await outsider.post('/api/crew/rooms/join', { invite: stray.code })).status, 403);
  assert.strictEqual((await outsider.get(`/api/crew/invitations/preview?invite=${stray.code}`)).error !== undefined, true);

  // What only the host's own keyboard may do.
  assert.strictEqual((await outsider.post(`/api/crew/rooms/${room.id}/hosting`, { on: false })).status, 403, 'a visitor cannot stop it');
  assert.strictEqual((await fetch(`${relay.url}/api/crew/invitations/resolve`, { method: 'POST', headers: { 'X-Crew': '1' } })).status, 404, 'nor use this host to look things up');
  assert.strictEqual((await fetch(`${relay.url}/api/crew/relay-probe?nonce=guess`)).status, 404);
  assert.strictEqual((await fetch(`${host.url}/api/crew/relay-probe?nonce=guess`)).status, 404);

  // Revoke: link and code stop at once, and the people already inside stay.
  assert.strictEqual((await owner('DELETE', `/api/crew/rooms/${room.id}/invites/${encodeURIComponent(s.invite.code)}`)).status, 200);
  const late = player(relay.url);
  await late.post('/api/crew/enter', { name: 'Late' });
  assert.strictEqual((await late.post('/api/crew/rooms/join', { invite: s.invite.code })).status, 403);
  assert.strictEqual((await late.post('/api/crew/rooms/join', { shortCode: s.invite.shortCode })).status, 403);
  await waitFor(async () => (await fetch(`${relay.url}/_relay/resolve/${s.invite.shortCode}`)).status === 404, { what: 'the service to forget the code', timeout: 5000 });
  assert.strictEqual((await friend.get(`/api/crew/rooms/${room.id}/state`)).room?.name, 'Internet office', 'friends already in stay');
  assert.strictEqual((await owner('GET', `/api/crew/rooms/${room.id}/hosting`)).link, null, 'and no link is shown');

  // A new one works. Removing a player cancels it, since a name costs nothing.
  const fresh = (await owner('POST', `/api/crew/rooms/${room.id}/hosting`, { on: true }));
  assert.ok(fresh.invite.code && fresh.invite.code !== s.invite.code);
  const fid = (await friend.get('/api/crew/me')).user.id;
  assert.strictEqual((await owner('DELETE', `/api/crew/rooms/${room.id}/members/${fid}`)).status, 200);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { invite: fresh.invite.code })).status, 403);

  // Stop Hosting: the connection goes, and everything is kept.
  await owner('POST', `/api/crew/rooms/${room.id}/hosting`, { on: true });
  const stopped = await owner('POST', `/api/crew/rooms/${room.id}/hosting`, { on: false });
  assert.strictEqual(stopped.link, null);
  await waitFor(async () => (await tunnels(relay)) === 0, { what: 'the tunnel to close', timeout: 5000 });
  assert.strictEqual((await owner('GET', '/api/crew/internet')).state, 'off');
  assert.strictEqual((await owner('GET', `/api/crew/rooms/${room.id}/state`)).room.name, 'Internet office');
  assert.strictEqual((await fetch(`${relay.url}/crew`)).status, 503);
});

test('a room code in a password office asks for the password; a link does not', { timeout: 30_000 }, async (t) => {
  const relay = await startRelay(t);
  const { owner } = await hostingApp(t, relay);
  const room = await hostOffice(owner, { privacy: 'password', password: 'open sesame' });
  const s = await available(owner, room);
  const friend = player(relay.url);
  await friend.post('/api/crew/enter', { name: 'Friend' });
  assert.strictEqual((await friend.get(`/api/crew/invitations/preview?code=${s.invite.shortCode}`)).room.needsPassword, true);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { shortCode: s.invite.shortCode })).status, 401);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { shortCode: s.invite.shortCode, password: 'wrong' })).status, 401);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { shortCode: s.invite.shortCode, password: 'open sesame' })).status, 200);
  assert.strictEqual((await friend.post('/api/crew/rooms/join', { invite: s.invite.code })).status, 200, 'already a member');
});

test('a tunnel is not a room: if visitors cannot get there, nothing says they can', { timeout: 40_000 }, async (t) => {
  // relay.test does not resolve, the way a missing wildcard DNS record would fail in real life.
  const relay = await startRelay(t, { CREW_RELAY_DOMAIN: 'relay.test' });
  const { owner } = await hostingApp(t, relay);
  const room = await hostOffice(owner);
  await waitFor(async () => (await tunnels(relay)) === 1, { what: 'the tunnel', timeout: 8000 });
  const s = await waitFor(async () => { const x = await owner('GET', `/api/crew/rooms/${room.id}/hosting`); return x.internet.state === 'unavailable' ? x : null; }, { what: 'the check to fail', timeout: 20_000 });
  assert.match(s.internet.reason, /a visitor could not reach this office/);
  assert.strictEqual(s.link, null);
  assert.strictEqual(s.invite.shortCode, null);
  assert.notStrictEqual(s.internet.label, 'Internet room available');
});

function raw(port, hostname, p, opts = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: hostname, ...opts } }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); }).on('error', reject);
  });
}

test('with a domain: each office its own name, and the service’s own address takes a code', { timeout: 40_000 }, async (t) => {
  const relay = await startRelay(t, { CREW_RELAY_DOMAIN: 'relay.test' });
  const { owner } = await hostingApp(t, relay, { CREW_RELAY_PROBE_VIA: '127.0.0.1' });
  const room = await hostOffice(owner);
  const s = await available(owner, room);
  const name = new URL(s.internet.url).hostname;
  assert.match(name, /^[a-z0-9]{20,}\.relay\.test$/);
  const apex = `relay.test:${relay.port}`;

  const looked = JSON.parse((await raw(relay.port, apex, `/_relay/resolve/${s.invite.shortCode}`)).body);
  assert.strictEqual(new URL(looked.url).hostname, name, 'the code leads to that office');
  const hop = await raw(relay.port, apex, `/j/${s.invite.shortCode}`);
  assert.strictEqual(hop.status, 302);
  assert.strictEqual(hop.headers.location, `http://${name}:${relay.port}/crew/join?code=${s.invite.shortCode}`);
  assert.match((await raw(relay.port, apex, '/')).body, /room code/);
  assert.strictEqual((await raw(relay.port, apex, '/j/ZZZZZ-ZZZZZ')).status, 404);

  // A friend who followed that redirect: their browser's cookies are for that name alone.
  assert.strictEqual((await raw(relay.port, `${name}:${relay.port}`, '/crew/join')).status, 200);
  const ask = (domain) => raw(relay.port, apex, `/_relay/tls-check?domain=${domain}`).then((r) => r.status);
  assert.strictEqual(await ask(name), 200, 'a certificate for an office that exists');
  assert.strictEqual(await ask('someoneelse.relay.test'), 404, 'and not for one made up');
  assert.strictEqual(await ask('evil.example.org'), 404);
});

test('when the service restarts, the room comes back by itself at the same address and code', { timeout: 60_000 }, async (t) => {
  const relayPort = 9500 + Math.floor(Math.random() * 300);
  const relay = await startRelay(t, { CREW_RELAY_DOMAIN: 'relay.test' }, relayPort);
  const { owner } = await hostingApp(t, relay, { CREW_RELAY_PROBE_VIA: '127.0.0.1' });
  const room = await hostOffice(owner);
  const s = await available(owner, room);

  await relay.stop();
  const down = await waitFor(async () => { const x = await owner('GET', `/api/crew/rooms/${room.id}/hosting`); return x.internet.state !== 'online' ? x : null; }, { what: 'the host to notice', timeout: 10_000 });
  assert.ok(['reconnecting', 'unavailable'].includes(down.internet.state));
  assert.strictEqual(down.link, null, 'never a link while it is down');

  const back = await startRelay(t, { CREW_RELAY_DOMAIN: 'relay.test' }, relayPort);
  const again = await waitFor(async () => { const x = await owner('GET', `/api/crew/rooms/${room.id}/hosting`); return x.link && x.invite?.shortCode ? x : null; }, { what: 'recovery', timeout: 45_000 });
  assert.strictEqual(again.link, s.link, 'the invitation already sent still works');
  const looked = await raw(back.port, `relay.test:${back.port}`, `/_relay/resolve/${s.invite.shortCode}`);
  assert.strictEqual(looked.status, 200, 'and so does the code, which the host told it again');
});

function dial(relay, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: '/_relay/connect', headers: { Connection: 'Upgrade', Upgrade: 'crew-relay', ...headers } });
    req.on('upgrade', (res, sock) => resolve({ status: 101, sock, res }));
    req.on('response', (r) => { r.resume(); resolve({ status: r.statusCode }); });
    req.on('error', () => resolve({ status: 'closed' }));
    req.end();
  });
}

test('the service holds up against a hostile host, and has limits', { timeout: 40_000 }, async (t) => {
  const relay = await startRelay(t, { CREW_RELAY_TUNNELS_PER_IP: '2', CREW_RELAY_DOMAIN: 'relay.test', CREW_RELAY_METRICS_KEY: 'metrics-key-0123456789', CREW_RELAY_DAILY_MB: '0.001', CREW_RELAY_RESOLVE_RATE: '5' });
  const info = await (await fetch(`${relay.url}/_relay/info`)).json();
  assert.strictEqual(info.service, 'crew-relay');
  assert.strictEqual(info.needsKey, false);
  assert.strictEqual(info.open, true);

  const first = await dial(relay);
  assert.strictEqual(first.status, 101);
  const second = await dial(relay);
  assert.strictEqual(second.status, 101);
  assert.strictEqual((await dial(relay)).status, 429, 'offices per address are limited');
  second.sock.destroy();

  // A browser asks; the host answers with rubbish. That is one bad office, not a dead relay.
  const name = first.res.headers['x-crew-tunnel-id'];
  const asked = new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: relay.port, path: '/crew', headers: { Host: `${name}.relay.test` } }, resolve);
    r.on('error', () => resolve(null));
  });
  await new Promise((resolve) => { first.sock.once('data', resolve); });
  first.sock.write(frame(TYPE.RESPONSE, 2, Buffer.from('{not json')));
  await asked;
  assert.strictEqual((await fetch(`${relay.url}/_relay/health`)).status, 200, 'the relay is still up');
  await waitFor(async () => (await tunnels(relay)) === 0, { what: 'the bad host to be dropped', timeout: 5000 });

  // Publishing codes needs the tunnel's secret.
  const third = await dial(relay);
  const id = third.res.headers['x-crew-tunnel-id'];
  const secret = third.res.headers['x-crew-tunnel-secret'];
  const put = (headers, codes) => fetch(`${relay.url}/_relay/codes`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ codes }) });
  const hash = codeHash('ABCDEFGHJK');
  assert.strictEqual((await put({ 'X-Crew-Tunnel-Id': id, 'X-Crew-Tunnel-Secret': 'wrong' }, [])).status, 403);
  assert.strictEqual((await put({ 'X-Crew-Tunnel-Id': id, 'X-Crew-Tunnel-Secret': secret }, [{ hash, expiresAt: Date.now() + 60_000 }])).status, 200);

  // A second office cannot take a code already held.
  const fourth = await dial(relay);
  const stolen = await (await put({ 'X-Crew-Tunnel-Id': fourth.res.headers['x-crew-tunnel-id'], 'X-Crew-Tunnel-Secret': fourth.res.headers['x-crew-tunnel-secret'] }, [{ hash, expiresAt: Date.now() + 60_000 }])).json();
  assert.deepStrictEqual(stolen.conflicts, [hash]);
  fourth.sock.destroy();

  // Metrics are for whoever runs it, and hold no codes or full tunnel names.
  assert.strictEqual((await fetch(`${relay.url}/_relay/metrics`)).status, 401);
  const m = await (await fetch(`${relay.url}/_relay/metrics`, { headers: { Authorization: 'Bearer metrics-key-0123456789' } })).json();
  assert.ok(m.tunnels.connected >= 1);
  assert.ok(!JSON.stringify(m).includes(id));
  assert.ok(!JSON.stringify(m).includes(hash));

  // Guessing codes runs out quickly.
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await fetch(`${relay.url}/_relay/resolve/${mintShortCode()}`)).status);
  assert.ok(statuses.includes(429), `guesses are limited: ${statuses}`);

  // The daily allowance: this relay allows about a kilobyte, so a real request uses it up.
  const answer = new Promise((resolve) => {
    third.sock.on('data', () => {
      third.sock.write(frame(TYPE.RESPONSE, 2, { status: 200, headers: {} }));
      third.sock.write(frame(TYPE.DATA, 2, Buffer.alloc(4096)));
      third.sock.write(frame(TYPE.END, 2));
      resolve();
    });
  });
  const big = await raw(relay.port, `${id}.relay.test`, '/x');
  await answer;
  assert.strictEqual(big.status, 200);
  assert.strictEqual((await raw(relay.port, `${id}.relay.test`, '/x')).status, 429, 'over its allowance');
  third.sock.destroy();
  first.sock.destroy();
});

test('one visitor reading slowly holds up nobody else', { timeout: 30_000 }, async (t) => {
  const relay = await startRelay(t, { CREW_RELAY_DOMAIN: 'relay.test' });
  const host = await dial(relay);
  const name = `${host.res.headers['x-crew-tunnel-id']}.relay.test`;
  const seen = [];
  let buffered = Buffer.alloc(0);
  host.sock.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 9 && buffered.length >= 9 + buffered.readUInt32BE(5)) {
      const length = buffered.readUInt32BE(5);
      seen.push({ type: buffered.readUInt8(0), stream: buffered.readUInt32BE(1) });
      buffered = buffered.subarray(9 + length);
    }
  });

  // The first visitor asks for something large, and never reads it.
  const net = require('net');
  const slow = net.connect(relay.port, '127.0.0.1');
  t.after(() => slow.destroy());
  slow.on('error', () => {}); // reset when the host below hangs up, which is the right thing to do
  slow.pause();
  slow.write(`GET /big HTTP/1.1\r\nHost: ${name}\r\nConnection: keep-alive\r\n\r\n`);
  await waitFor(() => seen.some((f) => f.type === TYPE.OPEN), { what: 'the request to reach the host', timeout: 5000 });
  const bigStream = seen.find((f) => f.type === TYPE.OPEN).stream;
  host.sock.write(frame(TYPE.RESPONSE, bigStream, { status: 200, headers: {} }));
  const chunk = Buffer.alloc(64 * 1024);
  await waitFor(async () => {
    for (let i = 0; i < 64; i++) host.sock.write(frame(TYPE.DATA, bigStream, chunk));
    await new Promise((r) => setTimeout(r, 30));
    return seen.some((f) => f.type === TYPE.PAUSE && f.stream === bigStream);
  }, { what: 'the relay to ask for that stream to be held', timeout: 15_000 });

  // The second visitor still gets an answer through the same connection.
  const other = raw(relay.port, name, '/small');
  await waitFor(() => seen.filter((f) => f.type === TYPE.OPEN).length === 2, { what: 'the second request', timeout: 5000 });
  const smallStream = seen.filter((f) => f.type === TYPE.OPEN)[1].stream;
  host.sock.write(frame(TYPE.RESPONSE, smallStream, { status: 200, headers: {} }));
  host.sock.write(frame(TYPE.DATA, smallStream, Buffer.from('hello')));
  host.sock.write(frame(TYPE.END, smallStream));
  const answered = await Promise.race([other, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.strictEqual(answered?.body, 'hello', 'not held up behind the slow one');

  // And when the slow one starts reading, its own download is let go again.
  slow.resume();
  await waitFor(() => seen.some((f) => f.type === TYPE.RESUME && f.stream === bigStream), { what: 'the stream to be let go', timeout: 10_000 });
  host.sock.destroy();
});

test('a room code heard on this network leads straight to its host, and only by its slow hash', { timeout: 15_000 }, async (t) => {
  const dgram = require('dgram');
  const { lanCodeHash } = require('../lib/relay/invitation.cjs');
  const port = 42000 + Math.floor(Math.random() * 2000);
  process.env.CREW_LAN_PORT = String(port);
  delete require.cache[require.resolve('../lib/crew/lan.cjs')];
  const { createLan } = require('../lib/crew/lan.cjs');
  delete process.env.CREW_LAN_PORT;
  const lan = createLan({ getRooms: () => [], port: 1 });
  lan.start();
  t.after(() => lan.stop());
  await new Promise((r) => setTimeout(r, 200));

  const code = 'ABCDEFGHJK';
  const hash = lanCodeHash(code);
  assert.strictEqual(hash.length, 32);
  assert.notStrictEqual(hash, codeHash(code).slice(0, 32), 'not the fast hash the relay holds');
  assert.strictEqual(lan.hostForCode(hash), null, 'nothing heard yet');

  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  sender.send(Buffer.from(JSON.stringify({ app: 'crew-office', v: 1, port: 8080, rooms: [], codes: [hash] })), port, '127.0.0.1');
  const heard = await waitFor(() => lan.hostForCode(hash), { what: 'the announcement', timeout: 5000 });
  assert.strictEqual(heard, 'http://127.0.0.1:8080');
  assert.strictEqual(lan.hostForCode(lanCodeHash('ZZZZZZZZZZ')), null, 'another code finds nobody');
});

test('Advanced still works: a relay set by hand has to be encrypted, and clearing it goes back', { timeout: 30_000 }, async (t) => {
  const relay = await startRelay(t);
  const { owner } = await hostingApp(t, null);
  const plain = await owner('PUT', '/api/crew/internet', { url: 'http://plain.example.org', key: 'k' });
  assert.strictEqual(plain.status, 400);
  assert.match(plain.error, /https/);
  assert.strictEqual((await owner('PUT', '/api/crew/internet', { url: 'not a url' })).status, 400);
  assert.strictEqual((await owner('PUT', '/api/crew/internet', { url: relay.url })).source, 'manual');
  await waitFor(async () => (await owner('GET', '/api/crew/internet')).state === 'online', { what: 'the tunnel', timeout: 8000 });
  const cleared = await owner('PUT', '/api/crew/internet', { url: '' });
  assert.strictEqual(cleared.state, 'off');
  assert.strictEqual(cleared.configured, false);
  await waitFor(async () => (await tunnels(relay)) === 0, { what: 'the tunnel to close', timeout: 5000 });
});
