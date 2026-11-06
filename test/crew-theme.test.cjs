// The office's own panels read colours from variables, and the multiplayer theme replaces those. Replacing
// only some of them gives light text on a white menu, which nothing else would notice.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'crew', 'crew.css'), 'utf8');

test('the panels that take the theme’s text colour also take its surfaces', () => {
  const rule = /#title-bar, #agent-panel[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const name of ['--text', '--muted', '--border', '--panel', '--panel-solid']) assert.match(rule, new RegExp(`${name}:`), `${name} is themed`);
});

test('the top-right controls sit on the same line as the office’s own', () => {
  const office = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const titleTop = /#title-bar \{[^}]*top: (\d+)px/.exec(office)?.[1];
  const barTop = /#crew-bar \{ position: fixed; top: (\d+)px/.exec(css)?.[1];
  assert.ok(titleTop);
  assert.strictEqual(barTop, titleTop);
});
