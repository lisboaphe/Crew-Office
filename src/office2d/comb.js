// The comb: a room for every agent. No drawing here, so the rules can be tested on their own.
//
// The usual layout gives a player a column of four-desk rooms and fills them in turn. The comb
// instead gives every agent who joins a room of their own, and packs the rooms together in a block,
// every room sharing whole walls with its neighbours and none left hanging off a corner. The
// player's own room and the break room are side by side in the middle, and each new room goes in
// the free place that touches the most rooms already there, so the block stays as close to square
// as it can. Somebody leaving closes the gap, as everybody after them moves one place inwards; the
// view eases rooms from where they were to where they are now, so the comb grows and shrinks
// rather than jumping.
//
// A subagent has no room of its own: it sits in its parent's, at the next desk. A room has four
// desks, so a parent with more than three subagents at once gets an annexe, the very next place.

import { BORDER, INNER_W, ROOM_H, ROOM_W, STEP_X, STEP_Y } from './floor-plan.js';

export const DESKS_PER_ROOM = 4;

/** The break room's cell: straight to the right of the player's room. */
const BREAK_CELL = { col: 1, row: 0 };
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * The first `count` cells of the comb, the player's room first. Each next one is the free cell
 * sharing a wall with the most cells taken so far, the break room's included; a tie goes to the
 * one nearest the middle of the two, then to the higher row, then to the left. The order never
 * depends on `count`, so a comb of n rooms is always the first n of a bigger one.
 */
export function combCells(count) {
  const cells = [];
  if (count <= 0) return cells;
  const key = (c) => `${c.col},${c.row}`;
  const taken = new Set([key(BREAK_CELL)]);
  const take = (c) => { cells.push(c); taken.add(key(c)); };
  take({ col: 0, row: 0 });
  while (cells.length < count) {
    const free = new Map();
    for (const c of [...cells, BREAK_CELL]) {
      for (const [dc, dr] of SIDES) {
        const n = { col: c.col + dc, row: c.row + dr };
        if (!taken.has(key(n))) free.set(key(n), n);
      }
    }
    const touching = (c) => SIDES.filter(([dc, dr]) => taken.has(key({ col: c.col + dc, row: c.row + dr }))).length;
    const distance = (c) => Math.hypot(c.col - 0.5, c.row * (STEP_Y / STEP_X));
    const best = [...free.values()].sort((a, b) => touching(b) - touching(a) || distance(a) - distance(b) || a.row - b.row || a.col - b.col)[0];
    take(best);
  }
  return cells;
}

/** Where a cell's room stands, before the comb is moved to start at nought. */
export const cellOrigin = ({ col, row }) => ({ x: col * STEP_X, y: row * STEP_Y });

/**
 * Who has which room, kept in the order they arrived. `sync` takes everybody here now and answers
 * with the rooms in that order: each player's own room, then every agent's.
 */
export function createCombAllocator() {
  const order = new Map(); // family key -> arrival number
  let arrivals = 0;

  /**
   * @param {Array<{id: string, ownerId: string, ownerName?: string, parentId?: ?string}>} bots
   * @param {Array<{id: string, name?: string}>} [players]
   */
  function sync(bots, players = []) {
    const ids = new Set(bots.map((b) => b.id));
    // A subagent whose parent is not here is an agent in its own right, for as long as that lasts.
    const parentOf = (bot) => (bot.parentId && ids.has(String(bot.parentId)) ? String(bot.parentId) : null);
    const families = new Map();
    for (const bot of bots) {
      if (parentOf(bot)) continue;
      families.set(bot.id, { lead: bot, subs: [] });
    }
    for (const bot of bots) {
      const parent = parentOf(bot);
      // A subagent of a subagent sits with the one at the top.
      let top = parent;
      const seen = new Set();
      while (top && !families.has(top) && !seen.has(top)) {
        seen.add(top);
        top = parentOf(bots.find((b) => b.id === top) ?? {});
      }
      if (parent && families.has(top)) families.get(top).subs.push(bot);
    }
    for (const key of order.keys()) if (!families.has(key)) order.delete(key);
    for (const key of families.keys()) if (!order.has(key)) order.set(key, arrivals++);

    const owners = new Map();
    for (const player of players) owners.set(player.id, player.name ?? '');
    for (const { lead } of families.values()) if (!owners.has(lead.ownerId)) owners.set(lead.ownerId, lead.ownerName ?? '');

    const rooms = [...owners].map(([ownerId, ownerName]) => ({ key: `${ownerId}:hub`, ownerId, ownerName, number: 1, rows: [] }));
    const counts = new Map();
    const sorted = [...families.entries()].sort((a, b) => order.get(a[0]) - order.get(b[0]));
    for (const [key, { lead, subs }] of sorted) {
      const people = [lead, ...subs];
      for (let part = 0; part * DESKS_PER_ROOM < people.length; part++) {
        const number = (counts.get(lead.ownerId) ?? 1) + 1;
        counts.set(lead.ownerId, number);
        rooms.push({
          key: part ? `${lead.ownerId}:${key}:${part + 1}` : `${lead.ownerId}:${key}`,
          ownerId: lead.ownerId,
          ownerName: owners.get(lead.ownerId),
          number,
          rows: people.slice(part * DESKS_PER_ROOM, (part + 1) * DESKS_PER_ROOM).map((bot, i) => ({
            slot: i, number: i + 1, botId: bot.id, standby: false, sub: bot !== lead,
          })),
        });
      }
    }
    return { rooms };
  }

  return { sync };
}

/**
 * Where every room of the comb goes, and the break room, all moved so the comb starts at nought.
 * Rooms carry `across` and `down` of nought, which to the rest of the 2D view means a room with no
 * neighbour behind it; the comb's own doors are in `links`.
 *
 * @param {Array<object>} rooms  in order, as `sync` gives them
 */
export function placeComb(rooms) {
  const cells = combCells(rooms.length);
  const placed = rooms.map((room, i) => ({ ...room, cell: cells[i], ...cellOrigin(cells[i]) }));
  const breakAt = cellOrigin(BREAK_CELL);
  const minX = Math.min(breakAt.x, ...placed.map((r) => r.x));
  const minY = Math.min(breakAt.y, ...placed.map((r) => r.y));
  for (const room of placed) Object.assign(room, { x: room.x - minX, y: room.y - minY, across: 0, down: 0 });
  const breakRoom = { key: 'break', cell: BREAK_CELL, x: breakAt.x - minX, y: breakAt.y - minY, width: ROOM_W };
  const all = [...placed, breakRoom];
  return {
    comb: true,
    rooms: placed,
    breakRoom,
    links: combLinks(all),
    bounds: {
      w: Math.max(...all.map((r) => r.x + ROOM_W)),
      h: Math.max(...all.map((r) => r.y + ROOM_H)),
    },
  };
}

/**
 * Which rooms share a wall, and where a way through it could go. Rooms side by side in a row share
 * a whole wall and get a door at floor level, like the usual layout's. A room and the one behind it
 * get a doorway somewhere along the wall they share, wherever it is clear on both sides.
 *
 * @param {Array<{key: string, cell: {col: number, row: number}, x: number, y: number}>} cells
 */
export function combLinks(cells) {
  const links = [];
  for (const a of cells) {
    for (const b of cells) {
      if (a.cell.row === b.cell.row && b.cell.col === a.cell.col + 1) {
        links.push({ kind: 'side', from: a.key, to: b.key, wallX: b.x, y: b.y });
      }
      if (b.cell.row === a.cell.row + 1) {
        // The stretch of wall the two rooms have in common, inside both of them.
        const from = Math.max(a.x, b.x) + BORDER;
        const to = Math.min(a.x, b.x) + BORDER + INNER_W;
        if (to - from >= 40) links.push({ kind: 'back', from: a.key, to: b.key, left: from, right: to, y: b.y });
      }
    }
  }
  return links;
}

/**
 * Moves what is drawn a step towards where it belongs: rooms that have just arrived appear where
 * they are, and rooms that are moving glide. Returns whether anything is still on its way.
 *
 * @param {Map<string, {x: number, y: number}>} shown  where each room is drawn, kept between frames
 * @param {Array<{key: string, x: number, y: number}>} targets
 * @param {number} dt  seconds
 * @param {number} [rate]  how quickly, per second
 */
export function easeRooms(shown, targets, dt, rate = 6) {
  const k = 1 - Math.exp(-rate * dt);
  const keys = new Set(targets.map((t) => t.key));
  for (const key of shown.keys()) if (!keys.has(key)) shown.delete(key);
  let moving = false;
  for (const { key, x, y } of targets) {
    const at = shown.get(key);
    if (!at) {
      shown.set(key, { x, y });
      continue;
    }
    at.x += (x - at.x) * k;
    at.y += (y - at.y) * k;
    if (Math.abs(x - at.x) < 0.5 && Math.abs(y - at.y) < 0.5) Object.assign(at, { x, y });
    else moving = true;
  }
  return moving;
}

