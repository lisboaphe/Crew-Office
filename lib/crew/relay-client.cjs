// The host's end of the relay: dial out, keep the connection, and pass requests to this server.
//
// A request that arrives this way is treated as coming from the internet, whatever its socket
// says. It carries a secret made fresh at each start, so a program on this computer cannot pretend
// to be the tunnel, or a visitor pretend to be a local one. Through it only the office's own pages
// and APIs are reachable. The rest of this server is not, and neither is anything else on this
// computer: the tunnel only ever connects to this server's own port.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TYPE, frame, createParser, chunks, cleanHeaders } = require('../relay/frames.cjs');

const PING_MS = 15_000;
const DEAD_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;
const LABELS = {
  off: 'Hosting locally',
  connecting: 'Connecting to internet service',
  online: 'Connected through relay',
  reconnecting: 'Reconnecting',
  unavailable: 'Internet hosting unavailable',
};

// What a visitor may reach. Anything not named here is not there for them.
const ALLOWED = [/^\/crew(\/|$)/, /^\/api\/crew\//, /^\/git\/repo_/, /^\/office\/[^/]+(\/|$)/, /^\/src\//, /^\/assets\//, /^\/vendor\//, /^\/styles\.css$/, /^\/favicon\.ico$/, /^\/index\.html$/, /^\/$/];
// Inside those, what has no business being asked from outside. Routes for this computer's owner
// (updates, this-computer, internet) answer for themselves: they need the machine key and a direct
// connection, and a request through here is never that.
const LOCAL_ONLY = [/^\/api\/crew\/lan-rooms/, /^\/api\/crew\/client-error/];

function createRelayClient(crew) {
  const secret = crypto.randomBytes(32).toString('hex');
  const file = path.join(crew.dataDir, 'relay.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not set up */ }
  let state = 'off';
  let reason = null;
  let socket = null;
  let stopping = false;
  let retry = null;
  let backoff = 1000;
  let rtt = null;
  let lastPong = 0;
  let pinger = null;

  const save = () => { fs.mkdirSync(crew.dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); };
  const set = (next, why = null) => { state = next; reason = why; };

  /** The address people use. Known only once the relay has said what it gave us. */
  function publicUrl() {
    if (!config.url || !config.tunnelId || state === 'off') return null;
    const u = new URL(config.url);
    if (config.domain) u.host = `${config.tunnelId}.${config.domain}${u.port ? `:${u.port}` : ''}`;
    return u.origin;
  }

  function status() {
    return { state, label: LABELS[state], reason, configured: Boolean(config.url), relay: config.url ?? null, url: state === 'online' ? publicUrl() : null, latencyMs: state === 'online' ? rtt : null, mode: LABELS[state] };
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

  function forward(open, id) {
    const headers = { ...cleanHeaders(open.headers), 'x-crew-relay': secret, 'x-crew-client-ip': String(open.ip ?? 'relay') };
    const req = http.request({ host: '127.0.0.1', port: crew.port(), method: open.method, path: open.url, headers }, (res) => {
      send(TYPE.RESPONSE, id, { status: res.statusCode, headers: res.headers });
      res.on('data', (chunk) => { for (const piece of chunks(chunk)) if (send(TYPE.DATA, id, piece) === false) { res.pause(); socket?.once('drain', () => res.resume()); } });
      res.on('end', () => { send(TYPE.END, id); streams.delete(id); });
      res.on('error', () => { send(TYPE.ABORT, id); streams.delete(id); });
    });
    req.on('error', () => { send(TYPE.ABORT, id); streams.delete(id); });
    return req;
  }

  const streams = new Map();
  const send = (type, id, payload) => (socket && !socket.destroyed ? socket.write(frame(type, id, payload)) : true);

  function connect() {
    clearTimeout(retry);
    if (stopping || !config.url) return;
    set(state === 'online' || state === 'reconnecting' ? 'reconnecting' : 'connecting');
    let target;
    try { target = new URL(config.url); } catch { set('unavailable', 'That relay address is not valid.'); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: '/_relay/connect', method: 'GET', timeout: 15_000,
      headers: { Connection: 'Upgrade', Upgrade: 'crew-relay', 'X-Crew-Relay-Key': config.key ?? '', ...(config.tunnelId ? { 'X-Crew-Tunnel-Id': config.tunnelId, 'X-Crew-Tunnel-Secret': config.tunnelSecret } : {}) },
    });
    req.on('upgrade', (res, sock) => {
      socket = sock;
      backoff = 1000;
      config.tunnelId = res.headers['x-crew-tunnel-id'];
      config.tunnelSecret = res.headers['x-crew-tunnel-secret'];
      config.domain = res.headers['x-crew-tunnel-domain'] || '';
      save();
      lastPong = Date.now();
      set('online');
      crew.audit(null, 'system', 'relay.connected', { relay: target.host });
      const parse = createParser((type, id, payload) => {
        if (type === TYPE.PONG) { lastPong = Date.now(); rtt = Date.now() - Number(payload.toString()); return; }
        if (type === TYPE.OPEN) { streams.set(id, forward(JSON.parse(payload.toString()), id)); return; }
        const up = streams.get(id);
        if (!up) return;
        if (type === TYPE.DATA) up.write(payload);
        else if (type === TYPE.END) up.end();
        else if (type === TYPE.ABORT) { up.destroy(); streams.delete(id); }
      }, () => sock.destroy());
      sock.on('data', parse);
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (Date.now() - lastPong > DEAD_MS) { sock.destroy(); return; }
        send(TYPE.PING, 0, Buffer.from(String(Date.now())));
      }, PING_MS);
      pinger.unref?.();
      const down = () => {
        if (socket !== sock) return;
        socket = null;
        clearInterval(pinger);
        for (const up of streams.values()) up.destroy();
        streams.clear();
        if (!stopping) { set('reconnecting', 'Lost the connection to the relay.'); schedule(); }
      };
      sock.on('close', down);
      sock.on('error', down);
    });
    req.on('response', (res) => {
      res.resume();
      const why = { 401: 'The relay refused this host: its key is wrong.', 403: 'The relay no longer recognises this office.', 409: 'That relay is already serving another office.', 503: 'That relay is full.' }[res.statusCode] ?? `The relay answered ${res.statusCode}.`;
      if (res.statusCode === 403) { delete config.tunnelId; delete config.tunnelSecret; save(); }
      set('unavailable', why);
      schedule();
    });
    req.on('timeout', () => req.destroy(new Error('It did not answer in time.')));
    req.on('error', (err) => { set(state === 'reconnecting' ? 'reconnecting' : 'unavailable', `Could not reach the relay: ${err.message}`); schedule(); });
    req.end();
  }

  function schedule() {
    if (stopping) return;
    clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    retry.unref?.();
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }

  function start() { if (config.url && config.enabled !== false) { stopping = false; connect(); } }

  function stop() {
    stopping = true;
    clearTimeout(retry);
    clearInterval(pinger);
    socket?.destroy();
    socket = null;
    set('off');
  }

  function configure({ url, key, enabled = true }) {
    stop();
    if (url !== undefined) {
      const clean = String(url).trim().replace(/\/+$/, '');
      if (clean && !/^https?:\/\/[^\s]+$/.test(clean)) { const e = new Error('A relay address starts with https://'); e.status = 400; throw e; }
      if (clean !== config.url) { delete config.tunnelId; delete config.tunnelSecret; delete config.domain; }
      config.url = clean || undefined;
    }
    if (key !== undefined) config.key = String(key);
    config.enabled = enabled;
    save();
    stopping = false;
    if (config.url && enabled) { backoff = 1000; connect(); }
    return status();
  }

  return { adopt, allowed, status, start, stop, configure, publicUrl };
}

module.exports = { createRelayClient };
