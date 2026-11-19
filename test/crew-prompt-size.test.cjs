// A task prompt carries a bounded slice of the project, and says where the rest is.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { promptFiles, PROMPT_FILES } = require('../lib/crew/work.cjs');
const { taskPrompt } = require('../lib/crew-worker/runner.cjs');

test('a big project lists a bounded set of files, the ones the task needs first', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${String(i).padStart(3, '0')}.js`, createdAt: i }));
  const { shown, more } = promptFiles(rows, ['src/f000.js', 'src/f001.js']);
  assert.strictEqual(shown.length, PROMPT_FILES);
  assert.strictEqual(more, 300 - PROMPT_FILES);
  assert.ok(shown.includes('src/f000.js') && shown.includes('src/f001.js'), 'deliverables and inputs come first, however old');
  assert.ok(shown.includes('src/f299.js'), 'then the newest');
  assert.ok(!shown.includes('src/f100.js'));
});

test('a small project lists everything and mentions nothing more', () => {
  assert.deepStrictEqual(promptFiles([{ path: 'b.md' }, { path: 'a.md' }]), { shown: ['a.md', 'b.md'], more: 0 });
});

test('the prompt says how many files were left out and how to see them', () => {
  const ctx = { project: { files: ['a.md'], filesMore: 12 } };
  assert.match(taskPrompt(ctx), /Project files: a\.md \(and 12 more; list_files shows them all\)/);
  assert.doesNotMatch(taskPrompt({ project: { files: ['a.md'], filesMore: 0 } }), /more/);
});
