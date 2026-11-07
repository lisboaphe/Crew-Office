import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPath, isClear, isLineClear } from '../src/office2d/walkways.js';
import { createAllocator } from '../src/office2d/allocation.js';
import {
  BREAK_FURNITURE, BREAK_SPOTS, WALL_H, WORKER_H, WORKER_W, placeFloor, routeTo, seatFeet, spotFeet, strollFrom, walkMapOf,
} from '../src/office2d/floor-plan.js';

const sizes = JSON.parse(readFileSync(new URL('../assets/pixel-art/office/established/sprites.json', import.meta.url)));
const room = { x: 0, y: 0, w: 200, h: 200 };

test('a way goes around what stands in it', () => {
  const map = { walkable: [room], solids: [{ x: 80, y: -10, w: 40, h: 160 }] };
  const path = findPath({ x: 20, y: 50 }, { x: 180, y: 50 }, map);
  assert.ok(path);
  assert.deepEqual(path[0], { x: 20, y: 50 });
  assert.deepEqual(path.at(-1), { x: 180, y: 50 });
  for (let i = 1; i < path.length; i++) assert.ok(isLineClear(path[i - 1], path[i], map));
  assert.ok(Math.max(...path.map((p) => p.y)) > 150, 'walks below the obstacle');
});

test('an open floor is one straight walk', () => {
  assert.equal(findPath({ x: 20, y: 20 }, { x: 180, y: 180 }, { walkable: [room], solids: [] }).length, 2);
});

test('there is no way through a wall with no door', () => {
  const map = { walkable: [{ x: 0, y: 0, w: 80, h: 200 }, { x: 120, y: 0, w: 80, h: 200 }], solids: [] };
  assert.equal(findPath({ x: 20, y: 50 }, { x: 180, y: 50 }, map), null);
});

test('nobody can start or end inside something', () => {
  const map = { walkable: [room], solids: [{ x: 80, y: 80, w: 40, h: 40 }] };
  assert.equal(findPath({ x: 100, y: 100 }, { x: 20, y: 20 }, map), null);
  assert.equal(findPath({ x: 20, y: 20 }, { x: 100, y: 100 }, map), null);
});

test('a door jumps the wall, and only that stretch is marked', () => {
  const map = {
    walkable: [{ x: 0, y: 0, w: 80, h: 200 }, { x: 120, y: 0, w: 80, h: 200 }],
    solids: [],
    links: [{ a: { x: 72, y: 100 }, b: { x: 128, y: 100 } }],
  };
  const path = findPath({ x: 20, y: 40 }, { x: 180, y: 40 }, map);
  const marked = path.filter((p) => p.through);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].x, 128);
  path.forEach((p, i) => {
    if (i && !p.through) assert.ok(isLineClear(path[i - 1], p, map));
  });
});

// Every character on every layout: each seat to each thing in the break area. -----------------------

const team = (players, each) => {
  const bots = [];
  const present = [];
  for (let p = 0; p < players; p++) {
    present.push({ id: `player-${p}`, name: `Player ${p}` });
    for (let b = 0; b < each; b++) bots.push({ id: `bot-${p}-${b}`, ownerId: `player-${p}`, ownerName: `Player ${p}` });
  }
  return { bots, present };
};

function everySeat(floors, visit) {
  for (const floor of floors) {
    const plan = placeFloor(floor);
    for (const room of plan.rooms) room.rows.forEach((row, index) => { if (row.botId) visit({ room, plan, index }); });
  }
}

const LAYOUTS = [[1, 1], [1, 4], [1, 9], [1, 10], [1, 20], [2, 5], [2, 10], [3, 4], [3, 10], [3, 12]];

test('every character has a clear way to everything in the break area, on every layout', () => {
  let routes = 0;
  for (const [players, each] of LAYOUTS) {
    const { bots, present } = team(players, each);
    everySeat(createAllocator().sync(bots, present).floors, (seat) => {
      const map = walkMapOf(seat.plan, sizes, seat);
      const label = `${players}x${each} ${seat.room.key} seat ${seat.index}`;
      assert.ok(isClear(seatFeet(seat.room, seat.index), map), `${label}: the seat stands clear`);
      for (const spot of BREAK_SPOTS) {
        assert.ok(isClear(spotFeet(seat.plan, spot), map), `${label}: ${spot.action} stands clear`);
        const path = routeTo(seat, spot, sizes);
        assert.ok(path, `${label}: a way to ${spot.action}`);
        const feet = path.map((p) => ({ x: p.x + WORKER_W / 2, y: p.y + WORKER_H, through: p.through }));
        feet.forEach((p, i) => {
          if (i && !p.through) assert.ok(isLineClear(feet[i - 1], p, map), `${label}: to ${spot.action}, leg ${i} is clear`);
        });
        routes += 1;
      }
    });
  }
  assert.ok(routes > 300);
});

test('rooms that differ still leave a way through, whatever they are furnished with', () => {
  for (let name = 0; name < 60; name++) {
    const owner = `someone-${name}`;
    const bots = Array.from({ length: 8 }, (_, b) => ({ id: `${owner}/${b}`, ownerId: owner, ownerName: owner }));
    everySeat(createAllocator().sync(bots, [{ id: owner, name: owner }]).floors, (seat) => {
      assert.ok(routeTo(seat, BREAK_SPOTS.at(-1), sizes), `${seat.room.key} seat ${seat.index}`);
    });
  }
});

test('stacked rooms are crossed by their door, and never by walking over the wall', () => {
  const { bots, present } = team(2, 8);
  let doors = 0;
  everySeat(createAllocator().sync(bots, present).floors, (seat) => {
    if (seat.room.down === 0) return;
    const path = routeTo(seat, BREAK_SPOTS[0], sizes);
    doors += path.filter((p) => p.through).length;
    assert.equal(path.filter((p) => p.through).length, seat.room.down);
  });
  assert.ok(doors > 0);
});

test('the fixed trips are for coffee, the microwave and water', () => {
  assert.deepEqual(BREAK_SPOTS.map((s) => s.action), ['coffee', 'microwave', 'water']);
});

test('the break area stands on its floor, against its back wall', () => {
  for (const item of BREAK_FURNITURE) {
    if (item.onTop) continue;
    const foot = item.y + sizes[item.sprite].height;
    assert.ok(foot > WALL_H, `${item.sprite} at ${foot}`);
    if (item.y < WALL_H) assert.ok(item.y >= 0, `${item.sprite} goes through the ceiling`);
  }
});

test('strolls keep to clear floor wherever they wander, and end somewhere', () => {
  let seed = 1;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const { bots, present } = team(2, 10);
  let strolls = 0;
  everySeat(createAllocator().sync(bots, present).floors, (seat) => {
    const map = walkMapOf(seat.plan, sizes, seat);
    for (let i = 0; i < 4; i++) {
      const stroll = strollFrom(seat, sizes, random);
      assert.ok(stroll, seat.room.key);
      assert.equal(stroll.spot.action, 'wander');
      const feet = stroll.path.map((p) => ({ x: p.x + WORKER_W / 2, y: p.y + WORKER_H, through: p.through }));
      feet.forEach((p, n) => {
        if (n && !p.through) assert.ok(isLineClear(feet[n - 1], p, map), `${seat.room.key} leg ${n}`);
      });
      strolls += 1;
    }
  });
  assert.ok(strolls > 50);
});

test('no standing furniture overlaps the shelf or the player\'s desk', () => {
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let name = 0; name < 80; name++) {
    const owner = `someone-${name}`;
    const bots = Array.from({ length: 8 }, (_, b) => ({ id: `${owner}/${b}`, ownerId: owner, ownerName: owner }));
    for (const floor of createAllocator().sync(bots, [{ id: owner, name: owner }]).floors) {
      const plan = placeFloor(floor);
      for (const room of plan.rooms) {
        const { solids } = walkMapOf({ rooms: [room], breakRoom: { x: 5000, y: 0, width: 264 } }, sizes);
        const top = solids.filter((s) => s.y + s.h <= room.y + 7 + 124 && s.w > 18);
        top.forEach((a, i) => top.slice(i + 1).forEach((b) => assert.ok(!overlaps(a, b), `${room.key}: ${JSON.stringify([a, b])}`)));
      }
    }
  }
});
