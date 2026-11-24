import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combCells, cellOrigin, createCombAllocator, placeComb, combLinks, easeRooms } from '../src/office2d/comb.js';
import { combDoorsOf, walkMapOf, ROOM_W, STEP_X, STEP_Y } from '../src/office2d/floor-plan.js';
import { findPath } from '../src/office2d/walkways.js';

const bots = (ownerId, count) => Array.from({ length: count }, (_, i) => ({ id: `${ownerId}-${i + 1}`, ownerId, ownerName: ownerId }));
const keyOf = ({ col, row }) => `${col},${row}`;

// Whether two cells of the comb share a wall: side by side in a row, or overlapping rows.
function touching(a, b) {
  const pa = cellOrigin(a);
  const pb = cellOrigin(b);
  if (a.row === b.row) return Math.abs(a.col - b.col) === 1;
  return Math.abs(a.row - b.row) === 1 && Math.abs(pa.x - pb.x) < STEP_X;
}

test('the comb starts in the middle and every new cell touches one already there', () => {
  const cells = combCells(37);
  assert.deepEqual(cells[0], { col: 0, row: 0 });
  assert.equal(new Set(cells.map(keyOf)).size, 37, 'no cell twice');
  for (let i = 1; i < cells.length; i++) {
    assert.ok(cells.slice(0, i).some((c) => touching(c, cells[i])), `cell ${i} is not beside the comb`);
  }
});

test('the first ring is the six neighbours of the middle', () => {
  const ring = combCells(7).slice(1);
  assert.ok(ring.every((c) => touching(c, { col: 0, row: 0 })));
});

test('odd rows are shifted half a room along', () => {
  assert.deepEqual(cellOrigin({ col: 0, row: 1 }), { x: STEP_X / 2, y: STEP_Y });
  assert.deepEqual(cellOrigin({ col: 2, row: 0 }), { x: STEP_X * 2, y: 0 });
});

test('every agent gets a room, after the player’s own', () => {
  const { rooms } = createCombAllocator().sync(bots('a', 3), [{ id: 'a', name: 'Ann' }]);
  assert.deepEqual(rooms.map((r) => r.key), ['a:hub', 'a:a-1', 'a:a-2', 'a:a-3']);
  assert.equal(rooms[0].number, 1);
  assert.deepEqual(rooms.slice(1).map((r) => r.rows.map((row) => row.botId)), [['a-1'], ['a-2'], ['a-3']]);
});

test('a subagent sits in its parent’s room, and a fifth person opens an annexe next door', () => {
  const lead = { id: 'p', ownerId: 'a' };
  const subs = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, ownerId: 'a', parentId: i === 3 ? 's0' : 'p' }));
  const { rooms } = createCombAllocator().sync([lead, ...subs, { id: 'q', ownerId: 'a' }]);
  assert.deepEqual(rooms.map((r) => r.key), ['a:hub', 'a:p', 'a:p:2', 'a:q']);
  assert.deepEqual(rooms[1].rows.map((r) => r.botId), ['p', 's0', 's1', 's2']);
  assert.deepEqual(rooms[2].rows.map((r) => r.botId), ['s3']);
  assert.equal(rooms[1].rows[1].sub, true);
});

test('a subagent whose parent has gone has a room of its own', () => {
  const { rooms } = createCombAllocator().sync([{ id: 's', ownerId: 'a', parentId: 'gone' }]);
  assert.deepEqual(rooms.map((r) => r.key), ['a:hub', 'a:s']);
});

test('rooms keep the order agents arrived in, and close up when one leaves', () => {
  const comb = createCombAllocator();
  comb.sync([{ id: 'x', ownerId: 'a' }]);
  comb.sync([{ id: 'y', ownerId: 'a' }, { id: 'x', ownerId: 'a' }]);
  let { rooms } = comb.sync([{ id: 'z', ownerId: 'a' }, { id: 'y', ownerId: 'a' }, { id: 'x', ownerId: 'a' }]);
  assert.deepEqual(rooms.map((r) => r.key), ['a:hub', 'a:x', 'a:y', 'a:z']);
  ({ rooms } = comb.sync([{ id: 'z', ownerId: 'a' }, { id: 'x', ownerId: 'a' }]));
  assert.deepEqual(rooms.map((r) => r.key), ['a:hub', 'a:x', 'a:z']);
  const before = placeComb(comb.sync([{ id: 'z', ownerId: 'a' }, { id: 'x', ownerId: 'a' }]).rooms);
  assert.deepEqual(before.rooms.map((r) => r.cell), placeComb(rooms).rooms.map((r) => r.cell), 'same rooms, same cells');
});

test('the comb starts at nought, no two rooms overlap, and the break room is beside the player', () => {
  for (const n of [0, 1, 3, 7, 19]) {
    const rooms = createCombAllocator().sync(bots('a', n), [{ id: 'a' }]).rooms;
    const plan = placeComb(rooms);
    const all = [...plan.rooms, plan.breakRoom];
    assert.equal(Math.min(...all.map((r) => r.x)), 0);
    assert.equal(Math.min(...all.map((r) => r.y)), 0);
    assert.equal(new Set(all.map((r) => keyOf(r.cell))).size, all.length, `${n}: one room a cell`);
    const hub = plan.rooms[0];
    assert.equal(plan.breakRoom.y, hub.y);
    assert.equal(plan.breakRoom.x, hub.x + STEP_X);
    assert.ok(plan.bounds.w >= Math.max(...all.map((r) => r.x + ROOM_W)));
  }
});

test('rooms side by side share a door, and rows share a stretch of wall', () => {
  const plan = placeComb(createCombAllocator().sync(bots('a', 5), [{ id: 'a' }]).rooms);
  const links = combLinks([...plan.rooms, plan.breakRoom]);
  assert.ok(links.some((l) => l.kind === 'side' && l.from === 'a:hub' && l.to === 'break'));
  for (const link of links.filter((l) => l.kind === 'back')) assert.ok(link.right - link.left >= 40);
});

test('the doors are where people can walk, and everyone can reach the break room', () => {
  const size = (width, height) => ({ width, height });
  const sizes = new Proxy({ shelf: size(68, 61), 'side-table': size(30, 24) }, { get: (t, k) => t[k] ?? size(40, 44) });
  const rooms = createCombAllocator().sync(bots('a', 7), [{ id: 'a' }]).rooms;
  const plan = placeComb(rooms);
  const doors = combDoorsOf(plan, sizes);
  assert.ok(doors.side.length >= 2);
  assert.ok(doors.back.length >= 3);
  const map = walkMapOf(plan, sizes);
  const coffee = { x: plan.breakRoom.x + 7 + 46, y: plan.breakRoom.y + 7 + 92 };
  for (const room of plan.rooms.slice(1)) {
    const seat = { room, plan, index: 0 };
    const seated = walkMapOf(plan, sizes, seat);
    const from = { x: room.x + 7 + 150, y: room.y + 7 + 200 };
    assert.ok(findPath(from, coffee, seated) ?? findPath(from, coffee, map), `${room.key} cannot reach the coffee`);
  }
});

test('rooms glide to where they belong, and new rooms appear in place', () => {
  const shown = new Map();
  assert.equal(easeRooms(shown, [{ key: 'a', x: 0, y: 0 }], 0.016), false);
  assert.equal(easeRooms(shown, [{ key: 'a', x: 100, y: 0 }], 0.016), true);
  assert.ok(shown.get('a').x > 0 && shown.get('a').x < 100);
  for (let i = 0; i < 200; i++) easeRooms(shown, [{ key: 'a', x: 100, y: 0 }], 0.016);
  assert.deepEqual(shown.get('a'), { x: 100, y: 0 });
  easeRooms(shown, [], 0.016);
  assert.equal(shown.size, 0);
});
