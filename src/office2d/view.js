// The office as 2D pixel art, from a fixed, elevated angle. A camera moves over it and zooms between
// one room and a whole floor; it never turns, so the angle is the same everywhere.
//
// Only the picture lives here. Agents, their work and their events are the same objects as ever;
// this asks who is present and how they are doing, and allocation.js says who sits where. Layers,
// from the bottom: tiled floor, walls and furniture, a workstation per bot, and one worker at each
// active workstation. The art is in assets/pixel-art/office/established.

import { createAllocator } from './allocation.js';
import { createAmbient } from './ambient.js';
import { clockText, hostMinutes, phaseOf } from './sky.js';

const ROOT = '/assets/pixel-art/office/established/';

// All in art pixels. Every room is this size: the player at the top middle, two agents down each
// side of an aisle, and a strip along the foot of the room to walk to the doors by.
const INNER_W = 300;
const INNER_H = 284;
const WALL_H = 62;
const ROW_TOP = 126;
const ROW_H = 66;
const AISLE_X = 150;
const FOOT_Y = INNER_H - 13;
const BORDER = 7;
const ROOM_W = INNER_W + BORDER * 2;
const ROOM_H = INNER_H + BORDER * 2;
// Neighbouring rooms share a wall, so one frame stands between them.
const STEP_X = ROOM_W - BORDER;
const STEP_Y = ROOM_H - BORDER;
// The shared break area, and where somebody stands to use each thing in it.
const BREAK_W = 250;
const BREAK_LANE_Y = 130;
const BREAK_SPOTS = [
  { action: 'coffee', x: 46, y: WALL_H + 30 },
  { action: 'fridge', x: 124, y: WALL_H + 36 },
  { action: 'microwave', x: 174, y: WALL_H + 38 },
  { action: 'water', x: 222, y: WALL_H + 36 },
];

const TOP_BAR = 56; // the office's top bar, in page pixels, which the scene stays below
const MARGIN = 8;
const DRAW_EVERY = 1 / 20; // pixel art does not need more unless the camera is moving
const EASE = 9;
const ASK_HOST_EVERY = 60_000;
// How the room's light falls with the time of day, as a wash over everything.
const ROOM_LIGHT = { dawn: 'rgba(255, 170, 110, 0.07)', day: null, dusk: 'rgba(190, 90, 70, 0.1)', night: 'rgba(24, 28, 74, 0.2)' };
const WINDOW_GLASS = { x: 3, y: 3, w: 98, h: 43 };
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

const BACKGROUND = '#f6ead2';
const OAK_LIGHT = '#eeb565';
const OAK = '#d9913f';
const OAK_DARK = '#8c5420';
const GREEN = '#3f6248';
const CREAM = '#fbf3e4';

const WORKER_W = 26;
const WORKER_H = 44;
const POSES = 4; // standing, breathing, and two steps
const HAIRS = 6;
const SCREENS = ['code', 'dashboard', 'chart', 'chat', 'terminal', 'landscape'];
const AT_REST = new Set(['idle', 'resting', 'drinking']);
const OWNER_DEFAULT = { id: 'owner', name: 'Your team' };
const CLOCK_DIGITS = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};
const SHELF_GLOW = '#ffe08a';

/** Free for a break: resting, or only moving about with no job in hand. Anything else is real work. */
const isFree = (bot) => AT_REST.has(bot.status) || (bot.status === 'walking' && !bot.job);

const hashOf = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;

function rgb(colour) {
  const hex = typeof colour === 'number' ? colour.toString(16).padStart(6, '0') : String(colour ?? '4f8f86').replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
const shade = ([r, g, b], k) => [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1)))));

function toHsl(r, g, b) {
  const hi = Math.max(r, g, b) / 255;
  const lo = Math.min(r, g, b) / 255;
  const l = (hi + lo) / 2;
  const d = hi - lo;
  if (!d) return [0, 0, l];
  const top = Math.max(r, g, b);
  let h;
  if (top === r) h = ((g - b) / 255 / d + 6) % 6;
  else if (top === g) h = (b - r) / 255 / d + 2;
  else h = (r - g) / 255 / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}

/**
 * The workers with their tops in somebody's colour, so people can be told apart. Each pixel keeps
 * its own lightness, so the art's folds and shading survive the change.
 */
function recoloured(image, colour) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const target = rgb(colour);
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const y = Math.floor(i / 4 / canvas.width);
    if (y < 19 || y > 34) continue; // the top half of the body, not the face or the legs
    const [h, sat, l] = toHsl(data[i], data[i + 1], data[i + 2]);
    const teal = h > 140 && h < 200 && sat > 0.1 && l > 0.15;
    const hoodie = sat < 0.25 && l > 0.1 && l < 0.34;
    if (!teal && !hoodie) continue;
    const k = teal ? l / 0.45 : (l + 0.18) / 0.45;
    data.set(shade(target, Math.min(1.5, k)), i);
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** Who is a bot, and whose. A player is the office's owner and has no desk of their own. */
function rosterOf(world, ownerOf) {
  if (!world) return [];
  const bots = [];
  for (const { agent } of world.manager.agents.values()) {
    const id = String(agent.id);
    if (id.includes('human-') || String(agent.name).endsWith('(human)')) continue;
    const owner = ownerOf?.(id) ?? OWNER_DEFAULT;
    bots.push({ id, ownerId: owner.id, ownerName: owner.name, name: agent.name, status: agent.status, job: agent.job, color: agent.color });
  }
  // An agent has a desk from the moment they are added, and sits idle until their worker can run them.
  for (const agent of window.crewAgents?.() ?? []) {
    if (bots.some((b) => b.id.endsWith(`#crew:${agent.id}`))) continue;
    bots.push({ id: `waiting#crew:${agent.id}`, ownerId: agent.ownerId, ownerName: agent.ownerName, name: agent.name, status: 'idle', color: agent.color, waiting: true });
  }
  return bots;
}

/**
 * Where everything on a floor goes: a column per player with their rooms one above the other, or
 * side by side for a player alone on a floor, and the break area beside the top row. Rooms share
 * their walls and are joined by doors, all the way along to the break area.
 */
function placeFloor(floor) {
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

const boundsOf = ({ rooms, breakRoom }) => ({
  w: breakRoom.x + breakRoom.width,
  h: Math.max(ROOM_H, ...rooms.map((r) => r.y + ROOM_H)),
});

/** Where a workstation is in its room. Odd seats are on the right, and desks face the aisle. */
function stationAt(room, index) {
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
 * @param {HTMLCanvasElement} canvas  takes the whole office; pointer events go to what is under it
 * @param {HTMLElement} input  what the pointer actually lands on, for the wheel and for dragging
 */
export function createOffice2D(canvas, input) {
  const context = canvas.getContext('2d');
  const allocator = createAllocator();
  const strips = new Map();
  const shells = new Map();
  const arrived = new Map();
  let sprites = null;
  let clock = 0;
  let sinceDraw = DRAW_EVERY;
  let ratio = 1;

  // What is on this floor, from the latest frame.
  let floors = [{ columns: [] }];
  let floorIndex = 0;
  let rooms = [];
  let floorPlan = { rooms: [], breakRoom: { x: ROOM_W, y: 0, width: BREAK_W + BORDER * 2 } };
  const ambient = createAmbient();
  const decor = new Map();
  let playersOverride = null;
  let hoveringShelf = null;
  let shelfGlow = null;
  let players = new Map();
  let notice = null;
  // The host's clock and sky. Until it answers, this browser's own time is the best guess there is.
  const host = { now: Date.now(), offsetMinutes: -new Date().getTimezoneOffset(), reportedAt: performance.now(), weather: null };
  const askHost = () => fetch('/api/crew/host-conditions', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((report) => {
      if (report) Object.assign(host, { now: report.now, offsetMinutes: report.offsetMinutes, reportedAt: performance.now(), weather: report.weather });
    })
    .catch(() => {});
  askHost();
  setInterval(askHost, ASK_HOST_EVERY);
  const minutesNow = () => hostMinutes({ hostNow: host.now, offsetMinutes: host.offsetMinutes, sinceReport: performance.now() - host.reportedAt });
  let seats = new Map();
  let placed = [];
  let lastSelected = null;
  let walkingNow = [];

  // The camera. `view` is what it is aimed at; `chosen` is whether a person aimed it, because until
  // then it picks for itself: the room if there is only one, otherwise the whole floor.
  const view = { mode: 'floor', roomKey: null, chosen: false };
  const camera = { x: ROOM_W / 2, y: ROOM_H / 2, scale: 0 };
  let originX = 0;
  let originY = 0;
  let scale = 1;
  let dragged = null; // art-pixel offset a drag has added, while looking around
  let moving = true;

  // Moving the camera ---------------------------------------------------------------------------

  const allRooms = () => floors.flatMap((floor, index) => placeFloor(floor).rooms.map((room) => ({ ...room, floor: index })));

  function showFloor(index = floorIndex) {
    floorIndex = Math.max(0, Math.min(floors.length - 1, index));
    Object.assign(view, { mode: 'floor', roomKey: null, chosen: true });
    dragged = null;
    moving = true;
  }

  function showRoom(key) {
    const room = allRooms().find((r) => r.key === key);
    if (!room) return;
    floorIndex = room.floor;
    Object.assign(view, { mode: 'room', roomKey: key, chosen: true });
    dragged = null;
    moving = true;
  }

  function step(direction) {
    if (view.mode === 'room') {
      const list = allRooms();
      const at = list.findIndex((r) => r.key === view.roomKey);
      showRoom(list[(at + direction + list.length) % list.length].key);
    } else {
      showFloor((floorIndex + direction + floors.length) % floors.length);
    }
  }

  function zoomIn(at = null) {
    if (view.mode === 'room') return;
    const hit = at && rooms.find((r) => at.x >= r.x && at.x <= r.x + ROOM_W && at.y >= r.y && at.y <= r.y + ROOM_H);
    const target = hit ?? rooms[0];
    if (target) showRoom(target.key);
  }

  function zoomOut() {
    if (view.mode !== 'floor') showFloor();
  }

  function createControls() {
    const element = document.createElement('div');
    element.id = 'office-camera';
    const button = (text, label, onclick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onclick);
      return b;
    };
    const previous = button('◀', 'Previous', () => step(-1));
    const next = button('▶', 'Next', () => step(1));
    const place = document.createElement('span');
    const out = button('−', 'Zoom out to the floor', () => zoomOut());
    const into = button('+', 'Zoom in on a room', () => zoomIn());
    element.append(previous, place, next, out, into);
    return {
      element,
      update(text, canStep, isRoom, canZoom) {
        if (place.textContent !== text) place.textContent = text;
        previous.hidden = !canStep;
        next.hidden = !canStep;
        out.disabled = !isRoom || !canZoom;
        into.disabled = isRoom || !canZoom;
      },
    };
  }

  const controls = createControls();
  canvas.parentElement.append(controls.element);

  fetch(`${ROOT}sprites.json`)
    .then((res) => res.json())
    .then((list) => Promise.all(Object.entries(list).map(([name, meta]) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve([name, { ...meta, image }]);
      image.onerror = () => reject(new Error(`Could not load ${name}`));
      image.src = `${ROOT}${name}.png`;
    }))))
    .then((loaded) => { sprites = Object.fromEntries(loaded); })
    .catch((err) => console.warn(err.message));

  const toArt = (clientX, clientY) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((clientX - box.left) * ratio - originX) / scale,
      y: ((clientY - box.top) * ratio - originY) / scale,
    };
  };

  let wheelAt = 0;
  input.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 280) return;
    wheelAt = now;
    if (e.deltaY < 0) zoomIn(toArt(e.clientX, e.clientY));
    else zoomOut();
  }, { passive: false });

  const shelfAt = (art) => rooms.find((room) => {
    if (!sprites) return false;
    const shelf = shelfOf(room);
    return art.x >= shelf.x && art.x <= shelf.x + shelf.width && art.y >= shelf.y && art.y <= shelf.y + shelf.height;
  });

  input.addEventListener('pointermove', (e) => {
    const hit = shelfAt(toArt(e.clientX, e.clientY));
    hoveringShelf = hit?.key ?? null;
    input.style.cursor = hit ? 'pointer' : '';
  });

  /** The bookshelf opens the office's shared files, which every player and their agents can reach. */
  function openSharedFiles() {
    if (window.crewOpenFiles) window.crewOpenFiles();
    else notice = { text: 'Shared files are in hosted offices. Host one from the lobby.', until: performance.now() + 4000 };
  }

  let dragFrom = null;
  input.addEventListener('pointerdown', (e) => { dragFrom = { x: e.clientX, y: e.clientY, start: dragged ?? { x: 0, y: 0 } }; });
  window.addEventListener('pointerup', () => { dragFrom = null; });
  window.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    const dx = e.clientX - dragFrom.x;
    const dy = e.clientY - dragFrom.y;
    if (!dragged && Math.hypot(dx, dy) < 6) return;
    dragged = { x: dragFrom.start.x - (dx * ratio) / scale, y: dragFrom.start.y - (dy * ratio) / scale };
    moving = true;
  });

  // Drawing ---------------------------------------------------------------------------------------

  function frameOf(s) {
    return s.frames > 1 && s.fps ? Math.floor(clock * s.fps) % s.frames : 0;
  }

  function put(name, x, y, frame = null) {
    const s = sprites[name];
    context.drawImage(s.image, (frame ?? frameOf(s)) * s.width, 0, s.width, s.height, Math.round(x), Math.round(y), s.width, s.height);
  }

  function workerStrip(colour) {
    const key = String(colour);
    let strip = strips.get(key);
    if (!strip) {
      strip = recoloured(sprites.worker.image, colour);
      strips.set(key, strip);
    }
    return strip;
  }

  function putFlipped(name, x, y, frame = null) {
    const s = sprites[name];
    context.save();
    context.translate(Math.round(x) * 2 + s.width, 0);
    context.scale(-1, 1);
    put(name, x, y, frame);
    context.restore();
  }

  function drawPerson(image, frame, x, y, flip) {
    const px = Math.round(x);
    const py = Math.round(y);
    context.save();
    if (flip) {
      context.translate(px * 2 + WORKER_W, 0);
      context.scale(-1, 1);
    }
    context.drawImage(image, frame * WORKER_W, 0, WORKER_W, WORKER_H, px, py, WORKER_W, WORKER_H);
    context.restore();
  }

  /** A room's frame, floor and wall, painted once for each width and reused, as nothing in it moves. */
  function shellFor(width) {
    if (shells.has(width)) return shells.get(width);
    const shell = document.createElement('canvas');
    shell.width = width;
    shell.height = ROOM_H;
    const g = shell.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = OAK_DARK;
    g.fillRect(4, 0, width - 8, ROOM_H);
    g.fillRect(0, 4, width, ROOM_H - 8);
    g.fillStyle = OAK;
    g.fillRect(5, 1, width - 10, ROOM_H - 2);
    g.fillRect(1, 5, width - 2, ROOM_H - 10);

    const inner = width - BORDER * 2;
    const tile = sprites.floor;
    g.beginPath();
    g.rect(BORDER, BORDER, inner, INNER_H);
    g.clip();
    for (let ty = BORDER + WALL_H; ty < BORDER + INNER_H; ty += tile.height) {
      for (let tx = BORDER; tx < BORDER + inner; tx += tile.width) g.drawImage(tile.image, tx, ty);
    }
    g.fillStyle = '#f3e4c8';
    g.fillRect(BORDER, BORDER, inner, WALL_H - 4);
    g.fillStyle = '#ecdabb';
    g.fillRect(BORDER, BORDER + WALL_H - 14, inner, 10);
    g.fillStyle = OAK_LIGHT;
    g.fillRect(BORDER, BORDER + WALL_H - 4, inner, 2);
    g.fillStyle = OAK_DARK;
    g.fillRect(BORDER, BORDER + WALL_H - 2, inner, 2);
    g.fillStyle = 'rgba(70, 35, 10, 0.18)';
    g.fillRect(BORDER, BORDER + WALL_H, inner, 3);
    shells.set(width, shell);
    return shell;
  }

  function drawShell(x, y, width) {
    context.drawImage(shellFor(width), Math.round(x), Math.round(y));
  }

  const widthOf = (prop) => sprites[prop.on ?? prop.sprite].width;

  /**
   * A room's own furniture, chosen once from its name: the same room always looks the same, and
   * different rooms differ. All of it stands clear of the desks, the aisle and the walk to the door.
   */
  function decorFor(room) {
    if (decor.has(room.key)) return decor.get(room.key);
    let seed = hashOf(room.key);
    const roll = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 16) % n;
    };
    const flipped = roll(2) === 1;
    let left = FLOOR_PROPS[roll(FLOOR_PROPS.length)];
    const others = FLOOR_PROPS.filter((p) => p !== left);
    let right = others[roll(others.length)];
    // With the shelf on the left, the gap between it and the player only takes something narrow.
    if (flipped && widthOf(left) > 38) [left, right] = [right, left];
    if (flipped && widthOf(left) > 38) left = FLOOR_PROPS[0];
    const recipe = {
      flipped,
      left,
      right,
      picture: PICTURES[roll(PICTURES.length)],
      small: SMALL_PROPS[roll(SMALL_PROPS.length)],
      rug: roll(2) === 0,
    };
    decor.set(room.key, recipe);
    return recipe;
  }

  function putStanding(prop, x, bottom) {
    const main = sprites[prop.sprite];
    if (prop.on) {
      // Something that stands on something else, such as a fax on its table.
      const under = sprites[prop.on];
      put(prop.on, x, bottom - under.height);
      put(prop.sprite, x + Math.round((under.width - main.width) / 2) - 2, bottom - under.height - main.height + 12);
      return;
    }
    put(prop.sprite, x, bottom - main.height);
  }

  /** The bookshelf of a room, which opens the shared files when clicked. */
  function shelfOf(room) {
    const { flipped } = decorFor(room);
    const left = room.x + BORDER;
    const top = room.y + BORDER;
    const shelf = sprites.shelf;
    return { x: flipped ? left + 6 : left + INNER_W - shelf.width - 8, y: top + WALL_H - 44, width: shelf.width, height: shelf.height };
  }

  function drawRoom(room) {
    const left = room.x + BORDER;
    const top = room.y + BORDER;
    const recipe = decorFor(room);
    drawShell(room.x, room.y, ROOM_W);
    drawWindow(left + (recipe.flipped ? 182 : 14), top + 5);
    drawClock(left + (recipe.flipped ? 62 : 190), top + 12);
    if (recipe.picture && room.down === 0 && room.number !== 1) put(recipe.picture, left + AISLE_X - 15, top + 24);
    if (recipe.rug) put('rug', left + AISLE_X - 36, top + ROW_TOP + 40);
    drawShelf(room);
    const bottom = top + WALL_H + 54;
    putStanding(recipe.left, left + (recipe.flipped ? 58 : 8), bottom);
    putStanding(recipe.right, left + INNER_W - widthOf(recipe.right) - (recipe.flipped ? 8 : 54), bottom);
    if (recipe.small) put(recipe.small, left + (recipe.flipped ? INNER_W - 28 - 56 : 56), bottom - sprites[recipe.small].height);
    // A door in the back wall, from the room behind this one.
    if (room.down > 0) put('door', left + AISLE_X - 19, top + WALL_H - 56);
  }

  /** The player, at the top middle of their first room. They own the room and have no bot's seat. */
  function drawPlayer(room) {
    if (room.number !== 1) return;
    const left = room.x + BORDER;
    const top = room.y + BORDER;
    put('desk-active-landscape', left + 120, top + WALL_H - 8);
    const chosen = players.get(room.ownerId)?.character;
    const character = Number.isInteger(chosen) ? chosen : hashOf(room.ownerId) % HAIRS;
    const pose = Math.floor(clock * 1.1) % 2;
    drawPerson(sprites.worker.image, character * POSES + pose, left + 98, top + WALL_H + 12, false);
  }

  function drawStation(room, row, index, bots) {
    const at = stationAt(room, index);
    const { y } = at;
    context.fillStyle = 'rgba(247, 232, 196, 0.2)';
    context.fillRect(at.rugX, y - 8, 124, ROW_H - 4);
    context.strokeStyle = 'rgba(63, 98, 72, 0.4)';
    context.lineWidth = 1;
    context.strokeRect(at.rugX + 0.5, y - 7.5, 123, ROW_H - 5);

    const desk = at.right ? put : putFlipped;
    const deskY = y - 8;
    if (row.standby) {
      context.globalAlpha = 0.6;
      desk('desk-standby', at.deskX, deskY);
      context.globalAlpha = 1;
      return { kind: 'standby', x: at.workerX + 13, y: y + 22 };
    }

    const bot = bots.get(row.botId);
    const working = !isFree(bot);
    const hash = hashOf(row.botId);
    // Each bot keeps its own program on its screen, while it is working.
    desk(working ? `desk-active-${SCREENS[(hash >>> 4) % SCREENS.length]}` : 'desk-idle', at.deskX, deskY);

    const item = {
      kind: 'bot', id: row.botId, bot, hash, y, rugX: at.rugX, badgeX: at.badgeX, nameX: at.nameX,
      centreX: at.workerX + WORKER_W / 2, headY: y + 6,
    };
    if (ambient.whereIs(row.botId)) return item; // on a break, and drawn where they are

    // Then the worker beside the desk, on the aisle side.
    const pose = Math.floor(clock * (working ? 3.2 : 1.1) + (hash % 5)) % 2;
    if (!arrived.has(row.botId)) arrived.set(row.botId, performance.now());
    const age = (performance.now() - arrived.get(row.botId)) / 1000;
    const hop = age < 0.35 ? Math.round((0.35 - age) * 24) : 0;
    const workerY = y + 6 - hop;
    context.fillStyle = 'rgba(58, 28, 8, 0.28)';
    context.fillRect(at.workerX + 4, y + 6 + WORKER_H - 2, WORKER_W - 8, 2);
    context.globalAlpha = Math.min(1, age / 0.25);
    drawPerson(workerStrip(bot.color), (hash % HAIRS) * POSES + pose, at.workerX, workerY, !at.right);
    context.globalAlpha = 1;
    if (bot.status === 'error') {
      context.fillStyle = '#c0392b';
      context.fillRect(at.workerX + 10, workerY - 5, 5, 5);
      context.fillStyle = CREAM;
      context.fillRect(at.workerX + 12, workerY - 4, 1, 2);
      context.fillRect(at.workerX + 12, workerY - 1, 1, 1);
    }
    return item;
  }

  // The break area, and the doors that join it all up. ---------------------------------------------

  function drawBreakRoom(breakRoom, heating) {
    const left = breakRoom.x + BORDER;
    const top = breakRoom.y + BORDER;
    drawShell(breakRoom.x, breakRoom.y, breakRoom.width);

    drawClock(left + 201, top + 6);
    put('noticeboard', left + 141, top + 2);
    put('counter', left + 4, top + WALL_H - 24);
    put('coffee', left + 18, top + WALL_H - 62);
    put('fridge', left + 104, top + WALL_H - 52);
    put('side-table', left + 150, top + WALL_H - 12);
    put('microwave', left + 152, top + WALL_H - 34, heating ? null : 0);
    put('cooler', left + 210, top + WALL_H - 32);

    // A place to sit, away from the door and the way to the counter.
    const sofaY = top + INNER_H - 72;
    put('sofa', left + 148, sofaY);
    put('lamp', left + 226, sofaY - 8);
    put('plant', left + 88, top + INNER_H - 74);
  }

  /** The window for this time of day at the host, with the host's weather across the glass. */
  function drawWindow(x, y) {
    put(`window-${phaseOf(minutesNow())}`, x, y);
    const { weather } = host;
    if (!weather || weather === 'clear') return;
    const gx = x + WINDOW_GLASS.x;
    const gy = y + WINDOW_GLASS.y;
    const paneRows = WINDOW_GLASS.h;
    context.save();
    context.beginPath();
    context.rect(gx, gy, WINDOW_GLASS.w, paneRows);
    context.clip();
    if (weather === 'cloudy' || weather === 'rain' || weather === 'storm') {
      context.fillStyle = weather === 'cloudy' ? 'rgba(160, 168, 178, 0.45)' : 'rgba(92, 100, 116, 0.62)';
      context.fillRect(gx, gy, WINDOW_GLASS.w, paneRows);
      context.fillStyle = weather === 'cloudy' ? 'rgba(232, 234, 236, 0.75)' : 'rgba(120, 126, 140, 0.9)';
      const drift = Math.floor(clock * 2) % 40;
      for (let n = 0; n < 5; n++) {
        const cx = gx + ((n * 23 + drift) % (WINDOW_GLASS.w + 20)) - 14;
        context.fillRect(cx, gy + 2 + (n % 3) * 5, 22, 4);
        context.fillRect(cx + 4, gy + (n % 3) * 5, 13, 2);
      }
    }
    if (weather === 'rain' || weather === 'storm') {
      context.fillStyle = 'rgba(208, 226, 240, 0.8)';
      for (let n = 0; n < 26; n++) {
        const fall = Math.floor(clock * 34 + n * 13) % (paneRows + 6);
        const rx = gx + ((n * 17) % WINDOW_GLASS.w) - Math.floor(fall / 4);
        context.fillRect(rx, gy + fall - 3, 1, 3);
      }
    }
    if (weather === 'storm' && Math.floor(clock * 4) % 37 === 0) {
      context.fillStyle = 'rgba(250, 250, 255, 0.7)';
      context.fillRect(gx, gy, WINDOW_GLASS.w, paneRows);
    }
    if (weather === 'snow') {
      context.fillStyle = 'rgba(190, 200, 212, 0.35)';
      context.fillRect(gx, gy, WINDOW_GLASS.w, paneRows);
      context.fillStyle = '#ffffff';
      for (let n = 0; n < 30; n++) {
        const fall = Math.floor(clock * 9 + n * 11) % paneRows;
        const sway = Math.round(Math.sin(clock + n) * 1.5);
        context.fillRect(gx + ((n * 19) % WINDOW_GLASS.w) + sway, gy + fall, 1, 1);
      }
    }
    if (weather === 'fog') {
      context.fillStyle = 'rgba(226, 228, 226, 0.68)';
      context.fillRect(gx, gy, WINDOW_GLASS.w, paneRows);
    }
    context.restore();
  }

  /** A modern wall clock, showing the host's time, with a colon that ticks over each second. */
  function drawClock(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    put('wall-clock', px, py);
    const text = clockText(minutesNow());
    let dx = px + 5;
    for (const char of text) {
      if (char === ':') {
        if (Math.floor(performance.now() / 1000) % 2 === 0) {
          context.fillStyle = '#7fe0cc';
          context.fillRect(dx, py + 7, 2, 2);
          context.fillRect(dx, py + 11, 2, 2);
        }
        dx += 4;
        continue;
      }
      CLOCK_DIGITS[char].forEach((row, r) => {
        [...row].forEach((on, c) => {
          if (on !== '1') return;
          context.fillStyle = '#7fe0cc';
          context.fillRect(dx + c * 2, py + 5 + r * 2, 2, 2);
        });
      });
      dx += 9;
    }
  }

  /** The bookshelf, which lifts and glows under the pointer because clicking it does something. */
  function drawShelf(room) {
    const shelf = shelfOf(room);
    if (hoveringShelf !== room.key) {
      put('shelf', shelf.x, shelf.y);
      return;
    }
    if (!shelfGlow) {
      const sprite = sprites.shelf;
      shelfGlow = document.createElement('canvas');
      shelfGlow.width = sprite.width + 4;
      shelfGlow.height = sprite.height + 4;
      const g = shelfGlow.getContext('2d');
      for (const [ox, oy] of [[0, 2], [4, 2], [2, 0], [2, 4], [1, 1], [3, 1], [1, 3], [3, 3]]) g.drawImage(sprite.image, ox, oy);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = SHELF_GLOW;
      g.fillRect(0, 0, shelfGlow.width, shelfGlow.height);
    }
    const lift = 2;
    context.globalAlpha = 0.65 + Math.sin(clock * 6) * 0.3;
    context.drawImage(shelfGlow, shelf.x - 2, shelf.y - 2 - lift);
    context.globalAlpha = 1;
    put('shelf', shelf.x, shelf.y - lift);
    context.fillStyle = '#fff6c8';
    for (let n = 0; n < 4; n++) {
      if ((Math.floor(clock * 5) + n) % 3 === 0) continue;
      const sx = shelf.x + (n * 17 + 5) % shelf.width;
      const sy = shelf.y - lift - 4 + ((n * 23 + Math.floor(clock * 6) * 3) % shelf.height);
      context.fillRect(sx, sy, 2, 2);
    }
  }

  function drawDoors(plan) {
    const side = (x, y) => {
      // An opening in the shared wall, at floor level, with the frame showing either side of it.
      context.fillStyle = '#c87a33';
      context.fillRect(x, y - 30, BORDER, 44);
      context.fillStyle = '#9a5a24';
      context.fillRect(x, y - 22, BORDER, 1);
      context.fillRect(x, y - 7, BORDER, 1);
      context.fillRect(x, y + 8, BORDER, 1);
      for (const postY of [y - 36, y + 14]) {
        context.fillStyle = OAK_DARK;
        context.fillRect(x - 3, postY, BORDER + 6, 7);
        context.fillStyle = OAK_LIGHT;
        context.fillRect(x - 2, postY + 1, BORDER + 4, 2);
      }
    };
    const footOf = (room) => room.y + BORDER + FOOT_Y;
    for (const room of plan.rooms) {
      if (room.across > 0 && room.down === 0) side(room.x, footOf(room));
      if (room.down > 0) {
        // Through the shared wall from the room behind, to the door on this side of it.
        context.fillStyle = '#b9742c';
        context.fillRect(room.x + BORDER + AISLE_X - 15, room.y, 30, BORDER);
      }
    }
    side(plan.breakRoom.x, plan.breakRoom.y + BORDER + FOOT_Y);
  }

  /** The way from a bot's seat to one of the break area's spots: along the aisle and through doors. */
  function routeTo(seat, spot) {
    const { room, plan, index } = seat;
    const at = stationAt(room, index);
    const seatX = at.workerX;
    const seatY = at.y + 6;
    const path = [{ x: seatX, y: seatY }];
    const aisle = room.x + BORDER + AISLE_X - WORKER_W / 2;
    const toFoot = (r) => r.y + BORDER + FOOT_Y - WORKER_H;
    path.push({ x: aisle, y: seatY });
    if (room.down > 0) {
      // Up the aisle and through the door in the back wall, room by room.
      for (let down = room.down; down > 0; down--) {
        path.push({ x: aisle, y: down * STEP_Y + BORDER + WALL_H - WORKER_H + 4 });
        path.push({ x: aisle, y: (down - 1) * STEP_Y + BORDER + FOOT_Y - WORKER_H });
      }
    } else {
      path.push({ x: aisle, y: toFoot(room) });
    }
    const breakLeft = plan.breakRoom.x + BORDER;
    const breakTop = plan.breakRoom.y + BORDER;
    const footY = breakTop + FOOT_Y - WORKER_H;
    path.push({ x: breakLeft + 18, y: footY });
    path.push({ x: breakLeft + 18, y: breakTop + BREAK_LANE_Y - WORKER_H });
    path.push({ x: breakLeft + spot.x - WORKER_W / 2, y: breakTop + BREAK_LANE_Y - WORKER_H });
    path.push({ x: breakLeft + spot.x - WORKER_W / 2, y: breakTop + spot.y - WORKER_H });
    return path;
  }

  function planBreak(bot, taken) {
    const seat = seats.get(bot.id);
    if (!seat) return null;
    const free = BREAK_SPOTS.filter((s) => !taken.has(s.action));
    if (!free.length) return null;
    const spot = free[Math.floor(Math.random() * free.length)];
    return { path: routeTo(seat, spot), spot };
  }

  /** Whoever is away from their desk on this floor, drawn over the room. */
  function drawWalkers(bots) {
    const walkers = [];
    for (const [id, seat] of seats) {
      if (seat.floor !== floorIndex) continue;
      const where = ambient.whereIs(id);
      if (where && bots.has(id)) walkers.push({ id, where, bot: bots.get(id) });
    }
    walkers.sort((a, b) => a.where.y - b.where.y);
    const shown = [];
    for (const { id, where, bot } of walkers) {
      const hash = hashOf(id);
      const pose = where.moving ? 2 + Math.floor(clock * 7) % 2 : Math.floor(clock * 1.1 + (hash % 5)) % 2;
      context.fillStyle = 'rgba(58, 28, 8, 0.28)';
      context.fillRect(Math.round(where.x) + 4, Math.round(where.y) + WORKER_H - 2, WORKER_W - 8, 2);
      drawPerson(workerStrip(bot.color), (hash % HAIRS) * POSES + pose, where.x, where.y, where.direction < 0);
      if (where.holding) {
        const handX = Math.round(where.x) + (where.direction < 0 ? 2 : 21);
        const handY = Math.round(where.y) + 24;
        context.fillStyle = '#3a2212';
        context.fillRect(handX - 1, handY - 1, 6, 6);
        context.fillStyle = CREAM;
        context.fillRect(handX, handY, 4, 4);
        context.fillStyle = '#6b3f21';
        context.fillRect(handX, handY, 4, 1);
      }
      if (where.talking) drawBubble(where.x + WORKER_W / 2, where.y - 4, hash);
      shown.push({ id, x: where.x + WORKER_W / 2, y: where.y });
    }
    return shown;
  }

  /** A small speech bubble with dots, which is all a chat ever shows. */
  function drawBubble(x, y, hash) {
    const left = Math.round(x) - 10;
    const top = Math.round(y) - 13;
    context.fillStyle = '#3a2212';
    context.fillRect(left, top + 1, 21, 9);
    context.fillRect(left + 1, top, 19, 11);
    context.fillRect(left + 8, top + 11, 4, 2);
    context.fillStyle = CREAM;
    context.fillRect(left + 1, top + 1, 19, 9);
    context.fillRect(left + 9, top + 10, 2, 2);
    context.fillStyle = '#4a2c12';
    const dots = 1 + (Math.floor(clock * 2.4) + (hash % 3)) % 3;
    for (let d = 0; d < dots; d++) context.fillRect(left + 5 + d * 4, top + 5, 2, 2);
  }

  // Text and plaques go on at the screen's own resolution, so they stay crisp at any zoom. ---------

  const toScreenX = (x) => originX + x * scale;
  const toScreenY = (y) => originY + y * scale;

  function plaque(text, sx, sy, { size = 9, fill = GREEN, ink = CREAM, border = '#2b4532', pad = 8 } = {}) {
    const fontSize = Math.max(10 * ratio, size * Math.min(scale, 3) * 0.72);
    context.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
    const width = context.measureText(text).width + pad * 2 * ratio;
    const height = fontSize * 1.75;
    const edge = Math.max(1, Math.round(ratio));
    context.fillStyle = border;
    context.fillRect(Math.round(sx - width / 2 - edge), Math.round(sy - height / 2 - edge), Math.round(width + edge * 2), Math.round(height + edge * 2));
    context.fillStyle = fill;
    context.fillRect(Math.round(sx - width / 2), Math.round(sy - height / 2), Math.round(width), Math.round(height));
    context.fillStyle = ink;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, sx, sy + ratio / 2);
  }

  function drawLabels(selectedId, visible, floorText, breakPlan) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = true;

    const detailed = scale >= 1;
    for (const room of visible) {
      const label = room.number > 1 ? `${room.ownerName || 'Owner'} · Room ${room.number}` : room.ownerName || 'Owner';
      plaque(label, toScreenX(room.x + BORDER + AISLE_X), toScreenY(room.y + BORDER + 9), { fill: OAK_LIGHT, ink: '#4a2c12', border: OAK_DARK });
    }

    if (breakPlan) {
      plaque('Break area', toScreenX(breakPlan.x + breakPlan.width / 2), toScreenY(breakPlan.y + 3), { fill: OAK_LIGHT, ink: '#4a2c12', border: OAK_DARK });
    }

    const small = Math.max(10 * ratio, 6 * Math.min(scale, 3));
    for (const item of placed) {
      if (item.kind === 'standby') {
        if (!detailed) continue;
        context.font = `600 ${small}px Inter, system-ui, sans-serif`;
        context.fillStyle = 'rgba(74, 44, 18, 0.72)';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('Standby', toScreenX(item.x), toScreenY(item.y));
        continue;
      }
      plaque(String(item.number), toScreenX(item.badgeX), toScreenY(item.y + 40), { size: 8, fill: CREAM, ink: GREEN, border: GREEN, pad: 4 });
      const selected = item.id === selectedId;
      if (!detailed && !selected) continue;
      const name = String(item.bot.name ?? '');
      const label = name.length > 20 ? `${name.slice(0, 19)}…` : name;
      context.font = `${selected ? 700 : 600} ${small}px Inter, system-ui, sans-serif`;
      const width = context.measureText(label).width + 8 * ratio;
      const cx = toScreenX(item.nameX);
      const sy = toScreenY(item.y + 45);
      context.fillStyle = selected ? 'rgba(47, 116, 104, 0.96)' : 'rgba(46, 28, 18, 0.76)';
      context.fillRect(Math.round(cx - width / 2), Math.round(sy), Math.round(width), Math.round(small * 1.35));
      context.fillStyle = CREAM;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, cx, sy + small * 0.72);
    }

    for (const room of visible) {
      const shelf = shelfOf(room);
      const hovering = hoveringShelf === room.key;
      if (detailed || hovering) {
        plaque(hovering ? 'Share a file' : 'Files', toScreenX(shelf.x + shelf.width / 2), toScreenY(shelf.y + shelf.height + 4), hovering
          ? { size: 8, pad: 4 }
          : { size: 7, fill: CREAM, ink: GREEN, border: GREEN, pad: 3 });
      }
    }
    if (notice && performance.now() < notice.until) plaque(notice.text, canvas.width / 2, canvas.height - 90 * ratio, { size: 9 });

    // On the frame of the floor, where the office's top bar cannot cover it.
    if (floorText) plaque(floorText, toScreenX(boundsOf(floorPlan).w / 2), toScreenY(3), { size: 10 });
  }

  /** The space the scene may use: below the top bar, and clear of the agent panel when it is open. */
  function freeSpace(width, height) {
    const panel = document.getElementById('agent-panel-close')?.parentElement;
    const box = panel?.getBoundingClientRect();
    const left = box && box.width && box.left < 60 ? Math.round((box.right + 8) * ratio) : 0;
    const top = Math.round(TOP_BAR * ratio);
    return { left, top, w: width - left, h: height - top - MARGIN * ratio };
  }

  function aimCamera(width, height, dt) {
    const space = freeSpace(width, height);
    const target = view.mode === 'room' ? rooms.find((r) => r.key === view.roomKey) : null;
    const bounds = boundsOf(floorPlan);
    const w = target ? ROOM_W : bounds.w;
    const h = target ? ROOM_H : bounds.h;
    const fit = Math.min(space.w / w, space.h / h);
    // Whole numbers keep every pixel square. A whole floor may need less than one, and then it is
    // an overview: you zoom in for the detail.
    const wantedScale = fit >= 1 ? Math.floor(fit) : fit;
    const offset = dragged ?? { x: 0, y: 0 };
    const wantedX = (target ? target.x + ROOM_W / 2 : bounds.w / 2) + offset.x;
    const wantedY = (target ? target.y + ROOM_H / 2 : bounds.h / 2) + offset.y;

    if (!camera.scale) Object.assign(camera, { x: wantedX, y: wantedY, scale: wantedScale });
    const k = 1 - Math.exp(-EASE * dt);
    camera.x += (wantedX - camera.x) * k;
    camera.y += (wantedY - camera.y) * k;
    camera.scale += (wantedScale - camera.scale) * k;
    const settled = Math.abs(wantedX - camera.x) < 0.5 && Math.abs(wantedY - camera.y) < 0.5 && Math.abs(wantedScale - camera.scale) < 0.01;
    if (settled) Object.assign(camera, { x: wantedX, y: wantedY, scale: wantedScale });
    moving = !settled;

    scale = camera.scale;
    originX = Math.round(space.left + space.w / 2 - camera.x * scale);
    originY = Math.round(space.top + space.h / 2 - camera.y * scale);
  }

  function paint(world, dt, selectedId, ownerOf) {
    ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);
    if (!sprites) return;

    const roster = rosterOf(world, ownerOf);
    const bots = new Map(roster.map((b) => [b.id, b]));
    for (const id of arrived.keys()) if (!bots.has(id)) arrived.delete(id);
    const present = (world === null ? [] : playersOverride ?? window.crewPlayers?.()) ?? [];
    players = new Map(present.map((p) => [p.id, p]));
    floors = allocator.sync(roster, present).floors;
    floorIndex = Math.min(floorIndex, floors.length - 1);

    const everyRoom = allRooms();
    // A room that has gone leaves nothing to look at; and until somebody aims the camera, the view
    // is the floor, which also shows the break area.
    if (view.mode === 'room' && !everyRoom.some((r) => r.key === view.roomKey)) Object.assign(view, { mode: 'floor', roomKey: null });
    if (!view.chosen) Object.assign(view, { mode: 'floor', roomKey: null });
    // Choosing somebody in the agent list brings the camera to them.
    if (selectedId !== lastSelected) {
      lastSelected = selectedId;
      const seat = everyRoom.find((r) => r.rows.some((row) => row.botId === String(selectedId)));
      if (seat && seat.key !== view.roomKey) showRoom(seat.key);
    }

    // Every bot's seat, on every floor, because a break goes on whichever floor is on screen.
    seats = new Map();
    floors.forEach((floor, index) => {
      const plan = placeFloor(floor);
      for (const room of plan.rooms) {
        room.rows.forEach((row, i) => {
          if (row.botId) seats.set(row.botId, { room, plan, index: i, floor: index });
        });
      }
    });
    ambient.update(dt, roster.map((b) => ({ id: b.id, idle: isFree(b) && !b.waiting })), planBreak);

    floorPlan = placeFloor(floors[floorIndex]);
    rooms = floorPlan.rooms;
    if (!rooms.length) {
      rooms = [{ key: 'empty', ownerId: OWNER_DEFAULT.id, ownerName: OWNER_DEFAULT.name, number: 1, rows: [], across: 0, down: 0, x: 0, y: 0 }];
      floorPlan = { rooms, breakRoom: { x: STEP_X, y: 0, width: BREAK_W + BORDER * 2 } };
    }
    aimCamera(width, height, dt);
    context.setTransform(scale, 0, 0, scale, originX, originY);
    context.imageSmoothingEnabled = scale < 1;

    // Only what the camera can see is drawn.
    const seen = (x, y, w) => toScreenX(x + w) > 0 && toScreenX(x) < width && toScreenY(y + ROOM_H) > 0 && toScreenY(y) < height;
    const visible = rooms.filter((r) => seen(r.x, r.y, ROOM_W));
    const breakPlan = seen(floorPlan.breakRoom.x, floorPlan.breakRoom.y, floorPlan.breakRoom.width) ? floorPlan.breakRoom : null;
    if (breakPlan) {
      const heating = [...seats.entries()].some(([id, seat]) => seat.floor === floorIndex && ambient.actionOf(id) === 'microwave');
      drawBreakRoom(breakPlan, heating);
    }
    placed = [];
    for (const room of visible) drawRoom(room);
    drawDoors(floorPlan);
    for (const room of visible) {
      drawPlayer(room);
      room.rows.forEach((row, r) => {
        const item = drawStation(room, row, r, bots);
        placed.push({ ...item, number: row.number, roomKey: room.key });
      });
    }
    const walking = drawWalkers(bots);

    // The room's light follows the host's time of day.
    const light = ROOM_LIGHT[phaseOf(minutesNow())];
    if (light) {
      const all = boundsOf(floorPlan);
      context.fillStyle = light;
      context.fillRect(0, 0, all.w, all.h);
    }

    const floorText = `FLOOR ${floorIndex + 1}${floors.length > 1 ? ` of ${floors.length}` : ''}`;
    walkingNow = walking;
    drawLabels(selectedId, visible, view.mode === 'floor' ? floorText : '', breakPlan);

    const here = rooms.find((r) => r.key === view.roomKey);
    const text = view.mode === 'room' && here
      ? `${here.ownerName || 'Owner'} · Room ${here.number}`
      : `Floor ${floorIndex + 1}`;
    controls.update(text, view.mode === 'room' ? everyRoom.length > 1 : floors.length > 1, view.mode === 'room', everyRoom.length > 0);
  }

  return {
    // For checking how a given team would look, without having to hire them first.
    rosterOverride: null,
    zoomIn: () => zoomIn(),
    zoomOut,
    showRoom,
    showFloor,
    /** Where a point of the art is on the canvas, and how many are away, for checking animations. */
    canvasPoint: (x, y) => ({ x: toScreenX(x), y: toScreenY(y), scale }),
    get awayCount() { return ambient.awayCount; },
    /** Show a given set of players, for checking how a team would look. */
    setPlayersForChecks(list) { playersOverride = list; },
    /** Show a given time and weather, for checking how the window looks. */
    setHostForChecks(report) { Object.assign(host, report, { reportedAt: performance.now() }); },
    /** Send an idle bot on a break straight away, for checking how it looks. */
    sendOnBreak(id) {
      const plan = planBreak({ id }, new Set());
      if (plan) ambient.sendNow({ id }, plan);
    },

    /** Called every frame. It only draws a few times a second, unless the camera is moving. */
    draw(world, dt, { selectedId = null, ownerOf = null } = {}) {
      clock += dt;
      sinceDraw += dt;
      if (!moving && sinceDraw < DRAW_EVERY) return;
      const elapsed = sinceDraw;
      sinceDraw = 0;
      const source = this.rosterOverride
        ? { manager: { agents: new Map(this.rosterOverride.map((a) => [a.id, { agent: a }])) } }
        : world;
      paint(source, elapsed, selectedId, this.rosterOverride ? (id) => this.rosterOverride.find((a) => a.id === id)?.owner : ownerOf);
    },

    /** Where the top of a worker's head is, in page pixels, or null if they are out of view. */
    agentAt(id) {
      const walker = walkingNow.find((w) => w.id === String(id));
      const box = canvas.getBoundingClientRect();
      if (walker) return { x: box.left + toScreenX(walker.x) / ratio, y: box.top + toScreenY(walker.y) / ratio };
      const item = placed.find((p) => p.id === String(id));
      if (!item) return null;
      return { x: box.left + toScreenX(item.centreX) / ratio, y: box.top + toScreenY(item.headY) / ratio };
    },

    /**
     * What a click on the office means. The id of the worker under it, or null for bare floor, or
     * undefined when the click only aimed the camera, which should leave the selection alone.
     */
    pick(clientX, clientY) {
      const at = toArt(clientX, clientY);
      if (shelfAt(at)) {
        openSharedFiles();
        return undefined;
      }
      // Clicking your own character is how you change it.
      const self = rooms.find((room) => room.number === 1 && at.x >= room.x + BORDER + 96 && at.x <= room.x + BORDER + 124 && at.y >= room.y + BORDER + WALL_H + 10 && at.y <= room.y + BORDER + WALL_H + 58);
      if (self && window.crewChooseCharacter?.(self.ownerId)) return undefined;
      const hit = placed.find((p) => p.kind === 'bot' && at.x >= p.rugX && at.x <= p.rugX + 124 && at.y >= p.y - 8 && at.y <= p.y + 56);
      if (view.mode === 'floor') {
        zoomIn(at);
        return hit ? hit.id : undefined;
      }
      return hit?.id ?? null;
    },
  };
}
