// An uploaded Word document's text is copied into the project's files as Markdown, so agents can
// read rules and briefs people wrote in Word.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeZip } = require('../lib/crew/zip.cjs');
const { docxToMarkdown } = require('../lib/crew/docx.cjs');
const { startHost, player } = require('./lib/crew-harness.cjs');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const style = (s) => `<w:pStyle w:val="${s}"/>`;
const item = (lvl) => `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="1"/></w:numPr>`;
const cell = (t) => `<w:tc>${para(t)}</w:tc>`;

function docx(body) {
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`) },
  ]);
}

const SAMPLE = docx([
  para('Pixel Art Rules', style('Title')),
  para('Regras', style('Ttulo1')),
  para('Keep pixels crisp &amp; stable &lt;always&gt;.'),
  para('Never blur', item(0)),
  para('Not even a little', item(1)),
  para('Use Aseprite', item(0)),
  `<w:p><w:r><w:t>Frame</w:t></w:r><w:r><w:tab/><w:t>Time</w:t><w:br/><w:t>next line</w:t></w:r></w:p>`,
  `<w:tbl><w:tr>${cell('Pose')}${cell('Frames')}</w:tr><w:tr>${cell('Idle')}${cell('4 | loop')}</w:tr></w:tbl>`,
  '<w:p/>',
  para('Café ✓ &#233;&#x2713;', style('Heading2')),
].join(''));

test('a Word document becomes Markdown with its headings, lists, tables and breaks', () => {
  assert.equal(docxToMarkdown(SAMPLE), [
    '# Pixel Art Rules', '',
    '# Regras', '',
    'Keep pixels crisp & stable <always>.', '',
    '- Never blur',
    '  - Not even a little',
    '- Use Aseprite', '',
    'Frame\tTime\nnext line', '',
    '| Pose | Frames |',
    '| --- | --- |',
    '| Idle | 4 \\| loop |', '',
    '## Café ✓ é✓', '',
  ].join('\n'));
});

test('something that is not a Word document says so', () => {
  assert.throws(() => docxToMarkdown(makeZip([{ name: 'a.txt', data: Buffer.from('x') }])), /not a Word document/);
  assert.throws(() => docxToMarkdown(Buffer.from('an old binary .doc')), /not a \.zip/);
});

test('an uploaded .docx gets a text copy the agents can read, made again on request', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  t.after(async () => { alice.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  const { room } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  const R = `/api/crew/rooms/${room.id}`;
  const a = (await alice.post(`${R}/agents`, { name: 'P', role: 'PM', provider: 'scripted', model: 'scripted' })).agent;
  const { project } = await alice.post(`${R}/projects`, { name: 'Game', goal: 'g', managerAgentId: a.id });
  const U = `${R}/projects/${project.id}`;

  const upload = async (path, buf) => {
    const begun = await alice.post(`${U}/uploads`, { path, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    assert.equal((await alice.raw('PUT', `${U}/uploads/${begun.uploadId}/chunks/0`, buf)).status, 200);
    return alice.post(`${U}/uploads/${begun.uploadId}/finalize`);
  };

  const done = await upload('uploads/Rules.docx', SAMPLE);
  assert.equal(done.file.version, 1, 'the upload itself stands');
  assert.deepEqual(done.unpacked, { file: 'uploads/Rules.md', chars: docxToMarkdown(SAMPLE).length, cut: false });
  const copy = (await alice.text(`${U}/files/${encodeURIComponent('uploads/Rules.md')}`)).text;
  assert.match(copy, /^> The text of uploads\/Rules\.docx, copied by Alice/);
  assert.match(copy, /- Never blur\n {2}- Not even a little/);

  const again = await alice.post(`${U}/blobs/${done.file.id}/unpack`);
  assert.equal(again.file, 'uploads/Rules.md');
  const mine = (await alice.get(`${R}/state`)).artifacts.filter((f) => f.projectId === project.id).map((f) => f.path);
  assert.deepEqual(mine, ['uploads/Rules.md'], 'doing it again replaces the copy');

  // A file named .docx that is not one is still uploaded, and says why the agents cannot read it.
  const bad = await upload('uploads/old.docx', Buffer.from('an old Word 97 file'));
  assert.equal(bad.file.version, 1);
  assert.match(bad.unpacked.error, /not a Word document.*saved as \.docx/);
});
