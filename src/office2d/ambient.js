// What everybody in the office appears to be doing. Somebody with nothing to do spends most of their
// time at the keyboard, and the rest sitting back, wandering about, or fetching a drink or some food.
//
// This is only a picture. It holds where to draw somebody and what to show them doing, and reads
// nothing from an agent except whether they are free. It cannot change an agent's work, deliveries or
// status, and it has no way to reach them. An agent who gets real work while away heads straight back.

const SPEED = 46; // art pixels a second
const HURRY = 2.2;
const WORKING_SHARE = 0.7; // of the time somebody is free, the share they spend at the keyboard
const FIRST_STINT_MIN = 5;
const FIRST_STINT_MAX = 25;
const STINT_MIN = 8;
const STINT_MAX = 60;
const SITTING_MIN = 5;
const SITTING_MAX = 12;
const SIT_CHANCE = 0.3; // after a stint of work; the rest of the time they get up
const WANDER_CHANCE = 0.35;
const PAUSE_MIN = 3;
const PAUSE_MAX = 6;
const CHAT_MIN = 4;
const CHAT_MAX = 7;
const MAX_AWAY = 2;
const THROUGH_A_DOOR = 0.35; // seconds out of sight, on the far side of a door

const between = (random, low, high) => low + random() * (high - low);

/** The same way walked in the other direction, with each door still marking the stretch it is on. */
function retraced(points) {
  return points.map((point, i) => ({ x: point.x, y: point.y, through: Boolean(points[i + 1]?.through) })).reverse();
}

/**
 * @param {{random?: () => number}} [opts]
 */
export function createAmbient({ random = Math.random } = {}) {
  /** id -> what they are doing, for anyone not simply at their desk. */
  const away = new Map();
  /** id -> what they are doing at their desk, and how their free time has gone so far. */
  const desks = new Map();

  function leave(bot, plan) {
    const [start, ...rest] = plan.path;
    away.set(bot.id, {
      phase: 'going',
      x: start.x,
      y: start.y,
      path: rest,
      trail: [start],
      walked: 0,
      hidden: 0,
      waiting: 0,
      facingAway: false,
      spot: plan.spot,
      action: plan.spot.action,
      pause: plan.spot.pause ?? between(random, PAUSE_MIN, PAUSE_MAX),
      direction: 1,
      holding: false,
      talking: false,
      partner: null,
    });
  }

  function walk(person, dt, speed) {
    if (person.hidden > 0) {
      person.hidden -= dt;
      return false;
    }
    if (person.waiting > 0) {
      person.waiting -= dt;
      return false;
    }
    let budget = speed * dt;
    while (budget > 0 && person.path.length) {
      const next = person.path[0];
      if (next.through) {
        person.x = next.x;
        person.y = next.y;
        person.trail.push(person.path.shift());
        person.hidden = THROUGH_A_DOOR;
        return false;
      }
      const dx = next.x - person.x;
      const dy = next.y - person.y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) person.direction = Math.sign(dx);
      if (distance > 0.5) person.facingAway = dy < 0 && Math.abs(dy) > Math.abs(dx);
      if (distance <= budget) {
        person.x = next.x;
        person.y = next.y;
        person.trail.push(person.path.shift());
        person.walked += distance;
        budget -= distance;
        if (next.rest) {
          person.waiting = next.rest;
          return false;
        }
      } else {
        person.x += (dx / distance) * budget;
        person.y += (dy / distance) * budget;
        person.walked += budget;
        budget = 0;
      }
    }
    return !person.path.length;
  }

  function turnBack(person) {
    person.phase = 'back';
    person.talking = false;
    person.partner = null;
    person.waiting = 0;
    // From wherever they have got to, the way home is what they have walked so far, reversed, and
    // never a straight line, which could go through whatever the way out went around.
    person.path = retraced(person.trail);
    person.trail = [];
  }

  function endChat(person, others) {
    if (person.partner) {
      const partner = others.get(person.partner);
      if (partner) {
        partner.partner = null;
        partner.talking = false;
      }
    }
    person.partner = null;
    person.talking = false;
  }

  /** Long enough at the keyboard to bring their free time back up to the share it should be. */
  function startWorking(desk) {
    const owed = (WORKING_SHARE * desk.total - desk.worked) / (1 - WORKING_SHARE);
    desk.activity = 'working';
    desk.left = Math.max(STINT_MIN, Math.min(STINT_MAX, owed));
  }

  function startSitting(desk) {
    desk.activity = 'sitting';
    desk.left = between(random, SITTING_MIN, SITTING_MAX);
  }

  /** What to do after a stint of work: sit back, wander about, or go for a drink or some food. */
  function chooseNext(bot, desk, planFor) {
    const roll = random();
    if (roll < SIT_CHANCE || away.size >= MAX_AWAY) {
      startSitting(desk);
      return;
    }
    const kind = roll < SIT_CHANCE + WANDER_CHANCE ? 'wander' : 'break';
    const taken = new Set([...away.values()].map((p) => p.action));
    const plan = planFor(bot, taken, kind);
    if (plan) leave(bot, plan);
    else startSitting(desk);
  }

  function deskOf(id) {
    if (!desks.has(id)) {
      desks.set(id, { activity: 'working', left: between(random, FIRST_STINT_MIN, FIRST_STINT_MAX), worked: 0, total: 0 });
    }
    return desks.get(id);
  }

  return {
    /**
     * Move everybody along. `planFor(bot, taken, kind)` gives the way there, or null if there is none.
     *
     * @param {number} dt
     * @param {Array<{id: string, idle: boolean}>} bots
     * @param {(bot: object, taken: Set<string>, kind: 'wander' | 'break') => ?{path: Array<{x: number, y: number}>, spot: {action: string}}} planFor
     */
    update(dt, bots, planFor) {
      const here = new Map(bots.map((b) => [b.id, b]));
      for (const id of [...away.keys()]) {
        if (!here.has(id)) {
          endChat(away.get(id), away);
          away.delete(id);
        }
      }
      for (const id of [...desks.keys()]) if (!here.has(id)) desks.delete(id);

      for (const bot of bots) {
        const person = away.get(bot.id);
        const desk = deskOf(bot.id);
        if (!person) {
          // Time on real work is its own: it counts for nothing here, and changes nothing here.
          if (!bot.idle) continue;
          desk.total += dt;
          if (desk.activity === 'working') desk.worked += dt;
          desk.left -= dt;
          if (desk.left > 0) continue;
          if (desk.activity === 'working') chooseNext(bot, desk, planFor);
          else startWorking(desk);
          continue;
        }
        if (bot.idle) desk.total += dt;

        // Real work always wins.
        if (!bot.idle && person.phase !== 'back') {
          endChat(person, away);
          turnBack(person);
        }

        if (person.phase === 'going') {
          if (walk(person, dt, SPEED)) {
            person.phase = 'at';
            if (person.action === 'wander') continue;
            const other = [...away.entries()].find(([id, p]) => id !== bot.id && p.phase === 'at' && !p.partner && p.action !== 'wander');
            if (other) {
              const [otherId, otherPerson] = other;
              const chat = between(random, CHAT_MIN, CHAT_MAX);
              Object.assign(person, { partner: otherId, talking: true, pause: chat });
              Object.assign(otherPerson, { partner: bot.id, talking: true, pause: Math.max(otherPerson.pause, chat) });
              person.direction = Math.sign(otherPerson.x - person.x) || 1;
              otherPerson.direction = -person.direction;
            }
          }
        } else if (person.phase === 'at') {
          person.pause -= dt;
          // Somebody on their way over is worth waiting for, for a chat.
          const company = person.action !== 'wander'
            && [...away.values()].some((p) => p !== person && p.phase === 'going' && p.action !== 'wander');
          if (person.pause <= 0 && !company) {
            person.holding = person.action === 'coffee' || person.action === 'water';
            endChat(person, away);
            turnBack(person);
          }
        } else if (walk(person, dt, bot.idle ? SPEED : SPEED * HURRY)) {
          away.delete(bot.id);
          startWorking(desk);
        }
      }
    },

    /** Where to draw somebody who has left their desk, or null if they are at it. */
    whereIs(id) {
      const person = away.get(id);
      if (!person) return null;
      return {
        x: person.x,
        y: person.y,
        moving: person.phase !== 'at' && person.hidden <= 0 && person.waiting <= 0,
        direction: person.direction,
        facingAway: person.facingAway,
        holding: person.holding,
        talking: person.talking,
        phase: person.phase,
        walked: person.walked,
        hidden: person.hidden > 0,
      };
    },

    /** What somebody who is free appears to be doing at their desk: 'working' or 'sitting'. */
    activityOf(id) {
      return desks.get(id)?.activity ?? 'working';
    },

    /** What somebody is doing at the break area, once they have arrived. */
    actionOf(id) {
      const person = away.get(id);
      return person?.phase === 'at' ? person.action : null;
    },

    /** Send somebody off straight away, for checking how it looks. */
    sendNow(bot, plan) {
      if (plan && !away.has(bot.id)) leave(bot, plan);
    },

    get awayCount() { return away.size; },
  };
}
