// Where everything in the office stands. The drawing and the walking both read it from here, so
// what you see and what people walk around cannot drift apart. No drawing in this file.

import { findPath, isClear } from './walkways.js';

// All in art pixels. Every room is this size: the player at the top middle, two agents down each
// side of an aisle, and a strip along the foot of the room to walk to the doors by.
export const INNER_W = 300;
export const INNER_H = 284;
export const WALL_H = 62;
export const ROW_TOP = 126;
export const ROW_H = 66;
export const AISLE_X = 150;
export const FOOT_Y = INNER_H - 13;
export const BORDER = 7;
export const ROOM_W = INNER_W + BORDER * 2;
export const ROOM_H = INNER_H + BORDER * 2;
// Neighbouring rooms share a wall, so one frame stands between them.
export const STEP_X = ROOM_W - BORDER;
export const STEP_Y = ROOM_H - BORDER;
export const BREAK_W = 290;
export const BREAK_DOOR_X = 264; // the middle of the door in its back wall, where people come in
export const WORKER_W = 26;
export const WORKER_H = 44;
export const DESK_W = 82;
export const DESK_H = 68;
// The player and their desk, within the first room.
export const PLAYER = { deskX: 120, deskY: WALL_H - 8, x: 98, y: WALL_H + 12 };

// The drink-or-snack trips, and where somebody stands for each, by where their feet are.
export const BREAK_SPOTS = [
  { action: 'coffee', x: 46, y: WALL_H + 30 },
  { action: 'microwave', x: 174, y: WALL_H + 38 },
  { action: 'water', x: 222, y: WALL_H + 36 },
];

// The break area's furniture, in drawing order. What stands on something else is no obstacle itself.
export const BREAK_FURNITURE = [
  { sprite: 'coffee', x: 4, y: WALL_H - 49 }, // the cabinet, with the machine and mugs on it
  { sprite: 'fridge', x: 98, y: WALL_H - 55 },
  { sprite: 'side-table', x: 150, y: WALL_H - 12 },
  { sprite: 'microwave', x: 152, y: WALL_H - 26, onTop: true },
  { sprite: 'cooler', x: 210, y: WALL_H - 32 },
  { sprite: 'sofa', x: 148, y: INNER_H - 72 },
  { sprite: 'lamp', x: 226, y: INNER_H - 80 },
  { sprite: 'plant', x: 88, y: INNER_H - 74 },
];

// What a room may be furnished with, along with the desks every room has.
const FLOOR_PROPS = [
  { sprite: 'plant' },
  { sprite: 'cabinet' },
  { sprite: 'armchair' },
  { sprite: 'boxes' },
  { sprite: 'lamp' },
  { sprite: 'fax', on: 'side-table' },
];
const SMALL_PROPS = [null, 'bin', 'bin'];
const PICTURES = [null, 'picture-hills', 'picture-chart', 'picture-night'];
const SEATS_IN_A_ROOM = 4;
const CHAIR_X = 48; // where the middle of the chair is in the desk's sprite, which is drawn mirrored on the left
const CHAIR_TOP = 13;
const WANDER_STOPS = 3;
const WANDER_TRIES = 12;

export const hashOf = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;

/**
 * Where everything on a floor goes: a column per player with their rooms one above the other, or
 * side by side for a player alone on a floor, and the break area beside the top row. Rooms share
 * their walls and are joined by doors, all the way along to the break area.
 */
export function placeFloor(floor) {
  const rooms = [];
  const alone = floor.columns.length === 1;
  floor.columns.forEach((column, c) => {
    column.rooms.forEach((room, r) => {
      const across = alone ? r : c;
      const down = alone ? 0 : r;
      rooms.push({
        key: `${column.ownerId}:${room.number}`,
        ownerId: column.ownerId,
        ownerName: column.ownerName,
        number: room.number,
        rows: room.rows,
        across,
        down,
        x: across * STEP_X,
        y: down * STEP_Y,
      });
    });
  });
  const acrossAll = Math.max(1, ...rooms.map((r) => r.across + 1));
  const breakRoom = { x: acrossAll * STEP_X, y: 0, width: BREAK_W + BORDER * 2 };
  return { rooms, breakRoom };
}

/** Where a workstation is in its room. Odd seats are on the right, and desks face the aisle. */
export function stationAt(room, index) {
  const left = room.x + BORDER;
  const right = index % 2 === 1;
  const y = room.y + BORDER + ROW_TOP + (index >> 1) * ROW_H;
  return {
    right,
    y,
    left,
    rugX: left + (right ? 172 : 4),
    badgeX: left + (right ? 287 : 13),
    deskX: left + (right ? 202 : 16),
    workerX: left + (right ? 176 : 98),
    nameX: left + (right ? 243 : 57),
  };
}

/**
 * A room's own furniture, chosen once from its name: the same room always looks the same, and
 * different rooms differ. All of it stands clear of the desks, the aisle and the walk to the door.
 *
 * @param {string} key  the room's name
 * @param {Record<string, {width: number, height: number}>} sizes  the sprites' sizes
 */
export function decorOf({ key, number }, sizes) {
  const widthOf = (prop) => sizes[prop.on ?? prop.sprite].width;
  let seed = hashOf(key);
  const roll = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % n;
  };
  const flipped = roll(2) === 1;
  let left = FLOOR_PROPS[roll(FLOOR_PROPS.length)];
  const others = FLOOR_PROPS.filter((p) => p !== left);
  let right = others[roll(others.length)];
  const shelfX = flipped ? 6 : INNER_W - sizes.shelf.width - 8;
  // Whatever stands on the shelf's side of the room goes in the gap beside it. There is no gap in the
  // player's room, where their desk stands.
  const beside = number === 1 ? null : (flipped ? left : right);
  const besideX = beside && (flipped ? shelfX + sizes.shelf.width + 4 : shelfX - widthOf(beside) - 2);
  return {
    flipped,
    picture: PICTURES[roll(PICTURES.length)],
    small: SMALL_PROPS[roll(SMALL_PROPS.length)],
    rug: roll(2) === 0,
    standing: [
      flipped ? { prop: right, x: INNER_W - widthOf(right) - 8 } : { prop: left, x: 8 },
      ...(beside ? [{ prop: beside, x: besideX }] : []),
    ],
    smallX: flipped ? INNER_W - 28 - 56 : 56,
    shelfX,
    clockX: flipped ? 86 : 166,
    windowX: flipped ? 182 : 14,
    propsBottom: WALL_H + 54,
    shelfY: WALL_H - 44,
  };
}

const rect = (x, y, w, h) => ({ x, y, w, h });

/** Everything in a room that nobody can walk through, apart from the one seat given. */
function roomSolids(room, sizes, ownSeat) {
  const left = room.x + BORDER;
  const top = room.y + BORDER;
  const decor = decorOf(room, sizes);
  const bottom = top + decor.propsBottom;
  const standing = (prop, x) => {
    const under = sizes[prop.on ?? prop.sprite];
    const height = prop.on ? under.height + sizes[prop.sprite].height - 12 : under.height;
    return rect(left + x, bottom - height, under.width, height);
  };
  const solids = [
    rect(left + decor.shelfX, top + decor.shelfY, sizes.shelf.width, sizes.shelf.height),
    ...decor.standing.map(({ prop, x }) => standing(prop, x)),
  ];
  if (decor.small) solids.push(rect(left + decor.smallX, bottom - sizes[decor.small].height, sizes[decor.small].width, sizes[decor.small].height));
  if (room.number === 1) {
    solids.push(rect(left + PLAYER.deskX, top + PLAYER.deskY, DESK_W, DESK_H));
    solids.push(rect(left + PLAYER.x + 4, top + PLAYER.y + WORKER_H - 14, WORKER_W - 8, 14));
  }
  // Every seat counts, taken or not, so a colleague arriving mid-walk cannot end up in somebody's way.
  for (let index = 0; index < SEATS_IN_A_ROOM; index++) {
    const at = stationAt(room, index);
    solids.push(rect(at.deskX, at.y - 8, DESK_W, DESK_H));
    if (index !== ownSeat) solids.push(rect(at.workerX + 4, at.y + 6 + WORKER_H - 14, WORKER_W - 8, 14));
  }
  return solids;
}

/**
 * The floor as somebody on foot sees it: where the floor is, what stands on it, and the doors in the
 * back walls, which are crossed rather than walked. Walls are simply wherever the floor is not.
 *
 * @param {{rooms: Array<object>, breakRoom: object}} plan
 * @param {Record<string, {width: number, height: number}>} sizes
 * @param {?{room: object, index: number}} [seat]  whose own seat doesn't get in their way
 */
export function walkMapOf(plan, sizes, seat = null) {
  const edge = 9; // keeps a body off the walls
  const floorOf = (x, y, width) => rect(x + edge, y + WALL_H + 2, width - edge * 2, INNER_H - WALL_H - 5);
  const sideDoor = (wallX, y) => rect(wallX - edge - 3, y + FOOT_Y - 26, BORDER + (edge + 3) * 2, 36);

  const walkable = [];
  const solids = [];
  const links = [];
  for (const room of plan.rooms) {
    const left = room.x + BORDER;
    const top = room.y + BORDER;
    walkable.push(floorOf(left, top, INNER_W));
    if (room.across > 0 && room.down === 0) walkable.push(sideDoor(room.x, top));
    if (room.down > 0) {
      links.push({
        a: { x: left + AISLE_X, y: top + WALL_H + 4 },
        b: { x: left + AISLE_X, y: top - BORDER - 8 },
      });
    }
    solids.push(...roomSolids(room, sizes, seat?.room.key === room.key ? seat.index : null));
  }
  const breakLeft = plan.breakRoom.x + BORDER;
  const breakTop = plan.breakRoom.y + BORDER;
  walkable.push(floorOf(breakLeft, breakTop, BREAK_W));
  walkable.push(sideDoor(plan.breakRoom.x, breakTop));
  for (const item of BREAK_FURNITURE) {
    if (!item.onTop) solids.push(rect(breakLeft + item.x, breakTop + item.y, sizes[item.sprite].width, sizes[item.sprite].height));
  }
  return { walkable, solids, links };
}

/** Where to draw somebody sitting at a desk, and whether they are drawn mirrored. */
export function sittingAt(deskX, deskY, right) {
  return { x: deskX + (right ? CHAIR_X : DESK_W - CHAIR_X) - WORKER_W / 2, y: deskY + CHAIR_TOP, flip: !right };
}

/** Where somebody's feet are at a seat, in their room. */
export function seatFeet(room, index) {
  const at = stationAt(room, index);
  return { x: at.workerX + WORKER_W / 2, y: at.y + 6 + WORKER_H };
}

/** Where somebody's feet are at a spot in the break area. */
export function spotFeet(plan, spot) {
  return { x: plan.breakRoom.x + BORDER + spot.x, y: plan.breakRoom.y + BORDER + spot.y };
}

/**
 * The way from a bot's seat to one of the break area's spots, as where to draw them along it, or
 * null if there is no way there.
 *
 * @param {{room: object, plan: object, index: number}} seat
 * @param {{x: number, y: number}} spot
 * @param {Record<string, {width: number, height: number}>} sizes
 */
export function routeTo(seat, spot, sizes) {
  const map = walkMapOf(seat.plan, sizes, seat);
  const path = findPath(seatFeet(seat.room, seat.index), spotFeet(seat.plan, spot), map);
  return path?.map((p) => ({ ...p, x: p.x - WORKER_W / 2, y: p.y - WORKER_H })) ?? null;
}

/**
 * A stroll: a few random places around their own room, now and then further afield, with a moment
 * at each. Null if nowhere could be found this time.
 *
 * @param {{room: object, plan: object, index: number}} seat
 * @param {Record<string, {width: number, height: number}>} sizes
 * @param {() => number} random
 */
export function strollFrom(seat, sizes, random) {
  const map = walkMapOf(seat.plan, sizes, seat);
  const ownFloor = map.walkable.find((r) => r.x <= seat.room.x + BORDER + AISLE_X && r.x + r.w >= seat.room.x + BORDER + AISLE_X
    && r.y <= seat.room.y + BORDER + ROW_TOP && r.y + r.h >= seat.room.y + BORDER + ROW_TOP);
  const floors = map.walkable.filter((r) => r.h > 100);
  const anywhere = () => {
    const area = random() < 0.75 ? ownFloor : floors[Math.floor(random() * floors.length)];
    return { x: Math.round(area.x + random() * area.w), y: Math.round(area.y + random() * area.h) };
  };
  const stops = 1 + Math.floor(random() * WANDER_STOPS);
  const way = [seatFeet(seat.room, seat.index)];
  for (let stop = 0; stop < stops; stop++) {
    let leg = null;
    for (let tries = 0; tries < WANDER_TRIES && !leg; tries++) {
      const place = anywhere();
      if (isClear(place, map)) leg = findPath(way.at(-1), place, map);
    }
    if (!leg) break;
    way.push(...leg.slice(1));
    // A moment to look around before moving on.
    if (stop < stops - 1) way[way.length - 1] = { ...way.at(-1), rest: 0.6 + random() * 1.4 };
  }
  if (way.length < 2) return null;
  return {
    path: way.map((p) => ({ ...p, x: p.x - WORKER_W / 2, y: p.y - WORKER_H })),
    spot: { action: 'wander', pause: 0.8 + random() * 1.7 },
  };
}

/**
 * How somebody first comes in: through the break room's door, over to the coffee machine, then to
 * their desk with a cup. Null if there is no way.
 *
 * @param {{room: object, plan: object, index: number}} seat
 * @param {Record<string, {width: number, height: number}>} sizes
 */
export function arrivalRoute(seat, sizes) {
  const map = walkMapOf(seat.plan, sizes, seat);
  const door = { x: seat.plan.breakRoom.x + BORDER + BREAK_DOOR_X, y: seat.plan.breakRoom.y + BORDER + WALL_H + 4 };
  const coffee = BREAK_SPOTS.find((s) => s.action === 'coffee');
  const toCoffee = findPath(door, spotFeet(seat.plan, coffee), map);
  const toDesk = findPath(spotFeet(seat.plan, coffee), seatFeet(seat.room, seat.index), map);
  if (!toCoffee || !toDesk) return null;
  const drawn = (p) => ({ ...p, x: p.x - WORKER_W / 2, y: p.y - WORKER_H });
  return { path: toCoffee.map(drawn), home: toDesk.map(drawn), spot: { action: 'coffee', pause: 2.5 } };
}
