// Loaded first in the process sandbox: takes away the network from code the sandbox runs.
//
// Node's permission model covers files and child processes, not sockets, so this replaces the
// entry points instead. Tests may start a server of their own and talk to it, which real
// integration tests need. Nothing else is reachable, and "localhost" alone would not be good enough:
// the worker's own settings page and the office both listen there.
//
// With process.binding refused by the permission model and internal modules out of reach, ordinary
// code has no other way to a socket. It is still a guard inside the process rather than a wall
// around it, which is why code from another player needs Docker unless the owner has accepted
// that. See docs/security/SANDBOXING.md.

'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');

const blocked = (what) => { const e = new Error(`Network access is blocked in this sandbox (${what}).`); e.code = 'ERR_SANDBOX_NETWORK'; return e; };
const seal = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: false, configurable: false });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', undefined, null, '']);
const myPorts = new Set();

const realConnect = net.Socket.prototype.connect;
seal(net.Socket.prototype, 'connect', function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(typeof first === 'object' && first ? first.port : first);
  const host = typeof first === 'object' && first ? first.host : args[1];
  if ((typeof first === 'object' && first?.path) || !myPorts.has(port) || !LOOPBACK.has(typeof host === 'string' ? host : undefined)) throw blocked(`connect to ${host ?? 'localhost'}:${port}`);
  return realConnect.apply(this, args);
});

const realListen = net.Server.prototype.listen;
seal(net.Server.prototype, 'listen', function listen(...args) {
  this.once('listening', () => { const a = this.address(); if (a?.port) myPorts.add(a.port); });
  // Only ever on this computer's loopback, whatever the code asked for.
  if (typeof args[0] === 'object' && args[0]) {
    if (args[0].path) throw blocked('listen on a pipe');
    args[0] = { ...args[0], host: '127.0.0.1' };
  } else if (typeof args[0] === 'number' || typeof args[0] === 'string') {
    const callback = args.find((a) => typeof a === 'function');
    if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) throw blocked('listen on a pipe');
    return realListen.call(this, Number(args[0]), '127.0.0.1', callback);
  } else {
    const callback = args.find((a) => typeof a === 'function');
    return realListen.call(this, 0, '127.0.0.1', callback);
  }
  return realListen.apply(this, args);
});

for (const m of ['bind', 'send', 'connect']) seal(dgram.Socket.prototype, m, () => { throw blocked('udp'); });

// Names resolve only to this computer, so a lookup cannot carry data out in a DNS query.
dns.lookup = (host, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  if (host !== 'localhost' && host !== '127.0.0.1') return process.nextTick(cb, blocked(`dns ${host}`));
  return process.nextTick(cb, null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
};
for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveMx']) dns[m] = () => { throw blocked('dns'); };
if (dns.promises) { dns.promises.resolve = () => Promise.reject(blocked('dns')); dns.promises.lookup = () => Promise.reject(blocked('dns')); }
