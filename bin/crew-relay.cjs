#!/usr/bin/env node
// The relay: lets someone on the internet reach an office on a computer behind a home router.
//
// The host dials out to here and keeps that connection open. Visitors reach the relay, and their
// requests travel down that connection. So nobody forwards a port, and CGNAT is no obstacle.
//
//   CREW_RELAY_KEY=<secret> node bin/crew-relay.cjs 8443
//
// It stores nothing: no projects, files, repositories or credentials, and a restart forgets every
// tunnel. It does see requests pass through once TLS ends here, so it has to be run by someone the
// players trust. docs/security/NETWORK_SECURITY.md says what that means.
//
// Settings, all from the environment:
//   CREW_RELAY_KEY     hosts must present this to connect. Required unless CREW_RELAY_OPEN=1
//   CREW_RELAY_DOMAIN  e.g. relay.example.com: each office gets <id>.relay.example.com, which
//                      needs a wildcard DNS record and certificate. Without it, the relay serves
//                      one office on its whole address, which needs neither
//   CREW_RELAY_TLS_CERT, CREW_RELAY_TLS_KEY   terminate TLS here, instead of behind a proxy
//   CREW_RELAY_TRUST_PROXY=1   take the visitor's address from X-Forwarded-For

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { TYPE, frame, createParser, chunks, cleanHeaders } = require('../lib/relay/frames.cjs');

const port = Number(process.argv[2]) || Number(process.env.PORT) || 8443;
const KEY = process.env.CREW_RELAY_KEY || '';
const OPEN = process.env.CREW_RELAY_OPEN === '1';
const DOMAIN = (process.env.CREW_RELAY_DOMAIN || '').toLowerCase();
const TRUST_PROXY = process.env.CREW_RELAY_TRUST_PROXY === '1';
const MAX_TUNNELS = Number(process.env.CREW_RELAY_MAX_TUNNELS) || 50;
const MAX_STREAMS = Number(process.env.CREW_RELAY_MAX_STREAMS) || 200;
const MAX_REQUESTS_PER_MIN = Number(process.env.CREW_RELAY_RATE) || 1200;
const MAX_BODY = 512 * 1024 * 1024;
const REMEMBER_MS = 24 * 3600_000;

if (!KEY && !OPEN) {
  console.error('Refusing to start: set CREW_RELAY_KEY so that only your hosts can use this relay, or CREW_RELAY_OPEN=1 if you really mean anyone.');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(sha(a)); const y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };

/** id -> { secretHash, socket, streams, nextStream, seen } */
const tunnels = new Map();
const hits = new Map();

function limited(ip) {
  const minute = Math.floor(Date.now() / 60_000);
  const k = `${ip}:${minute}`;
  const n = (hits.get(k) ?? 0) + 1;
  hits.set(k, n);
  if (hits.size > 50_000) hits.clear();
  return n > MAX_REQUESTS_PER_MIN;
}

const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

function tunnelFor(req) {
  if (!DOMAIN) return [...tunnels.values()].find((t) => t.socket) ?? null;
  const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
  if (!host.endsWith(`.${DOMAIN}`)) return null;
  const t = tunnels.get(host.slice(0, -DOMAIN.length - 1));
  return t?.socket ? t : null;
}

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Office offline</title>
<style>body{font:16px system-ui;background:#0e1016;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:24px;text-align:center}p{color:#a0a7b6}</style>
<main><h1>This office is not online right now</h1><p>Its host may have closed Crew Office, or lost its connection. Nothing is lost: ask them to open it again, and this link will work.</p></main><script>setTimeout(()=>location.reload(),10000)</script>`;

function refuse(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function handleRequest(req, res) {
  const url = req.url;
  if (url === '/_relay/health') return res.end(JSON.stringify({ ok: true, tunnels: [...tunnels.values()].filter((t) => t.socket).length }));
  const ip = clientIp(req);
  if (limited(ip)) return refuse(res, 429, 'Too many requests. Wait a moment.');
  const t = tunnelFor(req);
  if (!t) {
    if ((req.headers.accept ?? '').includes('text/html')) { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(OFFLINE); }
    return refuse(res, 503, 'This office is not online right now.');
  }
  if (t.streams.size >= MAX_STREAMS) return refuse(res, 503, 'This office is too busy right now.');
  const id = (t.nextStream += 2);
  const stream = { res, started: false };
  t.streams.set(id, stream);
  const write = (type, payload) => { if (t.socket && !t.socket.destroyed) return t.socket.write(frame(type, id, payload)); return true; };
  write(TYPE.OPEN, { method: req.method, url, headers: { ...cleanHeaders(req.headers), 'x-forwarded-for': ip, 'x-forwarded-proto': req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http' }, ip });
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { write(TYPE.ABORT); req.destroy(); return; }
    for (const piece of chunks(chunk)) if (write(TYPE.DATA, piece) === false) { req.pause(); t.socket.once('drain', () => req.resume()); }
  });
  req.on('end', () => write(TYPE.END));
  const gone = () => { if (t.streams.delete(id)) write(TYPE.ABORT); };
  res.on('close', gone);
  return undefined;
}

function handleUpgrade(req, socket) {
  const fail = (line) => { socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  const url = new URL(req.url, 'http://relay');
  if (url.pathname !== '/_relay/connect') return fail('404 Not Found');
  if (KEY && !same(req.headers['x-crew-relay-key'] ?? '', KEY)) { console.log(`[relay] refused a host from ${clientIp(req)}: wrong key`); return fail('401 Unauthorized'); }
  if (limited(`connect:${clientIp(req)}`)) return fail('429 Too Many Requests');

  // A host keeps its address across reconnects by proving it holds the secret it was given.
  let id = String(req.headers['x-crew-tunnel-id'] ?? '').toLowerCase();
  const secret = String(req.headers['x-crew-tunnel-secret'] ?? '');
  let t = id ? tunnels.get(id) : null;
  if (t && !same(secret, t.secretRaw)) return fail('403 Forbidden');
  if (!DOMAIN && tunnels.size && !t && [...tunnels.values()].some((x) => x.socket)) return fail('409 Conflict');
  if (!t) {
    if (tunnels.size >= MAX_TUNNELS) return fail('503 Service Unavailable');
    id = /^[a-z2-7]{20,32}$/.test(id) && secret.length >= 32 ? id : crypto.randomBytes(13).toString('hex').slice(0, 26);
    t = { id, secretRaw: secret.length >= 32 ? secret : crypto.randomBytes(32).toString('hex'), streams: new Map(), nextStream: 0, socket: null };
    tunnels.set(id, t);
  }
  if (t.socket) t.socket.destroy();
  t.socket = socket;
  t.seen = Date.now();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: crew-relay\r\nConnection: Upgrade\r\nX-Crew-Tunnel-Id: ${id}\r\nX-Crew-Tunnel-Secret: ${t.secretRaw}\r\nX-Crew-Tunnel-Domain: ${DOMAIN}\r\n\r\n`);
  console.log(`[relay] host connected: ${id.slice(0, 6)}…`);

  const parse = createParser((type, stream, payload) => {
    t.seen = Date.now();
    if (type === TYPE.PING) { socket.write(frame(TYPE.PONG, 0, payload)); return; }
    const s = t.streams.get(stream);
    if (!s) return;
    if (type === TYPE.RESPONSE) {
      const head = JSON.parse(payload.toString());
      s.started = true;
      s.res.writeHead(head.status, cleanHeaders(head.headers));
      if (s.res.flushHeaders) s.res.flushHeaders();
    } else if (type === TYPE.DATA) {
      if (s.res.write(payload) === false) { socket.pause(); s.res.once('drain', () => socket.resume()); }
    } else if (type === TYPE.END) { t.streams.delete(stream); s.res.end(); } else if (type === TYPE.ABORT) { t.streams.delete(stream); if (s.started) s.res.destroy(); else refuse(s.res, 502, 'The office could not answer that.'); }
  }, (err) => { console.log(`[relay] dropping a host: ${err.message}`); socket.destroy(); });
  socket.on('data', parse);
  const down = () => {
    if (t.socket !== socket) return;
    t.socket = null;
    t.gone = Date.now();
    console.log(`[relay] host gone: ${id.slice(0, 6)}…`);
    for (const [sid, s] of t.streams) { t.streams.delete(sid); if (s.started) s.res.destroy(); else refuse(s.res, 502, 'The office lost its connection.'); }
  };
  socket.on('close', down);
  socket.on('error', down);
  return undefined;
}

const tls = process.env.CREW_RELAY_TLS_CERT && process.env.CREW_RELAY_TLS_KEY ? { cert: fs.readFileSync(process.env.CREW_RELAY_TLS_CERT), key: fs.readFileSync(process.env.CREW_RELAY_TLS_KEY) } : null;
const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.on('clientError', (err, socket) => socket.destroy());
// Long-lived streams are the point; a request that sends nothing for this long is not one.
server.headersTimeout = 20_000;
server.requestTimeout = 0;
setInterval(() => { for (const [id, t] of tunnels) if (!t.socket && Date.now() - (t.gone ?? 0) > REMEMBER_MS) tunnels.delete(id); }, 3600_000).unref();
server.listen(port, () => console.log(`[relay] listening on ${port}${DOMAIN ? ` for *.${DOMAIN}` : ', serving one office'}${tls ? ' with TLS' : ', behind a TLS proxy or on a trusted network'}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
