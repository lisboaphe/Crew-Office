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
/** The same answers over and over, to steer each choice it makes. */
const rolling = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};
const GET_UP = 0.9;
const SIT = 0;

test('a working agent is never sent anywhere', () => {
  const ambient = createAmbient({ random: () => GET_UP });
  run(ambient, [{ id: 'a', idle: false }], 300);
  assert.equal(ambient.whereIs('a'), null);
  assert.equal(ambient.awayCount, 0);
});

test('somebody free starts at the keyboard', () => {
  const ambient = createAmbient({ random: () => GET_UP });
  ambient.update(0.1, [{ id: 'a', idle: true }], () => plan());
  assert.equal(ambient.activityOf('a'), 'working');
  assert.equal(ambient.whereIs('a'), null);
});

test('after a stint at the keyboard, they get up on their own, and come back to it', () => {
  const ambient = createAmbient({ random: () => GET_UP });
  const bots = [{ id: 'a', idle: true }];
  let left = false;
  for (let t = 0; t < 40 && !left; t += 0.1) {
    ambient.update(0.1, bots, () => plan());
    left = Boolean(ambient.whereIs('a'));
  }
  assert.ok(left);
  run(ambient, bots, 12);
  assert.equal(ambient.whereIs('a'), null);
  assert.equal(ambient.activityOf('a'), 'working');
});

test('sometimes they only sit back for a while', () => {
  const ambient = createAmbient({ random: () => SIT });
  const bots = [{ id: 'a', idle: true }];
  let sat = false;
  for (let t = 0; t < 30 && !sat; t += 0.1) {
    ambient.update(0.1, bots, () => { throw new Error('should not be going anywhere'); });
    sat = ambient.activityOf('a') === 'sitting';
  }
  assert.ok(sat);
});

test('at the keyboard about 70% of their free time, whichever way the rest goes', () => {
  for (const seed of [1, 7, 42]) {
    let s = seed;
    const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    const ambient = createAmbient({ random });
    const bots = [{ id: 'a', idle: true }];
    const longWalk = (bot, taken, kind) => ({
      path: [{ x: 0, y: 0 }, { x: kind === 'wander' ? 200 : 700, y: 0 }],
      spot: { action: kind === 'wander' ? 'wander' : 'coffee' },
    });
    let working = 0;
    let total = 0;
    for (let t = 0; t < 3600; t += 0.1) {
      ambient.update(0.1, bots, longWalk);
      total += 1;
      if (!ambient.whereIs('a') && ambient.activityOf('a') === 'working') working += 1;
    }
    const share = working / total;
    assert.ok(share > 0.66 && share < 0.74, `seed ${seed}: ${share}`);
  }
});

test('over time they do all of it: sit back, wander, and go for a drink', () => {
  let s = 3;
  const random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const ambient = createAmbient({ random });
  const kinds = new Set();
  let sat = false;
  const bots = [{ id: 'a', idle: true }];
  for (let t = 0; t < 1800; t += 0.1) {
    ambient.update(0.1, bots, (bot, taken, kind) => { kinds.add(kind); return plan(kind === 'wander' ? 'wander' : 'coffee'); });
    sat = sat || ambient.activityOf('a') === 'sitting';
  }
  assert.ok(sat);
  assert.deepEqual([...kinds].sort(), ['break', 'wander']);
});

test('real work always shows, and time on it counts for nothing in the routine', () => {
  const ambient = createAmbient({ random: () => SIT });
  const bot = { id: 'a', idle: false };
  run(ambient, [bot], 500);
  assert.equal(ambient.activityOf('a'), 'working');
});

test('an idle agent goes, pauses, and comes back to their desk', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bots = [{ id: 'a', idle: true }];
  ambient.sendNow(bots[0], plan());
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
  const ambient = createAmbient({ random: () => GET_UP });
  const bot = Object.freeze({ id: 'a', idle: true, status: 'idle', job: null });
  run(ambient, [bot], 60);
  assert.deepEqual(bot, { id: 'a', idle: true, status: 'idle', job: null });
});

test('two agents at the break area chat, then both go back', () => {
  const ambient = createAmbient({ random: rolling(0) });
  const a = { id: 'a', idle: true };
  const b = { id: 'b', idle: true };
  ambient.sendNow(a, { path: [{ x: 0, y: 0 }, { x: 10, y: 0 }], spot: { action: 'water' } });
  ambient.sendNow(b, { path: [{ x: 40, y: 0 }, { x: 30, y: 0 }], spot: { action: 'coffee' } });
  run(ambient, [a, b], 1);
  assert.equal(ambient.whereIs('a').talking, true);
  assert.equal(ambient.whereIs('b').talking, true);
  assert.equal(ambient.whereIs('a').direction, 1, 'facing each other');
  assert.equal(ambient.whereIs('b').direction, -1);
  run(ambient, [a, b], 6);
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

test('nobody strolling stops for a chat, or holds anyone up', () => {
  const ambient = createAmbient({ random: () => 0 });
  const a = { id: 'a', idle: true };
  const b = { id: 'b', idle: true };
  ambient.sendNow(a, { path: [{ x: 0, y: 0 }, { x: 10, y: 0 }], spot: { action: 'wander', pause: 1 } });
  ambient.sendNow(b, { path: [{ x: 40, y: 0 }, { x: 30, y: 0 }], spot: { action: 'coffee' } });
  run(ambient, [a, b], 1);
  assert.equal(ambient.whereIs('a').talking, false);
  assert.equal(ambient.whereIs('b').talking, false);
});

test('an agent who is only sometimes free still gets up', () => {
  const ambient = createAmbient({ random: () => GET_UP });
  const bot = { id: 'a', idle: true };
  let left = false;
  for (let t = 0; t < 120 && !left; t += 0.1) {
    bot.idle = Math.floor(t) % 2 === 0; // free one second in two
    ambient.update(0.1, [bot], () => plan());
    left = Boolean(ambient.whereIs('a'));
  }
  assert.ok(left);
});

test('only a couple of agents are away at once', () => {
  const ambient = createAmbient({ random: () => GET_UP });
  const bots = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, idle: true }));
  let most = 0;
  for (let t = 0; t < 90; t += 0.1) {
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

test('turning back partway retraces the way out, rather than cutting across', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, { path: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], spot: { action: 'coffee' } });
  run(ambient, [bot], 3); // around the corner, at about (38, 100)
  assert.equal(ambient.whereIs('a').y, 100);
  bot.idle = false;
  const seen = [];
  for (let t = 0; t < 3 && ambient.whereIs('a'); t += 0.05) {
    ambient.update(0.05, [bot], () => null);
    if (ambient.whereIs('a')) seen.push({ ...ambient.whereIs('a') });
  }
  assert.ok(seen.length);
  for (const { x, y } of seen) assert.ok(y === 100 || Math.abs(x) < 1e-9, `at ${x}, ${y} they have left the way they came`);
  assert.equal(ambient.whereIs('a'), null);
});

test('a door is crossed out of sight, both ways, and not walked across', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, { path: [{ x: 0, y: 500 }, { x: 0, y: 490 }, { x: 0, y: 400, through: true }, { x: 0, y: 390 }], spot: { action: 'coffee' } });
  const heights = [];
  let hid = 0;
  for (let t = 0; t < 12 && (t === 0 || ambient.whereIs('a')); t += 0.05) {
    ambient.update(0.05, [bot], () => plan());
    const where = ambient.whereIs('a');
    if (!where) break;
    if (where.hidden) hid += 1;
    heights.push(where.y);
  }
  assert.ok(hid > 2, 'out of sight for a moment');
  assert.ok(!heights.some((y) => y > 400.5 && y < 489.5), 'never seen on the wall between the two sides');
});

test('they pause where a stroll says to, and look away while walking up', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, { path: [{ x: 0, y: 100 }, { x: 0, y: 50, rest: 1 }, { x: 50, y: 50 }], spot: { action: 'wander', pause: 1 } });
  run(ambient, [bot], 0.5);
  assert.equal(ambient.whereIs('a').facingAway, true);
  run(ambient, [bot], 0.8);
  assert.equal(ambient.whereIs('a').moving, false, 'stopped for a moment');
  run(ambient, [bot], 1.2);
  assert.equal(ambient.whereIs('a').moving, true, 'and off again');
  assert.equal(ambient.whereIs('a').facingAway, false);
});

test('feet keep pace with the floor: a stride goes by distance walked', () => {
  const ambient = createAmbient({ random: () => 0 });
  const bot = { id: 'a', idle: true };
  ambient.sendNow(bot, { path: [{ x: 0, y: 0 }, { x: 300, y: 0 }], spot: { action: 'coffee' } });
  run(ambient, [bot], 2);
  const where = ambient.whereIs('a');
  assert.ok(Math.abs(where.walked - where.x) < 1e-6);
});

const arrival = {
  path: [{ x: 300, y: 0 }, { x: 250, y: 0 }],
  home: [{ x: 250, y: 0 }, { x: 0, y: 0 }],
  spot: { action: 'coffee', pause: 2.5 },
};

test('somebody new comes in, gets a coffee, and goes to their desk with it', () => {
  const ambient = createAmbient({ random: () => 0.9 });
  const bot = { id: 'a', idle: true };
  ambient.arrive(bot);
  assert.equal(ambient.whereIs('a').hidden, true, 'nowhere to be seen yet');
  const kinds = [];
  ambient.update(0.1, [bot], (b, taken, kind) => { kinds.push(kind); return arrival; });
  assert.deepEqual(kinds, ['arrive']);
  run(ambient, [bot], 2);
  assert.equal(ambient.actionOf('a'), 'coffee');
  run(ambient, [bot], 2.6);
  assert.equal(ambient.whereIs('a').phase, 'back');
  assert.equal(ambient.whereIs('a').holding, true);
  assert.equal(ambient.whereIs('a').x < 250, true, 'heading for the desk, not back out of the door');
  run(ambient, [bot], 6);
  assert.equal(ambient.whereIs('a'), null);
  assert.equal(ambient.activityOf('a'), 'working');
});

test('a whole team comes in one after another', () => {
  const ambient = createAmbient({ random: () => 0.9 });
  const bots = ['a', 'b', 'c'].map((id) => ({ id, idle: true }));
  bots.forEach((b) => ambient.arrive(b));
  const plan = () => arrival;
  ambient.update(0.1, bots, plan);
  assert.equal(ambient.whereIs('a').phase, 'going');
  assert.equal(ambient.whereIs('b').phase, 'expected');
  run(ambient, bots, 1.6, plan);
  assert.equal(ambient.whereIs('b').phase, 'going');
  assert.equal(ambient.whereIs('c').phase, 'expected');
});

test('somebody with real work still comes in that way, only quicker', () => {
  const ambient = createAmbient({ random: () => 0.9 });
  const bot = { id: 'a', idle: false };
  ambient.arrive(bot);
  ambient.update(0.1, [bot], () => arrival);
  run(ambient, [bot], 1);
  assert.notEqual(ambient.whereIs('a').phase, 'going');
  run(ambient, [bot], 3);
  assert.equal(ambient.whereIs('a'), null);
});

test('nobody expected stays expected once they have left', () => {
  const ambient = createAmbient({ random: () => 0.9 });
  ambient.arrive({ id: 'a' });
  ambient.update(0.1, [], () => null);
  assert.equal(ambient.whereIs('a'), null);
});
