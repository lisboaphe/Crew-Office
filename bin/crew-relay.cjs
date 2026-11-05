#!/usr/bin/env node
// The connectivity service: lets someone on the internet reach an office on a computer behind a
// home router, and turns a short room code into the place to go.
//
// The host dials out to here and keeps that connection open. Visitors reach the relay, and their
// requests travel down that connection. So nobody forwards a port, and CGNAT is no obstacle.
//
//   CREW_RELAY_KEY=<secret> node bin/crew-relay.cjs 8443
//
// It stores nothing on disk: no projects, files, repositories or credentials, and a restart forgets
// every tunnel and code until the hosts dial back in, which they do by themselves. It does see
// requests pass through once TLS ends here, so it has to be run by someone the players trust.
// docs/security/NETWORK_SECURITY.md says what that means.
//
// Settings, all from the environment:
//   CREW_RELAY_KEY     hosts must present this to connect. Required unless CREW_RELAY_OPEN=1
//   CREW_RELAY_OPEN=1  any copy of Crew Office may host here, within the limits below. What an
//                      app baked with this service's address needs, since a key in a download
//                      is not a secret
//   CREW_RELAY_DOMAIN  e.g. relay.example.org: each office gets <id>.relay.example.org, which
//                      needs a wildcard DNS record and certificate. Without it, the relay serves
//                      one office on its whole address, which needs neither
//   CREW_RELAY_TLS_CERT, CREW_RELAY_TLS_KEY   terminate TLS here, instead of behind a proxy
//   CREW_RELAY_TRUST_PROXY=1   take the visitor's address and protocol from the proxy's headers
//   CREW_RELAY_METRICS_KEY     bearer token for /_relay/metrics. Defaults to CREW_RELAY_KEY
//
// Limits:
//   CREW_RELAY_MAX_TUNNELS (50), CREW_RELAY_TUNNELS_PER_IP (5), CREW_RELAY_MAX_STREAMS (200)
//   CREW_RELAY_RATE (1200 requests a minute per address), CREW_RELAY_RESOLVE_RATE (20 code
//   look-ups a minute per address), CREW_RELAY_MAX_BODY_MB (512),
//   CREW_RELAY_DAILY_MB per office, each way combined. 5120 on an open relay, 0 (none) otherwise

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { TYPE, frame, createParser, chunks, cleanHeaders } = require('../lib/relay/frames.cjs');
const { normalizeCode, codeHash, formatCode } = require('../lib/relay/invitation.cjs');

const PROTOCOL = 1;
const port = Number(process.argv[2]) || Number(process.env.PORT) || 8443;
const KEY = process.env.CREW_RELAY_KEY || '';
const OPEN = process.env.CREW_RELAY_OPEN === '1';
const DOMAIN = (process.env.CREW_RELAY_DOMAIN || '').toLowerCase();
const TRUST_PROXY = process.env.CREW_RELAY_TRUST_PROXY === '1';
const METRICS_KEY = process.env.CREW_RELAY_METRICS_KEY || KEY;
const envNumber = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]));
const MAX_TUNNELS = envNumber('CREW_RELAY_MAX_TUNNELS', 50);
const TUNNELS_PER_IP = envNumber('CREW_RELAY_TUNNELS_PER_IP', 5);
const MAX_STREAMS = envNumber('CREW_RELAY_MAX_STREAMS', 200);
const MAX_REQUESTS_PER_MIN = envNumber('CREW_RELAY_RATE', 1200);
const MAX_RESOLVES_PER_MIN = envNumber('CREW_RELAY_RESOLVE_RATE', 20);
const MAX_BODY = envNumber('CREW_RELAY_MAX_BODY_MB', 512) * 1024 * 1024;
const DAILY_BYTES = envNumber('CREW_RELAY_DAILY_MB', OPEN ? 5120 : 0) * 1024 * 1024;
const MAX_CODES = 100;
const REMEMBER_MS = 24 * 3600_000;
const QUIET_MS = 60_000;
const startedAt = Date.now();

if (!KEY && !OPEN) {
  console.error('Refusing to start: set CREW_RELAY_KEY so that only your hosts can use this relay, or CREW_RELAY_OPEN=1 if you really mean anyone.');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(sha(a)); const y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };

/** id -> { secretRaw, socket, ip, streams, nextStream, seen, bytes, day, codes } */
const tunnels = new Map();
/** sha256 of a room code -> { tunnelId, expiresAt } */
const codes = new Map();
const hits = new Map();
const totals = { requests: 0, bytes: 0, refusedOverQuota: 0, refusedRate: 0, resolved: 0, resolveMisses: 0 };

function limited(ip, max = MAX_REQUESTS_PER_MIN) {
  const minute = Math.floor(Date.now() / 60_000);
  const k = `${ip}:${minute}`;
  const n = (hits.get(k) ?? 0) + 1;
  hits.set(k, n);
  if (hits.size > 50_000) hits.clear();
  return n > max;
}

const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
const isHttps = (req) => Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const hostOf = (req) => String(req.headers.host ?? '').split(':')[0].toLowerCase();

function tunnelFor(req) {
  if (!DOMAIN) return [...tunnels.values()].find((t) => t.socket) ?? null;
  const host = hostOf(req);
  if (!host.endsWith(`.${DOMAIN}`)) return null;
  const t = tunnels.get(host.slice(0, -DOMAIN.length - 1));
  return t?.socket ? t : null;
}

/** The address an office answers on, as seen by whoever is asking. */
function originOf(req, t) {
  const scheme = isHttps(req) ? 'https' : 'http';
  const given = String(req.headers.host ?? '');
  if (!DOMAIN) return `${scheme}://${given}`;
  const portPart = given.includes(':') ? `:${given.split(':')[1]}` : '';
  return `${scheme}://${t.id}.${DOMAIN}${portPart}`;
}

function spend(t, n) {
  totals.bytes += n;
  const day = Math.floor(Date.now() / 86_400_000);
  if (t.day !== day) { t.day = day; t.bytes = 0; }
  t.bytes += n;
}
const overQuota = (t) => DAILY_BYTES > 0 && t.day === Math.floor(Date.now() / 86_400_000) && t.bytes > DAILY_BYTES;

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Office offline</title>
<style>body{font:16px system-ui;background:#0e1016;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:24px;text-align:center}p{color:#a0a7b6}</style>
<main><h1>This office is not online right now</h1><p>Its host may have closed Crew Office, or lost its connection. Nothing is lost: ask them to open it again, and this link will work.</p></main><script>setTimeout(()=>location.reload(),10000)</script>`;

// The service's own address, for a friend who has a code and nothing installed.
const ENTER_CODE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join an office</title>
<style>body{font:16px system-ui;background:#0e1016;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:24px;text-align:center}p{color:#a0a7b6}input{font:20px ui-monospace,monospace;text-align:center;padding:12px;border-radius:10px;border:1px solid #39404f;background:#191c25;color:inherit;width:100%;box-sizing:border-box;letter-spacing:.08em;text-transform:uppercase}button{margin-top:12px;font:inherit;padding:10px 22px;border-radius:10px;border:0;background:#5b8cff;color:#fff;cursor:pointer}</style>
<main><h1>Join an office</h1><p>Enter the room code your friend sent you.</p><form onsubmit="location.href='/j/'+encodeURIComponent(this.c.value.trim());return false"><input name="c" autocomplete="off" autofocus placeholder="ABCDE-FGHIJ" aria-label="Room code"><button>Join</button></form></main>`;

function refuse(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(text);
}

function answer(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function page(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}

const connected = () => [...tunnels.values()].filter((t) => t.socket);

function metrics() {
  return {
    uptimeS: Math.floor((Date.now() - startedAt) / 1000),
    tunnels: { connected: connected().length, remembered: tunnels.size, max: MAX_TUNNELS },
    streams: connected().reduce((n, t) => n + t.streams.size, 0),
    codes: codes.size,
    totals,
    busiest: connected().sort((a, b) => b.bytes - a.bytes).slice(0, 10).map((t) => ({ id: `${t.id.slice(0, 6)}…`, streams: t.streams.size, bytesToday: t.bytes })),
  };
}

/** What a copy of the app asks first, so that it can say something useful if this is not a relay. */
const info = () => ({ service: 'crew-relay', protocol: PROTOCOL, domain: DOMAIN || null, needsKey: Boolean(KEY), open: OPEN, limits: { dailyMb: DAILY_BYTES ? DAILY_BYTES / 1024 / 1024 : null, maxBodyMb: MAX_BODY / 1024 / 1024, streams: MAX_STREAMS } });

function resolve(req, res, raw) {
  const ip = clientIp(req);
  if (limited(`resolve:${ip}`, MAX_RESOLVES_PER_MIN)) { totals.refusedRate++; return { status: 429, error: 'Too many tries. Wait a minute and try again.' }; }
  const code = normalizeCode(raw);
  const entry = code ? codes.get(codeHash(code)) : null;
  // The same answer for a code that never existed and one that has run out: nothing to probe.
  if (!entry || entry.expiresAt < Date.now() || !tunnels.has(entry.tunnelId)) { totals.resolveMisses++; return { status: 404, error: 'No office with that code. Check it, or ask for a new one.' }; }
  const t = tunnels.get(entry.tunnelId);
  if (!t.socket) return { status: 409, error: 'That office’s host is not online right now. Ask them to open Crew Office.' };
  totals.resolved++;
  return { status: 200, url: originOf(req, t), code };
}

function publishCodes(req, res) {
  const t = tunnels.get(String(req.headers['x-crew-tunnel-id'] ?? '').toLowerCase());
  if (!t || !same(req.headers['x-crew-tunnel-secret'] ?? '', t.secretRaw)) { req.resume(); return answer(res, 403, { error: 'Not this office.' }); }
  let size = 0;
  const parts = [];
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } parts.push(c); });
  req.on('end', () => {
    let list;
    try { list = JSON.parse(Buffer.concat(parts).toString()).codes; } catch { return answer(res, 400, { error: 'Body must be JSON.' }); }
    if (!Array.isArray(list) || list.length > MAX_CODES) return answer(res, 400, { error: `At most ${MAX_CODES} codes.` });
    const wanted = list.filter((c) => /^[a-f0-9]{64}$/.test(c?.hash ?? '') && Number.isFinite(c?.expiresAt));
    for (const hash of t.codes) if (!wanted.some((c) => c.hash === hash)) { t.codes.delete(hash); codes.delete(hash); }
    const conflicts = [];
    for (const c of wanted) {
      const held = codes.get(c.hash);
      if (held && held.tunnelId !== t.id && held.expiresAt > Date.now()) { conflicts.push(c.hash); continue; }
      codes.set(c.hash, { tunnelId: t.id, expiresAt: Math.min(c.expiresAt, Date.now() + 30 * 86_400_000) });
      t.codes.add(c.hash);
    }
    return answer(res, 200, { accepted: wanted.length - conflicts.length, conflicts });
  });
  return undefined;
}

/** Everything under /_relay/ is the service's own, on every hostname it answers. */
function serviceRoute(req, res, url) {
  if (url === '/_relay/health') { answer(res, 200, { ok: true, tunnels: connected().length, uptimeS: Math.floor((Date.now() - startedAt) / 1000) }); return true; }
  if (url === '/_relay/info') { answer(res, 200, info()); return true; }
  if (url === '/_relay/metrics') {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!METRICS_KEY || !same(bearer, METRICS_KEY)) { refuse(res, 401, 'A metrics key is needed.'); return true; }
    answer(res, 200, metrics());
    return true;
  }
  if (url === '/_relay/codes' && req.method === 'PUT') { publishCodes(req, res); return true; }
  const path = url.split('?')[0];
  if (path.startsWith('/_relay/resolve/') && req.method === 'GET') {
    const out = resolve(req, res, decodeURIComponent(path.slice('/_relay/resolve/'.length)).slice(0, 32));
    answer(res, out.status, out);
    return true;
  }
  // Caddy's on-demand TLS asks this before getting a certificate, so a stranger's made-up
  // hostname cannot spend the domain's certificate allowance.
  if (path === '/_relay/tls-check') {
    const domain = new URL(url, 'http://relay').searchParams.get('domain')?.toLowerCase() ?? '';
    const known = domain === DOMAIN || (DOMAIN && domain.endsWith(`.${DOMAIN}`) && tunnels.has(domain.slice(0, -DOMAIN.length - 1)));
    res.writeHead(known ? 200 : 404);
    res.end();
    return true;
  }
  if (path.startsWith('/_relay/')) { refuse(res, 404, 'Not here.'); return true; }
  return false;
}

/** The bare domain has no office on it: it is where a friend with only a code can start. */
function apexRoute(req, res, url) {
  if (!DOMAIN || hostOf(req) !== DOMAIN) return false;
  const path = url.split('?')[0];
  if (path === '/') { page(res, 200, ENTER_CODE); return true; }
  if (!path.startsWith('/j/')) return false;
  let raw = '';
  try { raw = decodeURIComponent(path.slice(3)).slice(0, 32); } catch { /* treated as no code */ }
  const out = resolve(req, res, raw);
  if (out.status !== 200) { page(res, out.status, `<!doctype html><meta charset="utf-8"><title>Join an office</title><style>body{font:16px system-ui;background:#0e1016;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}a{color:#8db0ff}</style><main><p>${out.error}</p><a href="/">Try again</a></main>`); return true; }
  res.writeHead(302, { Location: `${out.url}/crew/join?code=${formatCode(out.code)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
  return true;
}

function handleRequest(req, res) {
  const url = req.url;
  if (serviceRoute(req, res, url)) return undefined;
  const ip = clientIp(req);
  if (limited(ip)) { totals.refusedRate++; return refuse(res, 429, 'Too many requests. Wait a moment.'); }
  if (apexRoute(req, res, url)) return undefined;
  const t = tunnelFor(req);
  if (!t) {
    if ((req.headers.accept ?? '').includes('text/html')) return page(res, 503, OFFLINE);
    return refuse(res, 503, 'This office is not online right now.');
  }
  if (t.streams.size >= MAX_STREAMS) return refuse(res, 503, 'This office is too busy right now.');
  if (overQuota(t)) { totals.refusedOverQuota++; return refuse(res, 429, 'This office has used this relay’s daily allowance. It resets at midnight UTC.'); }
  totals.requests++;
  const id = (t.nextStream += 2);
  const stream = { res, started: false };
  t.streams.set(id, stream);
  const write = (type, payload) => { if (t.socket && !t.socket.destroyed) return t.socket.write(frame(type, id, payload)); return true; };
  write(TYPE.OPEN, { method: req.method, url, headers: { ...cleanHeaders(req.headers), 'x-forwarded-for': ip, 'x-forwarded-proto': isHttps(req) ? 'https' : 'http' }, ip });
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    spend(t, chunk.length);
    if (size > MAX_BODY) { write(TYPE.ABORT); req.destroy(); return; }
    for (const piece of chunks(chunk)) if (write(TYPE.DATA, piece) === false) { req.pause(); t.socket.once('drain', () => req.resume()); }
  });
  req.on('end', () => write(TYPE.END));
  const gone = () => { if (t.streams.delete(id)) write(TYPE.ABORT); };
  res.on('close', gone);
  return undefined;
}

/** Room for one more, by forgetting whichever disconnected office has been gone longest. */
function makeRoom() {
  if (tunnels.size < MAX_TUNNELS) return true;
  const oldest = [...tunnels.values()].filter((t) => !t.socket).sort((a, b) => (a.gone ?? 0) - (b.gone ?? 0))[0];
  if (!oldest) return false;
  forget(oldest);
  return true;
}

function forget(t) {
  for (const hash of t.codes) codes.delete(hash);
  tunnels.delete(t.id);
}

function handleUpgrade(req, socket) {
  const fail = (line) => { socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  socket.on('error', () => {});
  const url = new URL(req.url, 'http://relay');
  if (url.pathname !== '/_relay/connect') return fail('404 Not Found');
  const ip = clientIp(req);
  if (KEY && !OPEN && !same(req.headers['x-crew-relay-key'] ?? '', KEY)) { console.log(`[relay] refused a host from ${ip}: wrong key`); return fail('401 Unauthorized'); }
  if (limited(`connect:${ip}`, 60)) return fail('429 Too Many Requests');

  // A host keeps its address across reconnects by proving it holds the secret it was given. After
  // this relay restarts it presents the same pair and is given the same address back, so links
  // that are already out there go on working.
  let id = String(req.headers['x-crew-tunnel-id'] ?? '').toLowerCase();
  const secret = String(req.headers['x-crew-tunnel-secret'] ?? '');
  let t = id ? tunnels.get(id) : null;
  if (t && !same(secret, t.secretRaw)) return fail('403 Forbidden');
  if (!DOMAIN && !t && connected().length) return fail('409 Conflict');
  if (!t?.socket && connected().filter((x) => x.ip === ip).length >= TUNNELS_PER_IP) { console.log(`[relay] refused a host from ${ip}: too many offices from one address`); return fail('429 Too Many Requests'); }
  if (!t) {
    if (!makeRoom()) return fail('503 Service Unavailable');
    id = /^[a-z0-9]{20,32}$/.test(id) && secret.length >= 32 ? id : crypto.randomBytes(13).toString('hex');
    t = { id, secretRaw: secret.length >= 32 ? secret : crypto.randomBytes(32).toString('hex'), streams: new Map(), nextStream: 0, socket: null, bytes: 0, day: 0, codes: new Set() };
    tunnels.set(id, t);
  }
  if (t.socket) t.socket.destroy();
  t.socket = socket;
  t.ip = ip;
  t.seen = Date.now();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: crew-relay\r\nConnection: Upgrade\r\nX-Crew-Tunnel-Id: ${t.id}\r\nX-Crew-Tunnel-Secret: ${t.secretRaw}\r\nX-Crew-Tunnel-Domain: ${DOMAIN}\r\n\r\n`);
  console.log(`[relay] host connected: ${t.id.slice(0, 6)}…`);

  const onFrame = (type, stream, payload) => {
    t.seen = Date.now();
    if (type === TYPE.PING) { socket.write(frame(TYPE.PONG, 0, payload)); return; }
    const s = t.streams.get(stream);
    if (!s) return;
    if (type === TYPE.RESPONSE) {
      if (s.started) return;
      const head = JSON.parse(payload.toString());
      s.started = true;
      s.res.writeHead(head.status, cleanHeaders(head.headers));
      if (s.res.flushHeaders) s.res.flushHeaders();
    } else if (type === TYPE.DATA) {
      spend(t, payload.length);
      // Never pause the socket here: everyone's traffic is on it. Ask the host to hold this one.
      if (s.res.write(payload) === false && !s.held) {
        s.held = true;
        socket.write(frame(TYPE.PAUSE, stream));
        s.res.once('drain', () => { s.held = false; if (t.socket === socket && t.streams.has(stream)) socket.write(frame(TYPE.RESUME, stream)); });
      }
    } else if (type === TYPE.END) { t.streams.delete(stream); s.res.end(); } else if (type === TYPE.ABORT) { t.streams.delete(stream); if (s.started) s.res.destroy(); else refuse(s.res, 502, 'The office could not answer that.'); }
  };
  // Whoever is at the far end of this socket may be anybody on an open relay. Nonsense from them
  // ends their own connection, and must not end everyone else's by throwing out of here.
  const parse = createParser((type, stream, payload) => {
    try { onFrame(type, stream, payload); } catch (err) { console.log(`[relay] dropping a host: ${err.message}`); socket.destroy(); }
  }, (err) => { console.log(`[relay] dropping a host: ${err.message}`); socket.destroy(); });
  socket.on('data', parse);
  const down = () => {
    if (t.socket !== socket) return;
    t.socket = null;
    t.gone = Date.now();
    console.log(`[relay] host gone: ${t.id.slice(0, 6)}…`);
    for (const [sid, s] of t.streams) { t.streams.delete(sid); if (s.started) s.res.destroy(); else refuse(s.res, 502, 'The office lost its connection.'); }
  };
  socket.on('close', down);
  socket.on('error', down);
  // An http server's sockets are half-open by default, so a host hanging up politely would
  // otherwise leave this one looking connected, and its visitors waiting on it.
  socket.on('end', () => socket.destroy());
  return undefined;
}

const tls = process.env.CREW_RELAY_TLS_CERT && process.env.CREW_RELAY_TLS_KEY ? { cert: fs.readFileSync(process.env.CREW_RELAY_TLS_CERT), key: fs.readFileSync(process.env.CREW_RELAY_TLS_KEY) } : null;
const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.on('clientError', (err, socket) => socket.destroy());
// Long-lived streams are the point; a request that sends nothing for this long is not one.
server.headersTimeout = 20_000;
server.requestTimeout = 0;
setInterval(() => {
  const now = Date.now();
  for (const t of [...tunnels.values()]) if (!t.socket && now - (t.gone ?? 0) > REMEMBER_MS) forget(t);
  for (const [hash, c] of codes) if (c.expiresAt < now) { codes.delete(hash); tunnels.get(c.tunnelId)?.codes.delete(hash); }
}, 3600_000).unref();
// A host pings every 15 s. One that has stopped is holding a socket and every visitor who is
// waiting on it, so hang up, and they get the offline page rather than a spinner.
setInterval(() => { for (const t of connected()) if (Date.now() - t.seen > QUIET_MS) t.socket.destroy(); }, 15_000).unref();
server.listen(port, () => console.log(`[relay] listening on ${port}${DOMAIN ? ` for *.${DOMAIN}` : ', serving one office'}${tls ? ' with TLS' : ', behind a TLS proxy or on a trusted network'}${OPEN ? ', open to any host' : ''}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
