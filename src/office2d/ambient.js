// Small routines that make the office feel lived in: an idle agent wanders to the break area, gets
// a drink or some food, perhaps chats with whoever is there, and goes back.
//
// This is only a picture. It holds where to draw somebody, and reads nothing from an agent except
// whether they are idle. It cannot change an agent's work, deliveries or status, and it has no way
// to reach them. An agent who gets real work while away heads straight back.

const SPEED = 46; // art pixels a second
const HURRY = 2.2;
const WAIT_MIN = 8;
const WAIT_MAX = 30;
const PAUSE_MIN = 3;
const PAUSE_MAX = 6;
const CHAT_MIN = 4;
const CHAT_MAX = 7;
const MAX_AWAY = 2;

const between = (random, low, high) => low + random() * (high - low);

/**
 * @param {{random?: () => number}} [opts]
 */
export function createAmbient({ random = Math.random } = {}) {
  /** id -> what they are doing, for anyone not simply at their desk. */
  const away = new Map();
  /** id -> seconds until they next feel like a break. */
  const waits = new Map();

  const nextWait = () => between(random, WAIT_MIN, WAIT_MAX);

  function leave(bot, plan) {
    const [start, ...rest] = plan.path;
    away.set(bot.id, {
      phase: 'going',
      x: start.x,
      y: start.y,
      path: rest,
      back: [...plan.path].reverse().slice(1),
      spot: plan.spot,
      action: plan.spot.action,
      pause: between(random, PAUSE_MIN, PAUSE_MAX),
      direction: 1,
      holding: false,
      talking: false,
      partner: null,
    });
  }

  function walk(person, dt, speed) {
    let budget = speed * dt;
    while (budget > 0 && person.path.length) {
      const next = person.path[0];
      const dx = next.x - person.x;
      const dy = next.y - person.y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) person.direction = Math.sign(dx);
      if (distance <= budget) {
        person.x = next.x;
        person.y = next.y;
        person.path.shift();
        budget -= distance;
      } else {
        person.x += (dx / distance) * budget;
        person.y += (dy / distance) * budget;
        budget = 0;
      }
    }
    return !person.path.length;
  }

  function turnBack(person) {
    person.phase = 'back';
    person.talking = false;
    person.partner = null;
    // From wherever they have got to, the way home is what they have walked so far, reversed.
    person.path = person.back;
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

  return {
    /**
     * Move everybody along. `planFor(bot)` gives the way to a break spot, or null if there is none.
     *
     * @param {number} dt
     * @param {Array<{id: string, idle: boolean}>} bots
     * @param {(bot: object, taken: Set<string>) => ?{path: Array<{x: number, y: number}>, spot: {action: string}}} planFor
     */
    update(dt, bots, planFor) {
      const here = new Map(bots.map((b) => [b.id, b]));
      for (const id of [...away.keys()]) {
        if (!here.has(id)) {
          endChat(away.get(id), away);
          away.delete(id);
        }
      }
      for (const id of [...waits.keys()]) if (!here.has(id)) waits.delete(id);

      for (const bot of bots) {
        const person = away.get(bot.id);
        if (!person) {
          // Only somebody with nothing to do wanders off, and only a couple at a time. Time at work
          // doesn't count towards a break, but it doesn't start the wait over either.
          if (!bot.idle) continue;
          if (!waits.has(bot.id)) waits.set(bot.id, nextWait());
          const left = waits.get(bot.id) - dt;
          waits.set(bot.id, left);
          if (left <= 0) {
            waits.set(bot.id, nextWait());
            if (away.size < MAX_AWAY) {
              const taken = new Set([...away.values()].map((p) => p.action));
              const plan = planFor(bot, taken);
              if (plan) leave(bot, plan);
            }
          }
          continue;
        }

        // Real work always wins.
        if (!bot.idle && person.phase !== 'back') {
          endChat(person, away);
          turnBack(person);
        }

        if (person.phase === 'going') {
          if (walk(person, dt, SPEED)) {
            person.phase = 'at';
            const other = [...away.entries()].find(([id, p]) => id !== bot.id && p.phase === 'at' && !p.partner);
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
          const company = [...away.values()].some((p) => p !== person && p.phase === 'going');
          if (person.pause <= 0 && !company) {
            person.holding = person.action === 'coffee' || person.action === 'water';
            endChat(person, away);
            turnBack(person);
          }
        } else if (walk(person, dt, bot.idle ? SPEED : SPEED * HURRY)) {
          away.delete(bot.id);
          waits.set(bot.id, nextWait());
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
        moving: person.phase !== 'at',
        direction: person.direction,
        holding: person.holding,
        talking: person.talking,
        phase: person.phase,
      };
    },

    /** What somebody is doing at the break area, once they have arrived. */
    actionOf(id) {
      const person = away.get(id);
      return person?.phase === 'at' ? person.action : null;
    },

    /** Send somebody on a break straight away, for checking how it looks. */
    sendNow(bot, plan) {
      if (plan && !away.has(bot.id)) leave(bot, plan);
    },

    get awayCount() { return away.size; },
  };
}
