// The wire format between a host and its relay: one connection, many requests over it.
//
//   type (1 byte) | stream id (4 bytes) | length (4 bytes) | payload
//
// Deliberately small. Everything here is HTTP going through, so there is nothing else to frame.

'use strict';

const TYPE = { OPEN: 1, DATA: 2, END: 3, ABORT: 4, RESPONSE: 5, PING: 6, PONG: 7 };
const HEADER = 9;
const MAX_FRAME = 256 * 1024;
const CHUNK = 64 * 1024;

function frame(type, stream, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const head = Buffer.allocUnsafe(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(stream, 1);
  head.writeUInt32BE(body.length, 5);
  return Buffer.concat([head, body]);
}

/** Feed it bytes; it calls back with whole frames. A frame that lies about its size ends things. */
function createParser(onFrame, onBad) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= HEADER) {
      const length = buffered.readUInt32BE(5);
      if (length > MAX_FRAME) { onBad(new Error(`A frame of ${length} bytes is larger than allowed.`)); return; }
      if (buffered.length < HEADER + length) return;
      const type = buffered.readUInt8(0);
      const stream = buffered.readUInt32BE(1);
      onFrame(type, stream, buffered.subarray(HEADER, HEADER + length));
      buffered = buffered.subarray(HEADER + length);
    }
  };
}

/** Large bodies go in pieces, so one big upload cannot starve everyone else on the connection. */
function* chunks(buf) {
  for (let i = 0; i < buf.length; i += CHUNK) yield buf.subarray(i, i + CHUNK);
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** Headers safe to pass on: nothing about this hop, and nothing that claims to be from the relay. */
function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith('x-crew-relay') || key === 'x-crew-client-ip') continue;
    out[key] = v;
  }
  return out;
}

module.exports = { TYPE, frame, createParser, chunks, cleanHeaders, MAX_FRAME };
