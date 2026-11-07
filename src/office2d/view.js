// The office as 2D pixel art, from a fixed, elevated angle. A camera moves over it and zooms between
// one room and a whole floor; it never turns, so the angle is the same everywhere.
//
// Only the picture lives here. Agents, their work and their events are the same objects as ever;
// this asks who is present and how they are doing, and allocation.js says who sits where. Layers,
// from the bottom: tiled floor, walls and furniture, a workstation per bot, and one worker at each
// active workstation. The art is in assets/pixel-art/office/established.

import { createAllocator } from './allocation.js';

const ROOT = '/assets/pixel-art/office/established/';

// All in art pixels. Every room is this size, which always fits four bots and the lounge beside them.
const INNER_W = 270;
const WALL_H = 62;
const ROW_H = 62;
const ROWS_TOP = WALL_H + 16;
const ROOM_ROWS = 4;
const INNER_H = ROWS_TOP + ROOM_ROWS * ROW_H + 8;
const BORDER = 7;
const ROOM_W = INNER_W + BORDER * 2;
const ROOM_H = INNER_H + BORDER * 2;
const GAP = 14;

const TOP_BAR = 56; // the office's top bar, in page pixels, which the scene stays below
const MARGIN = 8;
const DRAW_EVERY = 1 / 20; // pixel art does not need more unless the camera is moving
const EASE = 9;

const BACKGROUND = '#f6ead2';
const OAK_LIGHT = '#eeb565';
const OAK = '#d9913f';
const OAK_DARK = '#8c5420';
const GREEN = '#3f6248';
const CREAM = '#fbf3e4';

const WORKER_W = 26;
const WORKER_H = 44;
const POSES = 2;
const HAIRS = 6;
const SCREENS = ['code', 'dashboard', 'chart', 'chat', 'terminal', 'landscape'];
const AT_REST = new Set(['idle', 'resting', 'drinking']);
const OWNER_DEFAULT = { id: 'owner', name: 'Your team' };

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
    bots.push({ id, ownerId: owner.id, ownerName: owner.name, name: agent.name, status: agent.status, color: agent.color });
  }
  return bots;
}

/**
 * Where each room of a floor goes: a column per player, their rooms one above the other. A player
 * alone on a floor has them side by side instead, which suits a wide screen and keeps them larger.
 */
function placeRooms(floor) {
  const rooms = [];
  const alone = floor.columns.length === 1;
  floor.columns.forEach((column, c) => {
    column.rooms.forEach((room, r) => {
      rooms.push({
        key: `${column.ownerId}:${room.number}`,
        ownerName: column.ownerName,
        number: room.number,
        rows: room.rows,
        x: (alone ? r : c) * (ROOM_W + GAP),
        y: alone ? 0 : r * (ROOM_H + GAP),
        doorAbove: !alone && r > 0,
        doorLeft: alone && r > 0,
      });
    });
  });
  return rooms;
}

const boundsOf = (rooms) => ({
  w: Math.max(ROOM_W, ...rooms.map((r) => r.x + ROOM_W)),
  h: Math.max(ROOM_H, ...rooms.map((r) => r.y + ROOM_H)),
});

/**
 * @param {HTMLCanvasElement} canvas  takes the whole office; pointer events go to what is under it
 * @param {HTMLElement} input  what the pointer actually lands on, for the wheel and for dragging
 */
export function createOffice2D(canvas, input) {
  const context = canvas.getContext('2d');
  const allocator = createAllocator();
  const strips = new Map();
  const arrived = new Map();
  let sprites = null;
  let clock = 0;
  let sinceDraw = DRAW_EVERY;
  let ratio = 1;

  // What is on this floor, from the latest frame.
  let floors = [{ columns: [] }];
  let floorIndex = 0;
  let rooms = [];
  let placed = [];
  let lastSelected = null;

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

  const allRooms = () => floors.flatMap((floor, index) => placeRooms(floor).map((room) => ({ ...room, floor: index })));

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

  function drawRoom(room) {
    const { x, y } = room;
    const left = x + BORDER;
    const top = y + BORDER;

    // A doorway from the room before it.
    if (room.doorAbove) {
      context.fillStyle = OAK_DARK;
      context.fillRect(left + INNER_W / 2 - 22, y - GAP, 44, GAP + BORDER);
      context.fillStyle = OAK_LIGHT;
      context.fillRect(left + INNER_W / 2 - 19, y - GAP, 38, GAP + BORDER);
    }
    if (room.doorLeft) {
      context.fillStyle = OAK_DARK;
      context.fillRect(x - GAP, top + WALL_H + 90, GAP + BORDER, 44);
      context.fillStyle = OAK_LIGHT;
      context.fillRect(x - GAP, top + WALL_H + 93, GAP + BORDER, 38);
    }

    // The frame, its corners cut.
    context.fillStyle = OAK_DARK;
    context.fillRect(x + 4, y, ROOM_W - 8, ROOM_H);
    context.fillRect(x, y + 4, ROOM_W, ROOM_H - 8);
    context.fillStyle = OAK;
    context.fillRect(x + 5, y + 1, ROOM_W - 10, ROOM_H - 2);
    context.fillRect(x + 1, y + 5, ROOM_W - 2, ROOM_H - 10);

    // The tiled floor.
    const tile = sprites.floor;
    context.save();
    context.beginPath();
    context.rect(left, top, INNER_W, INNER_H);
    context.clip();
    for (let ty = top + WALL_H; ty < top + INNER_H; ty += tile.height) {
      for (let tx = left; tx < left + INNER_W; tx += tile.width) put('floor', tx, ty);
    }
    context.restore();

    // The back wall, a window looking out, and a line of shade where the wall meets the floor.
    context.fillStyle = '#f3e4c8';
    context.fillRect(left, top, INNER_W, WALL_H - 4);
    context.fillStyle = '#ecdabb';
    context.fillRect(left, top + WALL_H - 14, INNER_W, 10);
    context.fillStyle = OAK_LIGHT;
    context.fillRect(left, top + WALL_H - 4, INNER_W, 2);
    context.fillStyle = OAK_DARK;
    context.fillRect(left, top + WALL_H - 2, INNER_W, 2);
    context.fillStyle = 'rgba(70, 35, 10, 0.18)';
    context.fillRect(left, top + WALL_H, INNER_W, 3);
    put('window', left + 26, top + 5);

    // Furniture stands before the wall on the right, and a lounge beyond the desks.
    put('cooler', left + 152, top + WALL_H - 38);
    put('shelf', left + 212, top + WALL_H - 44);
    put('plant', left + 214, top + 132);
    put('sofa', left + 162, top + INNER_H - 62);
    put('lamp', left + 244, top + INNER_H - 74);
  }

  function drawRow(row, left, y, bots) {
    context.fillStyle = 'rgba(247, 232, 196, 0.2)';
    context.fillRect(left + 6, y - 8, 136, ROW_H - 3);
    context.strokeStyle = 'rgba(63, 98, 72, 0.4)';
    context.lineWidth = 1;
    context.strokeRect(left + 6.5, y - 7.5, 135, ROW_H - 4);

    const deskX = left + 56;
    const deskY = y - 8;
    if (row.standby) {
      context.globalAlpha = 0.6;
      put('desk-standby', deskX, deskY);
      context.globalAlpha = 1;
      return { kind: 'standby', x: left + 34, y: y + 22 };
    }

    const bot = bots.get(row.botId);
    const working = !AT_REST.has(bot.status);
    const hash = hashOf(row.botId);
    // Each bot keeps its own program on its screen, while it is working.
    put(working ? `desk-active-${SCREENS[(hash >>> 4) % SCREENS.length]}` : 'desk-idle', deskX, deskY);

    // Then the worker beside the desk, standing nearer the viewer.
    const pose = Math.floor(clock * (working ? 3.2 : 1.1) + (hash % 5)) % POSES;
    if (!arrived.has(row.botId)) arrived.set(row.botId, performance.now());
    const age = (performance.now() - arrived.get(row.botId)) / 1000;
    const hop = age < 0.35 ? Math.round((0.35 - age) * 24) : 0;
    const workerX = left + 30;
    const workerY = y + 6 - hop;
    context.fillStyle = 'rgba(58, 28, 8, 0.28)';
    context.fillRect(workerX + 4, y + 6 + WORKER_H - 2, WORKER_W - 8, 2);
    context.globalAlpha = Math.min(1, age / 0.25);
    context.drawImage(workerStrip(bot.color), ((hash % HAIRS) * POSES + pose) * WORKER_W, 0, WORKER_W, WORKER_H, workerX, workerY, WORKER_W, WORKER_H);
    context.globalAlpha = 1;
    if (bot.status === 'error') {
      context.fillStyle = '#c0392b';
      context.fillRect(workerX + 10, workerY - 5, 5, 5);
      context.fillStyle = CREAM;
      context.fillRect(workerX + 12, workerY - 4, 1, 2);
      context.fillRect(workerX + 12, workerY - 1, 1, 1);
    }
    return { kind: 'bot', id: row.botId, bot, left, y, centreX: workerX + WORKER_W / 2, headY: workerY };
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

  function drawLabels(selectedId, timeText, visible, floorText) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = true;

    const detailed = scale >= 1;
    for (const room of visible) {
      const label = room.number > 1 ? `${room.ownerName || 'Owner'} · Room ${room.number}` : room.ownerName || 'Owner';
      plaque(label, toScreenX(room.x + BORDER + 76), toScreenY(room.y + BORDER + WALL_H + 3), { fill: OAK_LIGHT, ink: '#4a2c12', border: OAK_DARK });
      if (detailed && timeText) {
        context.font = `700 ${Math.max(10 * ratio, 6 * scale)}px "JetBrains Mono", monospace`;
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        context.fillStyle = '#7a4a22';
        context.fillText(timeText, toScreenX(room.x + BORDER + INNER_W - 6), toScreenY(room.y + BORDER + 9));
      }
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
      plaque(String(item.number), toScreenX(item.left + 17), toScreenY(item.y + 22), { size: 8, fill: CREAM, ink: GREEN, border: GREEN, pad: 4 });
      const selected = item.id === selectedId;
      if (!detailed && !selected) continue;
      const name = String(item.bot.name ?? '');
      const label = name.length > 20 ? `${name.slice(0, 19)}…` : name;
      context.font = `${selected ? 700 : 600} ${small}px Inter, system-ui, sans-serif`;
      const width = context.measureText(label).width + 8 * ratio;
      const cx = toScreenX(item.left + 96);
      const sy = toScreenY(item.y + 49);
      context.fillStyle = selected ? 'rgba(47, 116, 104, 0.96)' : 'rgba(46, 28, 18, 0.76)';
      context.fillRect(Math.round(cx - width / 2), Math.round(sy), Math.round(width), Math.round(small * 1.35));
      context.fillStyle = CREAM;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, cx, sy + small * 0.72);
    }

    if (floorText) plaque(floorText, canvas.width / 2, (TOP_BAR - 22) * ratio, { size: 12 });
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
    const bounds = boundsOf(rooms);
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

  function paint(world, dt, selectedId, timeText, ownerOf) {
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
    floors = allocator.sync(roster).floors;
    floorIndex = Math.min(floorIndex, floors.length - 1);

    const everyRoom = allRooms();
    // A room that has gone leaves nothing to look at; and until somebody aims the camera, one room
    // fills the view and several show as a floor.
    if (view.mode === 'room' && !everyRoom.some((r) => r.key === view.roomKey)) Object.assign(view, { mode: 'floor', roomKey: null });
    if (!view.chosen) {
      if (everyRoom.length === 1) Object.assign(view, { mode: 'room', roomKey: everyRoom[0].key });
      else Object.assign(view, { mode: 'floor', roomKey: null });
    }
    // Choosing somebody in the agent list brings the camera to them.
    if (selectedId !== lastSelected) {
      lastSelected = selectedId;
      const seat = everyRoom.find((r) => r.rows.some((row) => row.botId === String(selectedId)));
      if (seat && seat.key !== view.roomKey) showRoom(seat.key);
    }

    rooms = placeRooms(floors[floorIndex]);
    if (!rooms.length) rooms = [{ key: 'empty', ownerName: '', number: 1, rows: [], x: 0, y: 0 }];
    aimCamera(width, height, dt);
    context.setTransform(scale, 0, 0, scale, originX, originY);
    context.imageSmoothingEnabled = scale < 1;

    // Only what the camera can see is drawn.
    const visible = rooms.filter((r) => toScreenX(r.x + ROOM_W) > 0 && toScreenX(r.x) < width && toScreenY(r.y + ROOM_H) > 0 && toScreenY(r.y) < height);
    placed = [];
    for (const room of visible) {
      drawRoom(room);
      const left = room.x + BORDER;
      room.rows.forEach((row, r) => {
        const item = drawRow(row, left + 2, room.y + BORDER + ROWS_TOP + r * ROW_H, bots);
        placed.push({ ...item, number: row.number, roomKey: room.key });
      });
    }

    const floorText = `FLOOR ${floorIndex + 1}${floors.length > 1 ? ` of ${floors.length}` : ''}`;
    drawLabels(selectedId, timeText, visible, view.mode === 'floor' ? floorText : '');

    const here = rooms.find((r) => r.key === view.roomKey);
    const text = view.mode === 'room' && here
      ? `${here.ownerName || 'Owner'} · Room ${here.number}`
      : `Floor ${floorIndex + 1}`;
    controls.update(text, view.mode === 'room' ? everyRoom.length > 1 : floors.length > 1, view.mode === 'room', everyRoom.length > 1);
  }

  return {
    // For checking how a given team would look, without having to hire them first.
    rosterOverride: null,
    zoomIn: () => zoomIn(),
    zoomOut,
    showRoom,
    showFloor,

    /** Called every frame. It only draws a few times a second, unless the camera is moving. */
    draw(world, dt, { selectedId = null, timeText = '', ownerOf = null } = {}) {
      clock += dt;
      sinceDraw += dt;
      if (!moving && sinceDraw < DRAW_EVERY) return;
      const elapsed = sinceDraw;
      sinceDraw = 0;
      const source = this.rosterOverride
        ? { manager: { agents: new Map(this.rosterOverride.map((a) => [a.id, { agent: a }])) } }
        : world;
      paint(source, elapsed, selectedId, timeText, this.rosterOverride ? (id) => this.rosterOverride.find((a) => a.id === id)?.owner : ownerOf);
    },

    /** Where the top of a worker's head is, in page pixels, or null if they are out of view. */
    agentAt(id) {
      const item = placed.find((p) => p.id === String(id));
      if (!item) return null;
      const box = canvas.getBoundingClientRect();
      return { x: box.left + toScreenX(item.centreX) / ratio, y: box.top + toScreenY(item.headY) / ratio };
    },

    /**
     * What a click on the office means. The id of the worker under it, or null for bare floor, or
     * undefined when the click only aimed the camera, which should leave the selection alone.
     */
    pick(clientX, clientY) {
      const at = toArt(clientX, clientY);
      const hit = placed.find((p) => p.kind === 'bot' && at.x >= p.left + 6 && at.x <= p.left + 142 && at.y >= p.y - 8 && at.y <= p.y + 54);
      if (view.mode === 'floor') {
        zoomIn(at);
        return hit ? hit.id : undefined;
      }
      return hit?.id ?? null;
    },
  };
}
