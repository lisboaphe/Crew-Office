import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAmbient } from '../src/office2d/ambient.js';

const plan = (action = 'coffee') => ({
  path: [{ x: 0, y: 0 }, { x: 46, y: 0 }],
  spot: { action },
});
const run = (ambient, bots, seconds, planFor = () => plan()) => {
  for (let t = 0; t < seconds; t += 0.1) ambient.update(0.1, bots, planFor);
};

test('a working agent is never sent on a break', () => {
  const ambient = createAmbient({ random: () => 0 });
  run(ambient, [{ id: 'a', idle: false }], 200);
  assert.equal(ambient.whereIs('a'), null);
  assert.equal(ambient.awayCount, 0);
});

test('an idle agent goes, pauses, and comes back to their desk', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bots = [{ id: 'a', idle: true }];
  run(ambient, bots, 14.2);
  assert.ok(ambient.whereIs('a'), 'has left the desk');
  run(ambient, bots, 1.2);
  assert.equal(ambient.whereIs('a').phase, 'at');
  assert.equal(ambient.whereIs('a').moving, false);
  run(ambient, bots, 3.2);
  assert.equal(ambient.whereIs('a').phase, 'back');
  assert.equal(ambient.whereIs('a').holding, true, 'with the drink they went for');
  run(ambient, bots, 1.2);
  assert.equal(ambient.whereIs('a'), null);
});

test('real work brings an agent straight back', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, plan());
  run(ambient, [bot], 2);
  assert.equal(ambient.whereIs('a').phase, 'at');
  bot.idle = false;
  run(ambient, [bot], 0.1);
  assert.equal(ambient.whereIs('a').phase, 'back');
  run(ambient, [bot], 1);
  assert.equal(ambient.whereIs('a'), null);
});

test('it never changes the agent it is drawing', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = Object.freeze({ id: 'a', idle: true, status: 'idle', job: null });
  run(ambient, [bot], 60);
  assert.deepEqual(bot, { id: 'a', idle: true, status: 'idle', job: null });
});

test('two agents at the break area chat, then both go back', () => {
  const ambient = createAmbient({ random: () => 0 });
  const a = { id: 'a', idle: true };
  const b = { id: 'b', idle: true };
  ambient.sendNow(a, { path: [{ x: 0, y: 0 }, { x: 10, y: 0 }], spot: { action: 'water' } });
  ambient.sendNow(b, { path: [{ x: 40, y: 0 }, { x: 30, y: 0 }], spot: { action: 'coffee' } });
  run(ambient, [a, b], 1);
  assert.equal(ambient.whereIs('a').talking, true);
  assert.equal(ambient.whereIs('b').talking, true);
  assert.equal(ambient.whereIs('a').direction, 1, 'facing each other');
  assert.equal(ambient.whereIs('b').direction, -1);
  run(ambient, [a, b], 12);
  assert.equal(ambient.awayCount, 0);
});

test('somebody at the break area waits for a colleague on the way, and they chat', () => {
  const ambient = createAmbient({ random: () => 0 });
  const a = { id: 'a', idle: true };
  const b = { id: 'b', idle: true };
  ambient.sendNow(a, { path: [{ x: 0, y: 0 }, { x: 10, y: 0 }], spot: { action: 'water' } });
  ambient.sendNow(b, { path: [{ x: 500, y: 0 }, { x: 30, y: 0 }], spot: { action: 'coffee' } });
  run(ambient, [a, b], 8);
  assert.equal(ambient.whereIs('a').phase, 'at', 'still waiting, past their usual pause');
  run(ambient, [a, b], 3);
  assert.equal(ambient.whereIs('a').talking, true);
  assert.equal(ambient.whereIs('b').talking, true);
});

test('only a couple of agents are away at once', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bots = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, idle: true }));
  let most = 0;
  for (let t = 0; t < 40; t += 0.1) {
    ambient.update(0.1, bots, () => plan());
    most = Math.max(most, ambient.awayCount);
  }
  assert.equal(most, 2);
});

test('an agent who leaves the office stops being drawn on a break', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, plan());
  ambient.update(0.1, [], () => null);
  assert.equal(ambient.whereIs('a'), null);
});
