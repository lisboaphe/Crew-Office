// An uploaded .zip is unpacked for the agents: its text goes into the project's files, where they
// read, and nothing in an archive can climb out of its folder, pose as text, or swell past its size.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { makeZip, readZip } = require('../lib/crew/zip.cjs');
const { startHost, player } = require('./lib/crew-harness.cjs');

test('a path that climbs out of the archive is never read', () => {
  const zip = makeZip([{ name: 'ok/a.txt', data: Buffer.from('fine') }, { name: '../../evil.txt', data: Buffer.from('no') }, { name: 'C:/x.txt', data: Buffer.from('no') }]);
  const { files, skipped } = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['ok/a.txt']);
  assert.deepEqual(skipped.map((s) => s.name).sort(), ['../../evil.txt', 'C:/x.txt']);
});

test('an entry that unpacks past the size it claims is refused, so a small zip cannot become a huge one', () => {
  const zip = makeZip([{ name: 'bomb.txt', data: Buffer.alloc(200_000, 65) }]);
  // Make the archive claim the entry is only 10 bytes, in both of its records.
  const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(10, central + 24);
  zip.writeUInt32LE(10, 22);
  const { files, skipped } = readZip(zip);
  assert.equal(files.length, 0);
  assert.equal(skipped[0].name, 'bomb.txt');
});

test('something that is not a zip says so', () => {
  assert.throws(() => readZip(Buffer.from('just text, not an archive at all')), /not a \.zip/);
  assert.throws(() => readZip(zlib.deflateRawSync(Buffer.from('x'))), /not a \.zip/);
});

test('an uploaded .zip is unpacked for the agents, text only, and can be unpacked again', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  t.after(async () => { alice.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  const { room } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  const R = `/api/crew/rooms/${room.id}`;
  const a = (await alice.post(`${R}/agents`, { name: 'P', role: 'PM', provider: 'scripted', model: 'scripted' })).agent;
  const { project } = await alice.post(`${R}/projects`, { name: 'Mod', goal: 'g', managerAgentId: a.id });
  const U = `${R}/projects/${project.id}`;

  // As GitHub makes them: everything inside one folder named after the repository.
  const zip = makeZip([
    { name: 'YHModAssistant-main/README.md', data: Buffer.from('# Mod assistant\n') },
    { name: 'YHModAssistant-main/addons/YHMA/plugin.cfg', data: Buffer.from('[plugin]\nname="YHMA"\n') },
    { name: 'YHModAssistant-main/addons/YHMA/Fonts/OpenSans.ttf', data: Buffer.from([0, 1, 0, 0, 0, 4, 0, 0x80]) },
    { name: 'YHModAssistant-main/../escape.txt', data: Buffer.from('no') },
  ]);
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const begun = await alice.post(`${U}/uploads`, { path: 'uploads/YHModAssistant-main.zip', size: zip.length, sha256: sha });
  assert.equal((await alice.raw('PUT', `${U}/uploads/${begun.uploadId}/chunks/0`, zip)).status, 200);
  const done = await alice.post(`${U}/uploads/${begun.uploadId}/finalize`);
  assert.equal(done.file.version, 1, 'the upload itself stands');
  assert.deepEqual(done.unpacked, { folder: 'uploads/YHModAssistant-main', unpacked: 2, left: 2 });

  const state = await alice.get(`${R}/state`);
  const paths = state.artifacts.filter((f) => f.projectId === project.id).map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'uploads/YHModAssistant-main/README.md',
    'uploads/YHModAssistant-main/UNPACKED.md',
    'uploads/YHModAssistant-main/addons/YHMA/plugin.cfg',
  ], 'its one top folder is not repeated, and only text is unpacked');
  const plugin = await alice.text(`${U}/files/${encodeURIComponent('uploads/YHModAssistant-main/addons/YHMA/plugin.cfg')}`);
  assert.equal(plugin.text, '[plugin]\nname="YHMA"\n');
  const note = (await alice.text(`${U}/files/${encodeURIComponent('uploads/YHModAssistant-main/UNPACKED.md')}`)).text;
  assert.match(note, /OpenSans\.ttf: not text/);
  assert.match(note, /escape\.txt: its path leaves the archive/);

  // The same upload, unpacked again on request, replaces rather than adds.
  const again = await alice.post(`${U}/blobs/${done.file.id}/unpack`);
  assert.equal(again.unpacked, 2);
  const after = (await alice.get(`${R}/state`)).artifacts.filter((f) => f.projectId === project.id);
  assert.equal(after.length, 3);
});
