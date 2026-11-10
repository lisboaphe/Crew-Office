'use strict';
// The chat line for a finished task is its report's opening, not the report (lib/crew/brief.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { brief } = require('../lib/crew/brief.cjs');

test('a document-shaped report becomes its first plain sentences', () => {
  const report = [
    '# Result — Deliver runtime-verified combat demo (Al)',
    '',
    'The combat demo launches and plays. With Godot 4.7.2 I ran the real main scene in a window. Scripted mouse clicks on the game window confirmed start, card play, reality shift, end turn, victory, defeat and restart.',
    '',
    '## Changed',
    '- tests/combat/test_ui_model_integration.gd: the shared UI matcher now checks the exact inactive Sanity notice',
  ].join('\n');
  const out = brief(report);
  assert.equal(out, 'The combat demo launches and plays. With Godot 4.7.2 I ran the real main scene in a window.');
  assert.ok(!out.includes('tests/'));
});

test('stays within the limit, cutting a long single sentence at a word', () => {
  const out = brief(`This ${'very '.repeat(80)}long sentence never ends`);
  assert.ok(out.length <= 241, out.length);
  assert.ok(out.endsWith('…'));
});

test('skips lists, code and verdict lines to find prose', () => {
  assert.equal(brief('VERDICT: approve\n\n```\nnpm test\n```\n\n- a\n- b\n\nLooks good. Ship it. Extra.'), 'Looks good. Ship it.');
});

test('nothing readable gives nothing', () => {
  assert.equal(brief('# Title\n\n- src/a.js\n- src/b.js'), '');
  assert.equal(brief(''), '');
});
