// The host's end of the relay: find the service, dial out, keep the connection, prove it works,
// and pass requests to this server.
//
// Which service: Advanced settings first, then CREW_CONNECTIVITY_URL, then whatever this build was
// stamped with (installer/build.cjs). There is no address written into this file, because an
// address nobody runs would be a feature that looks finished. With none, the status says so.
//
// When: a relay set by hand is used whenever the app runs, since somebody asked for it. The
// automatic service is only dialled while an office is being hosted (rooms.setHosted), so a copy of
// the app that is not hosting anything is not reachable from anywhere.
//
// A request that arrives this way is treated as coming from the internet, whatever its socket
// says. It carries a secret made fresh at each start, so a program on this computer cannot pretend
// to be the tunnel, or a visitor pretend to be a local one. Through it only the office's own pages
// and APIs are reachable. The rest of this server is not, and neither is anything else on this
// computer: the tunnel only ever connects to this server's own port.
//
// "online" means more than a connected socket. The host fetches its own public address, from
// outside, the way a friend would, and looks for a nonce it made a moment ago arriving down the
// tunnel. That covers DNS, the certificate and the proxy. Until it comes back, nothing says the
// room is available and no link is offered.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TYPE, frame, createParser, chunks, cleanHeaders } = require('../relay/frames.cjs');
const { codeHash, isLoopback } = require('../relay/invitation.cjs');
const { httpError } = require('./auth.cjs');

const PING_MS = 15_000;
const DEAD_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;
const HEALTH_MS = Number(process.env.CREW_RELAY_HEALTH_MS) || 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const LABELS = {
  off: 'Hosting locally',
  connecting: 'Connecting to internet service',
  verifying: 'Connecting to internet service',
  online: 'Internet room available',
  reconnecting: 'Reconnecting',
  unavailable: 'Internet service unavailable',
};
const NO_SERVICE = 'This copy of Crew Office has no internet service set up, so this office can only be reached on your own network. Whoever runs your Crew Office has to deploy one, or add a relay under Advanced.';

// What a visitor may reach. Anything not named here is not there for them.
const ALLOWED = [/^\/crew(\/|$)/, /^\/api\/crew\//, /^\/git\/repo_/, /^\/office\/[^/]+(\/|$)/, /^\/src\//, /^\/assets\//, /^\/vendor\//, /^\/styles\.css$/, /^\/favicon\.ico$/, /^\/index\.html$/, /^\/$/];
// Inside those, what has no business being asked from outside. Routes for this computer's owner
// (updates, this-computer, internet) answer for themselves: they need the machine key and a direct
// connection, and a request through here is never that.
const LOCAL_ONLY = [/^\/api\/crew\/lan-rooms/, /^\/api\/crew\/client-error/, /^\/api\/crew\/invitations\/resolve/];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function clean(url) { return String(url ?? '').trim().replace(/\/+$/, ''); }

/** A service's address is usable if traffic to it is encrypted, or never leaves this computer. */
function acceptable(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (isLoopback(u.hostname) || process.env.CREW_RELAY_ALLOW_INSECURE === '1');
  } catch { return false; }
}

function createRelayClient(crew) {
  const secret = crypto.randomBytes(32).toString('hex');
  const file = path.join(crew.dataDir, 'relay.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not set up */ }
  let state = 'off';
  let reason = null;
  let socket = null;
  let stopping = false;
  let dialling = false;
  let attempt = 0;
  let retry = null;
  let backoff = 1000;
  let rtt = null;
  let lastPong = 0;
  let pinger = null;
  let health = null;
  let probeFailures = 0;
  let checkedAt = null;
  let codesPublished = false;
  let publishing = false;
  const nonces = new Set();

  const save = () => { fs.mkdirSync(crew.dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); };
  const set = (next, why = null) => { state = next; reason = why; };

  function stamped() {
    try { return JSON.parse(fs.readFileSync(path.join(crew.root, 'build.json'), 'utf8')).connectivity ?? null; } catch { return null; }
  }

  /** Which service, if any. Asked each time, so nothing is cached that a setting could outdate. */
  function service() {
    if (config.url) return { url: config.url, key: config.key, source: 'manual' };
    const env = clean(process.env.CREW_CONNECTIVITY_URL);
    if (env) return { url: env, key: process.env.CREW_CONNECTIVITY_KEY, source: 'automatic' };
    const built = stamped();
    if (built?.url) return { url: clean(built.url), key: built.key, source: 'automatic' };
    return null;
  }

  const hostedCount = () => crew.rooms?.hostedCount?.() ?? 0;

  function wanted() {
    const s = service();
    if (!s) return false;
    if (s.source === 'manual') return config.enabled !== false;
    return hostedCount() > 0;
  }

  /** The address people use. Known only once the relay has said what it gave us. */
  function publicUrl() {
    const s = service();
    if (!s || !config.tunnelId || config.tunnelFor !== s.url || state === 'off') return null;
    const u = new URL(s.url);
    if (config.domain) u.host = `${config.tunnelId}.${config.domain}${u.port ? `:${u.port}` : ''}`;
    return u.origin;
  }

  function status() {
    const s = service();
    const noService = !s && hostedCount() > 0;
    const shown = noService ? 'unavailable' : state;
    return {
      state: shown, label: LABELS[shown], reason: noService ? NO_SERVICE : reason, blocker: noService ? 'no-service' : null,
      configured: Boolean(s), source: s?.source ?? null, manual: s?.source === 'manual', relay: s?.source === 'manual' ? s.url : null, service: s?.url ?? null,
      url: shown === 'online' ? publicUrl() : null, transport: shown === 'online' ? 'relay' : null, verified: shown === 'online', checkedAt,
      latencyMs: shown === 'online' ? rtt : null, codesPublished: shown === 'online' && codesPublished, mode: LABELS[shown],
    };
  }

  /** Called first for every request on this server. */
  function adopt(req) {
    delete req.crewClientIp;
    const claimed = req.headers['x-crew-relay'];
    const fromHere = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress);
    const proven = typeof claimed === 'string' && fromHere && claimed.length === secret.length && crypto.timingSafeEqual(Buffer.from(claimed), Buffer.from(secret));
    delete req.headers['x-crew-relay'];
    const ip = req.headers['x-crew-client-ip'];
    delete req.headers['x-crew-client-ip'];
    if (!proven) return false;
    req.crewViaRelay = true;
    req.crewClientIp = String(ip ?? 'relay').slice(0, 64);
    return true;
  }

  /** Whether a visitor through the relay may ask for this at all. */
  function allowed(req, url) {
    if (!req.crewViaRelay) return true;
    const p = url.pathname;
    if (LOCAL_ONLY.some((r) => r.test(p))) return false;
    if (req.method === 'POST' && p === '/api/crew/rooms') return false; // offices are made at the keyboard
    return ALLOWED.some((r) => r.test(p));
  }

  /** On the automatic service only rooms being hosted are on offer. By hand, the owner chose. */
  const exposes = (room) => service()?.source === 'manual' || Boolean(room?.internet_hosted);

  function forward(open, id) {
    if (typeof open.url !== 'string' || !open.url.startsWith('/') || !METHODS.has(open.method)) throw new Error('A request that makes no sense.');
    const headers = { ...cleanHeaders(open.headers ?? {}), 'x-crew-relay': secret, 'x-crew-client-ip': String(open.ip ?? 'relay') };
    const req = http.request({ host: '127.0.0.1', port: crew.port(), method: open.method, path: open.url, headers }, (res) => {
      req.crewResponse = res;
      send(TYPE.RESPONSE, id, { status: res.statusCode, headers: res.headers });
      res.on('data', (chunk) => { for (const piece of chunks(chunk)) if (send(TYPE.DATA, id, piece) === false) { res.pause(); socket?.once('drain', () => { if (!req.crewHeld) res.resume(); }); } });
      res.on('end', () => { send(TYPE.END, id); streams.delete(id); });
      res.on('error', () => { send(TYPE.ABORT, id); streams.delete(id); });
    });
    req.on('error', () => { send(TYPE.ABORT, id); streams.delete(id); });
    return req;
  }

  const streams = new Map();
  const send = (type, id, payload) => (socket && !socket.destroyed ? socket.write(frame(type, id, payload)) : true);

  function get(url, { timeout = PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      // CREW_RELAY_PROBE_VIA dials a fixed address, for tests of hostnames with no DNS behind them.
      const req = lib.request({ hostname: process.env.CREW_RELAY_PROBE_VIA || u.hostname, servername: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout, headers: { Host: u.host, Accept: 'application/json' } }, (res) => {
        const parts = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(new Error('Too large an answer.')); else parts.push(c); });
        res.on('end', () => { let body = null; try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { /* not JSON */ } resolve({ status: res.statusCode, body }); });
      });
      req.on('timeout', () => req.destroy(new Error('It did not answer in time.')));
      req.on('error', reject);
      req.end();
    });
  }

  /** Whether a request this host sent to its own public address came back down the tunnel. */
  function answerProbe(nonce) { return nonces.delete(String(nonce)); }

  async function probe() {
    const target = publicUrl();
    if (!socket || !target) return;
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.add(nonce);
    let failure = null;
    try {
      const r = await get(`${target}/api/crew/relay-probe?nonce=${nonce}`);
      if (!(r.status === 200 && r.body?.ok === true)) failure = `The service answered ${r.status} instead of passing the request to this office.`;
    } catch (err) { failure = err.message; }
    nonces.delete(nonce);
    if (!socket) return; // went down while this was out; `down` has said so
    checkedAt = Date.now();
    if (!failure) {
      const first = state !== 'online';
      probeFailures = 0;
      set('online');
      if (first) crew.audit(null, 'system', 'relay.verified', { url: target });
      publishCodes().catch(() => {});
      return;
    }
    probeFailures++;
    // One slow answer does not take a working room offline. Two in a row, or never having worked,
    // does: the status has to stay true.
    if (state === 'online' && probeFailures < 2) return;
    set('unavailable', `Connected to the internet service, but a visitor could not reach this office through it: ${failure}`);
    clearTimeout(retry);
    if (probeFailures < 4) { retry = setTimeout(probe, 2000 * probeFailures); retry.unref?.(); }
  }

  /** Tell the service which codes point here. The whole list each time, so it cannot drift. */
  async function publishCodes() {
    const s = service();
    if (!s || !socket || publishing) return;
    publishing = true;
    try {
      const list = (crew.rooms?.publishableCodes?.() ?? []).map((c) => ({ hash: codeHash(c.code), expiresAt: c.expiresAt }));
      const r = await fetch(`${s.url}/_relay/codes`, { method: 'PUT', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'Content-Type': 'application/json', 'X-Crew-Tunnel-Id': config.tunnelId, 'X-Crew-Tunnel-Secret': config.tunnelSecret }, body: JSON.stringify({ codes: list }) });
      const out = await r.json().catch(() => ({}));
      codesPublished = r.ok && !(out.conflicts?.length);
      if (out.conflicts?.length) crew.crash.record('relay.codes', new Error(`${out.conflicts.length} room codes are held by another office.`));
    } catch { codesPublished = false; } finally { publishing = false; }
  }

  async function connect() {
    clearTimeout(retry);
    if (stopping || dialling || socket || !wanted()) return;
    dialling = true;
    const mine = ++attempt;
    const stale = () => mine !== attempt; // settings changed or hosting stopped while this was out
    const s = service();
    const wasUp = state === 'online' || state === 'reconnecting';
    set(wasUp ? 'reconnecting' : 'connecting', wasUp ? reason : null);
    const giveUp = (why) => { if (stale()) return; dialling = false; set(wasUp ? 'reconnecting' : 'unavailable', why); schedule(); };

    if (!acceptable(s.url)) { dialling = false; set('unavailable', 'A connectivity service has to be an https:// address, so that friends’ traffic is encrypted.'); return; }
    let target;
    try { target = new URL(s.url); } catch { dialling = false; set('unavailable', 'That relay address is not valid.'); return; }
    if (config.tunnelFor !== s.url) { delete config.tunnelId; delete config.tunnelSecret; delete config.domain; }

    // Discovery: is this really a Crew Office relay, and will it have us?
    let info;
    try {
      const r = await fetch(`${s.url}/_relay/info`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      info = await r.json();
      if (info?.service !== 'crew-relay') throw new Error('That address is not a Crew Office relay.');
    } catch (err) { return giveUp(`Could not reach the relay: ${err.cause?.code ?? err.cause?.message ?? err.message}`); }
    if (stale()) return undefined;
    if (info.needsKey && !info.open && !s.key) { dialling = false; set('unavailable', 'That relay needs a key. Add it under Advanced.'); return undefined; }

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: '/_relay/connect', method: 'GET', timeout: 15_000,
      headers: { Connection: 'Upgrade', Upgrade: 'crew-relay', 'X-Crew-Relay-Key': s.key ?? '', ...(config.tunnelId ? { 'X-Crew-Tunnel-Id': config.tunnelId, 'X-Crew-Tunnel-Secret': config.tunnelSecret } : {}) },
    });
    req.on('upgrade', (res, sock) => {
      if (stale()) { sock.destroy(); return; }
      dialling = false;
      socket = sock;
      backoff = 1000;
      probeFailures = 0;
      codesPublished = false;
      config.tunnelId = res.headers['x-crew-tunnel-id'];
      config.tunnelSecret = res.headers['x-crew-tunnel-secret'];
      config.domain = res.headers['x-crew-tunnel-domain'] || '';
      config.tunnelFor = s.url;
      save();
      lastPong = Date.now();
      set('verifying');
      crew.audit(null, 'system', 'relay.connected', { relay: target.host });
      const onFrame = (type, id, payload) => {
        if (type === TYPE.PONG) { lastPong = Date.now(); rtt = Date.now() - Number(payload.toString()); return; }
        if (type === TYPE.OPEN) {
          try { streams.set(id, forward(JSON.parse(payload.toString()), id)); } catch { send(TYPE.ABORT, id); }
          return;
        }
        const up = streams.get(id);
        if (!up) return;
        if (type === TYPE.DATA) up.write(payload);
        else if (type === TYPE.END) up.end();
        else if (type === TYPE.ABORT) { up.destroy(); streams.delete(id); }
        else if (type === TYPE.PAUSE) { up.crewHeld = true; up.crewResponse?.pause(); }
        else if (type === TYPE.RESUME) { up.crewHeld = false; up.crewResponse?.resume(); }
      };
      const parse = createParser((type, id, payload) => {
        try { onFrame(type, id, payload); } catch (err) { crew.crash.record('relay.frame', err); sock.destroy(); }
      }, () => sock.destroy());
      sock.on('data', parse);
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (Date.now() - lastPong > DEAD_MS) { sock.destroy(); return; }
        send(TYPE.PING, 0, Buffer.from(String(Date.now())));
      }, PING_MS);
      pinger.unref?.();
      clearInterval(health);
      health = setInterval(() => { probe().catch(() => {}); }, HEALTH_MS);
      health.unref?.();
      const down = () => {
        if (socket !== sock) return;
        socket = null;
        clearInterval(pinger);
        clearInterval(health);
        codesPublished = false;
        for (const up of streams.values()) up.destroy();
        streams.clear();
        if (!stopping && wanted()) { set('reconnecting', 'Lost the connection to the internet service.'); schedule(); }
      };
      sock.on('close', down);
      sock.on('error', down);
      probe().catch(() => {});
    });
    req.on('response', (res) => {
      res.resume();
      if (stale()) return;
      dialling = false;
      const why = { 401: 'The relay refused this host: its key is wrong.', 403: 'The relay no longer recognises this office.', 409: 'That relay is already serving another office.', 429: 'That relay has too many offices from this address, or was asked too often. Trying again shortly.', 503: 'That relay is full.' }[res.statusCode] ?? `The relay answered ${res.statusCode}.`;
      if (res.statusCode === 403) { delete config.tunnelId; delete config.tunnelSecret; save(); }
      set('unavailable', why);
      schedule();
    });
    req.on('timeout', () => req.destroy(new Error('It did not answer in time.')));
    req.on('error', (err) => { giveUp(`Could not reach the relay: ${err.message}`); });
    req.end();
    return undefined;
  }

  function schedule() {
    if (stopping || !wanted()) return;
    clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    retry.unref?.();
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }

  function hangUp() {
    attempt++;
    dialling = false;
    clearTimeout(retry);
    clearInterval(pinger);
    clearInterval(health);
    const was = socket;
    socket = null;
    was?.destroy();
    for (const up of streams.values()) up.destroy();
    streams.clear();
    codesPublished = false;
    set('off');
  }

  /** Make the connection match what is wanted now: hosting began, stopped, or an invite changed. */
  function sync() {
    if (stopping) return;
    if (!wanted()) { hangUp(); return; }
    if (socket) { publishCodes().catch(() => {}); return; }
    backoff = 1000;
    connect().catch((err) => crew.crash.record('relay.connect', err));
  }

  function start() { stopping = false; sync(); }

  function stop() {
    stopping = true;
    hangUp();
  }

  function configure({ url, key, enabled = true }) {
    stop();
    if (url !== undefined) {
      const next = clean(url);
      if (next && !/^https?:\/\/[^\s]+$/.test(next)) throw httpError(400, 'A relay address starts with https://');
      if (next && !acceptable(next)) { stopping = false; sync(); throw httpError(400, 'A relay address has to start with https://, so that friends’ traffic is encrypted.'); }
      config.url = next || undefined;
    }
    if (key !== undefined) config.key = String(key);
    config.enabled = enabled;
    save();
    stopping = false;
    sync();
    return status();
  }

  /** Where a room code leads. Only ever a page under the service's own name. */
  async function resolveCode(code) {
    const s = service();
    if (!s) throw httpError(503, 'This copy of Crew Office has no internet service set up, so a room code cannot be looked up. Ask your friend for the invitation link instead.');
    let r;
    try { r = await fetch(`${s.url}/_relay/resolve/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }); } catch (err) { throw httpError(503, `Could not reach the internet service: ${err.message}`); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, out.error ?? `The internet service answered ${r.status}.`);
    const home = new URL(s.url).hostname;
    let found;
    try { found = new URL(out.url); } catch { throw httpError(502, 'The internet service gave an address that makes no sense.'); }
    if (!['http:', 'https:'].includes(found.protocol) || (found.hostname !== home && !found.hostname.endsWith(`.${home}`))) throw httpError(502, 'The internet service gave an address outside itself.');
    return found.origin;
  }

  return { adopt, allowed, exposes, status, start, stop, sync, configure, publicUrl, answerProbe, resolveCode, get };
}

module.exports = { createRelayClient };
