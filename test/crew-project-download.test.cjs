// Downloading a project's files in one go, and the host's folder, which only the host may see.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { makeZip } = require('../lib/crew/zip.cjs');
const { startHost, player } = require('./lib/crew-harness.cjs');

/** The names and contents in a zip, read from its central directory. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'has an end record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(zlib.crc32(data), crc, `${name}: checksum`);
    out[name] = data;
    at += 46 + nameLen;
  }
  return out;
}

test('a zip holds every file exactly, small or squashable, with its name in any language', () => {
  const big = Buffer.from('frame '.repeat(5000));
  const noise = crypto.randomBytes(3000);
  const files = readZip(makeZip([
    { name: 'Agents’ work/character.js', data: big },
    { name: 'Office files/art/ü-sheet.png', data: noise },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]));
  assert.deepEqual(Object.keys(files), ['Agents’ work/character.js', 'Office files/art/ü-sheet.png', 'empty.txt']);
  assert.ok(files['Agents’ work/character.js'].equals(big));
  assert.ok(files['Office files/art/ü-sheet.png'].equals(noise));
  assert.equal(files['empty.txt'].length, 0);
});

test('a project downloads as one zip, for those who may see it; its folder is the host’s alone', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  const carol = player(host.url);
  t.after(async () => { alice.leaveAll(); carol.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  await carol.post('/api/crew/register', { username: 'carol', password: 'carol-pass-1', displayName: 'Carol' });
  const { room } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  await carol.post('/api/crew/rooms/join', { code: room.code });
  const R = `/api/crew/rooms/${room.id}`;
  const a = (await alice.post(`${R}/agents`, { name: 'P', role: 'PM', provider: 'scripted', model: 'scripted' })).agent;
  const { project } = await alice.post(`${R}/projects`, { name: 'Yomi Hustle', goal: 'g', managerAgentId: a.id });
  const U = `${R}/projects/${project.id}`;

  assert.equal((await alice.get(`${U}/download.zip`)).status, 404, 'nothing to download yet');

  const data = Buffer.from('a sprite sheet, as far as this test is concerned');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const begun = await alice.post(`${U}/uploads`, { path: 'art/sheet.png', size: data.length, sha256: sha });
  assert.equal((await alice.raw('PUT', `${U}/uploads/${begun.uploadId}/chunks/0`, data)).status, 200);
  assert.equal((await alice.post(`${U}/uploads/${begun.uploadId}/finalize`)).file.version, 1);

  const res = await alice.rawGet(`${U}/download.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /filename="Yomi Hustle\.zip"/);
  const files = readZip(res.body);
  assert.ok(files['Office files/art/sheet.png'].equals(data));

  assert.equal((await carol.get(`${U}/download.zip`)).status, 403, 'not on the project, not an admin');

  // Alice is in the room from a browser, not the host's own app: no path, and nothing opened.
  assert.deepEqual((await alice.get(`${U}/folder`)).folder, null);
  assert.equal((await alice.post(`${U}/folder/open`)).status, 403);
});
