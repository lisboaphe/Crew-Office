import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAllocator } from '../src/office2d/allocation.js';

const bots = (ownerId, count, from = 1) => Array.from({ length: count }, (_, i) => ({ id: `${ownerId}-${from + i}`, ownerId, ownerName: ownerId }));
const rowsOf = (column) => column.rows.map((r) => r.botId ?? 'standby');

test('one player with two bots gets two workstations and one standby', () => {
  const { floors } = createAllocator().sync(bots('a', 2));
  assert.equal(floors.length, 1);
  assert.equal(floors[0].columns.length, 1);
  assert.deepEqual(rowsOf(floors[0].columns[0]), ['a-1', 'a-2', 'standby']);
});

test('twenty bots for one player take two floors, ten on each, with numbers carrying on', () => {
  const { floors } = createAllocator().sync(bots('a', 20));
  assert.equal(floors.length, 2);
  assert.deepEqual(floors[0].columns[0].rows.map((r) => r.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(floors[1].columns[0].rows.map((r) => r.number), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.ok(floors.flatMap((f) => f.columns).flatMap((c) => c.rows).every((r) => !r.standby), 'no empty desk on a new floor');
});

test('ten bots do not open a new floor just for a standby desk', () => {
  const { floors } = createAllocator().sync(bots('a', 10));
  assert.equal(floors.length, 1);
  assert.equal(floors[0].columns[0].rows.length, 10);
});

test('a floor holds three players, and the fourth starts the next', () => {
  const { floors } = createAllocator().sync([...bots('a', 1), ...bots('b', 1), ...bots('c', 1), ...bots('d', 1)]);
  assert.deepEqual(floors.map((f) => f.columns.map((c) => c.ownerId)), [['a', 'b', 'c'], ['d']]);
});

test('there is never more than one standby workstation', () => {
  const { floors } = createAllocator().sync([...bots('a', 2), ...bots('b', 3), ...bots('c', 1)]);
  const standby = floors.flatMap((f) => f.columns).flatMap((c) => c.rows).filter((r) => r.standby);
  assert.equal(standby.length, 1);
});

test('a bot that leaves frees its workstation, and the next bot takes it', () => {
  const office = createAllocator();
  const team = bots('a', 3);
  office.sync(team);
  const after = office.sync([team[0], team[2]]);
  assert.deepEqual(rowsOf(after.floors[0].columns[0]), ['a-1', 'standby', 'a-3'], 'the others stay at their own desks');
  const refilled = office.sync([team[0], team[2], { id: 'a-new', ownerId: 'a' }]);
  assert.deepEqual(rowsOf(refilled.floors[0].columns[0]), ['a-1', 'a-new', 'a-3', 'standby']);
});

test('only one free workstation shows, and the rows close up over the rest', () => {
  const office = createAllocator();
  const team = bots('a', 5);
  office.sync(team);
  const { floors } = office.sync([team[0], team[4]]);
  assert.deepEqual(rowsOf(floors[0].columns[0]), ['a-1', 'standby', 'a-5']);
  assert.deepEqual(floors[0].columns[0].rows.map((r) => r.number), [1, 2, 5]);
});

test('a player with no bots has no area on the floor', () => {
  const office = createAllocator();
  const team = bots('a', 1);
  office.sync([...team, ...bots('b', 1)]);
  const { floors } = office.sync(team);
  assert.deepEqual(floors[0].columns.map((c) => c.ownerId), ['a']);
});

test('an empty office still has a floor to draw', () => {
  const { floors } = createAllocator().sync([]);
  assert.deepEqual(floors, [{ columns: [] }]);
});

const roomSizes = (column) => column.rooms.map((r) => r.rows.length);

test('a room holds four bots, and a fifth opens the next', () => {
  const four = createAllocator().sync(bots('a', 4)).floors[0].columns[0];
  assert.deepEqual(roomSizes(four), [4], 'a full room shows no standby, and opens no empty room');
  const five = createAllocator().sync(bots('a', 5)).floors[0].columns[0];
  assert.deepEqual(five.rooms.map((r) => r.rows.map((x) => x.botId ?? 'standby')), [['a-1', 'a-2', 'a-3', 'a-4'], ['a-5', 'standby']]);
});

test('ten bots take three rooms on a floor, and rooms carry on numbering across floors', () => {
  const { floors } = createAllocator().sync(bots('a', 20));
  assert.deepEqual(roomSizes(floors[0].columns[0]), [4, 4, 2]);
  assert.deepEqual(roomSizes(floors[1].columns[0]), [4, 4, 2]);
  assert.deepEqual(floors.flatMap((f) => f.columns[0].rooms.map((r) => r.number)), [1, 2, 3, 4, 5, 6]);
});

test('a player who joins gets their own room', () => {
  const { floors } = createAllocator().sync([...bots('a', 1), ...bots('b', 1)]);
  assert.deepEqual(floors[0].columns.map((c) => [c.ownerId, c.rooms.length]), [['a', 1], ['b', 1]]);
});
