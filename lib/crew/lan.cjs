// LAN discovery: a hosted office announces itself on the local network, and any copy of
// the app on the same network lists it under "Join Office → On your network".
//
// A UDP broadcast every few seconds carrying the room's name, its code, the player count
// and the URL to reach this host. Only rooms whose privacy is `lan` or `password` are
// announced; invite-only rooms never are. Broadcasts do not cross routers, so this finds
// friends on the same Wi-Fi or switch and nobody else — remote play needs an address.

'use strict';

const dgram = require('dgram');
const os = require('os');

const PORT = Number(process.env.CREW_LAN_PORT || 41234);
const EVERY_MS = 4000;
const FORGET_MS = 15_000;

/** Every IPv4 address another machine could use to reach this one. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function createLan({ getRooms, port, log = () => {} }) {
  const heard = new Map();   // key -> { room, at }
  let socket = null;
  let timer = null;

  function start() {
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (err) => { log(`[lan] discovery off: ${err.message}`); stop(); });
      socket.on('message', (buf, rinfo) => {
        try {
          const msg = JSON.parse(buf.toString('utf8'));
          if (msg?.app !== 'crew-office' || !Array.isArray(msg.rooms)) return;
          for (const r of msg.rooms.slice(0, 20)) {
            const url = `http://${rinfo.address}:${Number(msg.port)}`;
            heard.set(`${url}|${r.code}`, { room: { name: String(r.name).slice(0, 60), code: String(r.code).slice(0, 12), players: r.players | 0, maxPlayers: r.maxPlayers | 0, privacy: r.privacy, hasPassword: Boolean(r.hasPassword), host: url }, at: Date.now() });
          }
        } catch { /* not ours */ }
      });
      socket.bind(PORT, () => {
        try { socket.setBroadcast(true); } catch {}
        timer = setInterval(announce, EVERY_MS);
        timer.unref?.();
        announce();
      });
      socket.unref?.();
    } catch (err) {
      log(`[lan] discovery off: ${err.message}`);
    }
  }

  function announce() {
    if (!socket) return;
    const rooms = getRooms().map((r) => ({ name: r.name, code: r.code, players: r.players, maxPlayers: r.maxPlayers, privacy: r.privacy, hasPassword: r.hasPassword }));
    if (!rooms.length) return;
    const buf = Buffer.from(JSON.stringify({ app: 'crew-office', v: 1, port, rooms }));
    try { socket.send(buf, PORT, '255.255.255.255'); } catch {}
  }

  function rooms() {
    const now = Date.now();
    const own = new Set(lanAddresses().concat('127.0.0.1').map((a) => `http://${a}:${port}`));
    const out = [];
    for (const [k, v] of heard) {
      if (now - v.at > FORGET_MS) { heard.delete(k); continue; }
      out.push({ ...v.room, local: own.has(v.room.host) });
    }
    return out;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { socket?.close(); } catch {}
    socket = null;
  }

  return { start, stop, rooms };
}

module.exports = { createLan, lanAddresses };
