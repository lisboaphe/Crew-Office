// Where everything in the office stands. The drawing and the walking both read it from here, so
// what you see and what people walk around cannot drift apart. No drawing in this file.

import { findPath, isClear, isLineClear } from './walkways.js';

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
  // A round table with four chairs where the sofa was, clear of the ways up to the coffee machine,
  // the microwave and the water cooler.
  { sprite: 'break-table', x: 84, y: INNER_H - 100 },
  { sprite: 'plant', x: 236, y: INNER_H - 74 },
];

// The cozy corner at the top left of the player's own room, against the back wall: an arc lamp
// leaning over an armchair, and a plant, on a round rug.
const COZY_BOTTOM = WALL_H + 26;
export const COZY_CORNER = [
  // Only the lamp's base stands on the floor; its arc reaches over the armchair.
  { prop: { sprite: 'lamp-arc' }, x: 2, bottom: COZY_BOTTOM, base: 15 },
  { prop: { sprite: 'armchair' }, x: 18, bottom: COZY_BOTTOM },
  { prop: { sprite: 'plant' }, x: 62, bottom: COZY_BOTTOM + 2 },
];
export const COZY_RUG = { sprite: 'rug-round', x: 8, y: WALL_H + 6 };

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
const WANDER_LEGS = 6; // straight walks in a stroll, each ending at whatever is in the way
const WANDER_STEP = 2; // art pixels, how far ahead somebody looks before each step
const WANDER_LEG_MIN = 24;
const WANDER_LEG_MAX = 110;
const HEADINGS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([x, y]) => {
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
});

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
  // The player's room keeps its shelf on the right, as its left is the cozy corner.
  const cozy = number === 1;
  const flipped = roll(2) === 1 && !cozy;
  let left = FLOOR_PROPS[roll(FLOOR_PROPS.length)];
  const others = FLOOR_PROPS.filter((p) => p !== left);
  let right = others[roll(others.length)];
  const shelfX = flipped ? 6 : INNER_W - sizes.shelf.width - 8;
  // Whatever stands on the shelf's side of the room goes in the gap beside it. There is no gap in the
  // player's room, where their desk stands.
  const beside = number === 1 ? null : (flipped ? left : right);
  const besideX = beside && (flipped ? shelfX + sizes.shelf.width + 4 : shelfX - widthOf(beside) - 2);
  const picture = PICTURES[roll(PICTURES.length)];
  const small = SMALL_PROPS[roll(SMALL_PROPS.length)];
  return {
    flipped,
    picture,
    small: cozy ? null : small,
    rug: roll(2) === 0,
    cozy,
    standing: cozy ? COZY_CORNER : [
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
  const standing = (prop, x, foot = bottom, base = null) => {
    const under = sizes[prop.on ?? prop.sprite];
    const height = prop.on ? under.height + sizes[prop.sprite].height - 12 : under.height;
    return rect(left + x, foot - height, base ?? under.width, height);
  };
  const solids = [
    rect(left + decor.shelfX, top + decor.shelfY, sizes.shelf.width, sizes.shelf.height),
    ...decor.standing.map((item) => standing(item.prop, item.x, item.bottom === undefined ? bottom : top + item.bottom, item.base)),
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
  const path = laneWay(seat, spotFeet(seat.plan, spot), map);
  return path?.map(drawnAt) ?? null;
}

const drawnAt = (p) => ({ ...p, x: p.x - WORKER_W / 2, y: p.y - WORKER_H });

const dedupe = (points) => points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);

/**
 * The lanes everybody keeps to on the way to the break area and back: out to the aisle, down it to
 * the strip along the foot of the room, along that strip and through the doors to the break area,
 * and then straight up to whatever they are going to use. Somebody in a stacked room goes up their
 * own aisle and through the door at the top first. Between lane points the way still goes around
 * whatever stands there, and if a lane is ever blocked the way is simply the shortest one.
 */
function laneWay(seat, to, map) {
  const from = seatFeet(seat.room, seat.index);
  const top = seat.room.y + BORDER;
  const left = seat.room.x + BORDER;
  const at = stationAt(seat.room, seat.index);
  const lanes = [{ x: left + AISLE_X, y: at.y + 6 + WORKER_H }];
  if (seat.room.down === 0) lanes.push({ x: left + AISLE_X, y: top + FOOT_Y });
  // Along the foot of every room in the top row between here and the break area.
  const along = seat.plan.rooms
    .filter((r) => r.down === 0 && r.across > seat.room.across)
    .sort((a, b) => a.across - b.across)
    .map((r) => ({ x: r.x + BORDER + AISLE_X, y: r.y + BORDER + FOOT_Y }));
  if (seat.room.down > 0) {
    const above = seat.plan.rooms.find((r) => r.down === 0 && r.across === seat.room.across);
    if (above) lanes.push({ x: above.x + BORDER + AISLE_X, y: above.y + BORDER + FOOT_Y });
  }
  lanes.push(...along, { x: to.x, y: seat.plan.breakRoom.y + BORDER + FOOT_Y });

  const way = [from];
  for (const point of [...lanes.filter((p) => isClear(p, map)), to]) {
    const leg = findPath(way.at(-1), point, map);
    if (!leg) return findPath(from, to, map);
    way.push(...leg.slice(1));
  }
  return dedupe(way);
}

/** The same way walked back, with each door still marking the stretch it is on. */
function retraced(points) {
  return points.map((point, i) => {
    const rest = { ...point };
    delete rest.through;
    return points[i + 1]?.through ? { ...rest, through: true } : rest;
  }).reverse();
}

/**
 * A stroll around their own room: out to the aisle, then off in a straight line until something is
 * in the way, a wall or a desk or a plant, and then turn and go another way. A few of those, with a
 * moment to look around now and then, and back the way they came. Null if they cannot get going.
 *
 * @param {{room: object, plan: object, index: number}} seat
 * @param {Record<string, {width: number, height: number}>} sizes
 * @param {() => number} random
 */
export function strollFrom(seat, sizes, random) {
  const whole = walkMapOf(seat.plan, sizes, seat);
  const left = seat.room.x + BORDER;
  const top = seat.room.y + BORDER;
  // Their own room's floor, and nothing else: its walls are what they turn back from.
  const own = whole.walkable.find((r) => r.x <= left + AISLE_X && r.x + r.w >= left + AISLE_X && r.y <= top + ROW_TOP && r.y + r.h >= top + ROW_TOP);
  if (!own) return null;
  const map = { walkable: [own], solids: whole.solids };
  const start = seatFeet(seat.room, seat.index);
  const aisle = { x: left + AISLE_X, y: start.y };
  const out = findPath(start, aisle, map);
  if (!out) return null;
  const way = [...out];
  let heading = Math.floor(random() * HEADINGS.length);
  for (let leg = 0; leg < WANDER_LEGS; leg++) {
    const from = way.at(-1);
    const wanted = WANDER_LEG_MIN + random() * (WANDER_LEG_MAX - WANDER_LEG_MIN);
    // Try the way they face, and if that is blocked straight away, turn around and then aside.
    let end = null;
    for (const turn of [0, 4, 2, 6, 1, 7, 3, 5]) {
      const dir = HEADINGS[(heading + turn) % HEADINGS.length];
      let reach = 0;
      while (reach + WANDER_STEP <= wanted) {
        const next = { x: from.x + dir.x * (reach + WANDER_STEP), y: from.y + dir.y * (reach + WANDER_STEP) };
        if (!isClear(next, map)) break;
        reach += WANDER_STEP;
      }
      if (reach >= WANDER_STEP * 3) {
        end = { x: Math.round(from.x + dir.x * reach), y: Math.round(from.y + dir.y * reach) };
        if (!isClear(end, map) || !isLineClear(from, end, map)) { end = null; continue; }
        // Next time, they set off away from whatever stopped them.
        heading = (heading + turn + (reach < wanted ? 4 : Math.floor(random() * 3) - 1) + HEADINGS.length) % HEADINGS.length;
        break;
      }
    }
    if (!end) break;
    way.push(random() < 0.35 ? { ...end, rest: 0.6 + random() * 1.4 } : end);
  }
  if (way.length < 3) return null;
  delete way.at(-1).rest;
  return {
    path: way.map(drawnAt),
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
  const coffee = spotFeet(seat.plan, BREAK_SPOTS.find((s) => s.action === 'coffee'));
  const toCoffee = findPath(door, coffee, map);
  // To their desk by the lanes, which is the way back from the desk to the coffee, walked backwards.
  const fromDesk = laneWay(seat, coffee, map);
  if (!toCoffee || !fromDesk) return null;
  return { path: toCoffee.map(drawnAt), home: retraced(fromDesk).map(drawnAt), spot: { action: 'coffee', pause: 2.5 } };
}
