// Finding a way across the office on foot, around whatever stands in it. No drawing, and it knows
// nothing about offices: only where the floor is, what stands on it, and which doors jump across a wall.
//
// Everything is measured at a person's feet, which is the only part of them that collides. Their body
// rises above their feet in the picture, so they can pass in front of a desk but never stand in it.

const CELL = 4;
const FOOT_HALF_W = 8; // how far a person's feet and body reach to either side
const FOOT_DEPTH = 4; // how far their feet reach back from the point they stand on
const SEARCH_RADIUS = 4; // in cells, for joining a point that is off the grid to the grid
const SAMPLE = 1.5;
const DIAGONAL = Math.SQRT2;

const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * Whether somebody can stand at a point.
 *
 * @param {{x: number, y: number}} point
 * @param {{walkable: Array<object>, solids: Array<object>}} map  rectangles, as {x, y, w, h}
 */
export function isClear(point, { walkable, solids }) {
  if (!walkable.some((r) => inside(point, r))) return false;
  return !solids.some((s) => point.x > s.x - FOOT_HALF_W && point.x < s.x + s.w + FOOT_HALF_W
    && point.y > s.y && point.y - FOOT_DEPTH < s.y + s.h);
}

/** Whether somebody can walk in a straight line between two points. */
export function isLineClear(a, b, map) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(distance / SAMPLE));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isClear({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, map)) return false;
  }
  return true;
}

/** A small priority queue, smallest first, as a floor can have tens of thousands of cells. */
function createHeap() {
  const items = [];
  const swap = (i, j) => { [items[i], items[j]] = [items[j], items[i]]; };
  return {
    get size() { return items.length; },
    push(key, cost) {
      items.push({ key, cost });
      let i = items.length - 1;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (items[up].cost <= items[i].cost) break;
        swap(i, up);
        i = up;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        for (let i = 0; ;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let least = i;
          if (l < items.length && items[l].cost < items[least].cost) least = l;
          if (r < items.length && items[r].cost < items[least].cost) least = r;
          if (least === i) break;
          swap(i, least);
          i = least;
        }
      }
      return top;
    },
  };
}

/** The fewest waypoints that still keep to clear floor: each one as far on as a straight walk goes. */
function straightened(points, map) {
  const kept = [points[0]];
  let at = 0;
  while (at < points.length - 1) {
    let far = points.length - 1;
    while (far > at + 1 && !isLineClear(points[at], points[far], map)) far--;
    kept.push(points[far]);
    at = far;
  }
  return kept;
}

/**
 * The way between two points, or null if there is none. A waypoint marked `through` is reached by
 * going through a door in a wall rather than by walking there, so nobody walks across the wall.
 *
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @param {{walkable: Array<object>, solids: Array<object>, links?: Array<{a: object, b: object}>}} map
 * @returns {?Array<{x: number, y: number, through?: boolean}>}
 */
export function findPath(from, to, map) {
  if (!isClear(from, map) || !isClear(to, map)) return null;
  const links = map.links ?? [];
  const right = Math.max(...map.walkable.map((r) => r.x + r.w));
  const bottom = Math.max(...map.walkable.map((r) => r.y + r.h));
  const across = Math.ceil(right / CELL) + 1;
  const down = Math.ceil(bottom / CELL) + 1;
  const keyOf = (gx, gy) => gx + gy * across;
  const pointOf = (key) => ({ x: (key % across) * CELL, y: Math.floor(key / across) * CELL });

  const clearCells = new Map();
  const clearCell = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= across || gy >= down) return false;
    const key = keyOf(gx, gy);
    if (!clearCells.has(key)) clearCells.set(key, isClear(pointOf(key), map));
    return clearCells.get(key);
  };

  /** The nearest cell somebody at this point can step straight onto. */
  const joinGrid = (point) => {
    const cx = Math.round(point.x / CELL);
    const cy = Math.round(point.y / CELL);
    let best = null;
    let bestDistance = Infinity;
    for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
        if (!clearCell(cx + dx, cy + dy)) continue;
        const cell = { x: (cx + dx) * CELL, y: (cy + dy) * CELL };
        const distance = Math.hypot(cell.x - point.x, cell.y - point.y);
        if (distance < bestDistance && isLineClear(point, cell, map)) {
          best = keyOf(cx + dx, cy + dy);
          bestDistance = distance;
        }
      }
    }
    return best;
  };

  const start = joinGrid(from);
  const goal = joinGrid(to);
  if (start === null || goal === null) return null;

  // A door joins the cells at its two sides, at no cost beyond a step.
  const jumps = new Map();
  for (const { a, b } of links) {
    const one = joinGrid(a);
    const other = joinGrid(b);
    if (one === null || other === null) continue;
    if (!jumps.has(one)) jumps.set(one, []);
    if (!jumps.has(other)) jumps.set(other, []);
    jumps.get(one).push(other);
    jumps.get(other).push(one);
  }

  // A* over the cells. Cutting a corner would clip whatever stands on it, so a diagonal needs both of
  // the cells beside it to be clear as well.
  const goalPoint = pointOf(goal);
  const estimate = (key) => {
    const p = pointOf(key);
    const dx = Math.abs(p.x - goalPoint.x) / CELL;
    const dy = Math.abs(p.y - goalPoint.y) / CELL;
    return dx + dy + (DIAGONAL - 2) * Math.min(dx, dy);
  };
  const costs = new Map([[start, 0]]);
  const cameFrom = new Map();
  const open = createHeap();
  open.push(start, 0);
  let found = false;
  while (open.size) {
    const { key } = open.pop();
    if (key === goal) {
      found = true;
      break;
    }
    const gx = key % across;
    const gy = Math.floor(key / across);
    const cost = costs.get(key);
    const visit = (next, step, through) => {
      const total = cost + step;
      if (total >= (costs.get(next) ?? Infinity)) return;
      costs.set(next, total);
      cameFrom.set(next, { key, through });
      open.push(next, total + estimate(next));
    };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || !clearCell(gx + dx, gy + dy)) continue;
        if (dx && dy && !(clearCell(gx + dx, gy) && clearCell(gx, gy + dy))) continue;
        visit(keyOf(gx + dx, gy + dy), dx && dy ? DIAGONAL : 1, false);
      }
    }
    for (const next of jumps.get(key) ?? []) visit(next, 1, true);
  }
  if (!found) return null;

  // Back from the goal, in stretches split at each door, as a straight line never crosses one.
  const stretches = [[{ ...to }]];
  let key = goal;
  for (;;) {
    stretches[0].unshift(pointOf(key));
    const step = cameFrom.get(key);
    if (!step) break;
    if (step.through) stretches.unshift([]);
    key = step.key;
  }
  stretches[0].unshift({ ...from });

  const path = [];
  stretches.forEach((stretch, i) => {
    const way = straightened(stretch, map);
    way.forEach((point, j) => {
      path.push(i > 0 && j === 0 ? { ...point, through: true } : point);
    });
  });
  return path;
}
