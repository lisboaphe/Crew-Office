// Building blocks for driving a room from code: a player with a cookie jar and a live
// presence stream, and an in-process worker. Used by bin/crew-demo.cjs and the tests.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnection } = require('../crew-worker/worker.cjs');
const { createLocalTools } = require('../crew-worker/local-tools.cjs');
const { createVault } = require('../crew-worker/vault.cjs');

function player(url) {
  let cookie = '';
  const streams = [];
  async function req(method, p, body) {
    const res = await fetch(url + p, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-Crew': '1', 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  return {
    req,
    async text(p) { const res = await fetch(url + p, { headers: cookie ? { Cookie: cookie } : {} }); return { status: res.status, text: await res.text() }; },
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    patch: (p, b) => req('PATCH', p, b ?? {}),
    del: (p) => req('DELETE', p),
    /** Open the room's realtime stream: this is the player "being in the office". */
    async enter(roomId) {
      const ac = new AbortController();
      const events = [];
      const res = await fetch(`${url}/api/crew/rooms/${roomId}/events`, { headers: { Cookie: cookie }, signal: ac.signal });
      (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, i); buf = buf.slice(i + 2);
              const ev = frame.match(/^event: (.+)$/m)?.[1];
              const data = frame.match(/^data: (.+)$/m)?.[1];
              if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
            }
          }
        } catch {}
      })();
      const s = { events, leave: () => ac.abort() };
      streams.push(s);
      return s;
    },
    leaveAll() { for (const s of streams) s.leave(); },
  };
}

function startWorker({ hostUrl, token, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-worker-')), secrets = {}, log = () => {} }) {
  const vault = createVault(dir);
  for (const [p, v] of Object.entries(secrets)) vault.set(p, 'apiKey', v);
  const conn = createConnection({ hostUrl, token, vault, dataDir: dir, concurrency: 4, log, localToolsFor: (host) => createLocalTools({ dataDir: dir, host }) });
  conn.start();
  return { conn, dir, stop: () => conn.stop() };
}

module.exports = { player, startWorker };
