// Who sits where. No drawing here, so the rules can be tested on their own.
//
// A player owns the office's bots and is not one of them: a player has a column of rooms, and each
// of their bots has one workstation in a room. A room holds four bots, so a fifth opens the next
// room. A floor takes three players and ten bots per player, so bots 11 to 20 are on another floor.
//
// A bot keeps its workstation for as long as it is here. When it leaves, that workstation is free,
// and the next bot its owner gets takes the lowest free one.

export const PLAYERS_PER_FLOOR = 3;
export const BOTS_PER_COLUMN = 10;
export const BOTS_PER_ROOM = 4;

const columnOf = (slot) => Math.floor(slot / BOTS_PER_COLUMN);
const roomOf = (slot) => Math.floor((slot % BOTS_PER_COLUMN) / BOTS_PER_ROOM);
const sameRoom = (a, b) => columnOf(a) === columnOf(b) && roomOf(a) === roomOf(b);

/** @typedef {{id: string, ownerId: string, ownerName?: string}} Bot */

export function createAllocator() {
  // ownerId -> { id, name, seats: Map<slot, botId> }. A Map keeps owners in the order they arrived,
  // so nobody's column jumps when somebody else's bots come and go.
  const owners = new Map();
  let present = new Set();

  /** @param {Bot[]} bots @param {Array<{id: string, name?: string}>} [players]  who is in the office */
  function sync(bots, players = []) {
    present = new Set(players.map((p) => p.id));
    for (const player of players) {
      if (!owners.has(player.id)) owners.set(player.id, { id: player.id, name: player.name ?? '', seats: new Map() });
      else if (player.name) owners.get(player.id).name = player.name;
    }
    const here = new Map(bots.map((b) => [b.id, b]));
    for (const owner of owners.values()) {
      for (const [slot, id] of owner.seats) {
        if (here.get(id)?.ownerId !== owner.id) owner.seats.delete(slot);
      }
    }
    const seated = new Set([...owners.values()].flatMap((o) => [...o.seats.values()]));
    for (const bot of bots) {
      let owner = owners.get(bot.ownerId);
      if (!owner) {
        owner = { id: bot.ownerId, name: bot.ownerName ?? '', seats: new Map() };
        owners.set(bot.ownerId, owner);
      }
      if (bot.ownerName) owner.name = bot.ownerName;
      if (seated.has(bot.id)) continue;
      let slot = 0;
      while (owner.seats.has(slot)) slot++;
      owner.seats.set(slot, bot.id);
    }
    return layout();
  }

  /** The first free workstation that would not open a new room just to stand empty. */
  function standbySlot(active) {
    for (const owner of active) {
      let slot = 0;
      while (owner.seats.has(slot)) slot++;
      if (!owner.seats.size || [...owner.seats.keys()].some((s) => sameRoom(s, slot))) return { owner, slot };
    }
    return null;
  }

  function layout() {
    // Anyone with a bot, and any player in the office, whether they have bots yet or not.
    const active = [...owners.values()].filter((o) => o.seats.size || present.has(o.id));
    const standby = standbySlot(active);

    /** @type {Array<{columns: Array}>} */
    const floors = [];
    for (const owner of active) {
      const chunks = new Set([...owner.seats.keys()].map((s) => Math.floor(s / BOTS_PER_COLUMN)));
      if (!chunks.size) chunks.add(0);
      for (const chunk of [...chunks].sort((a, b) => a - b)) {
        // The first floor with room that does not already hold this owner.
        let floor = floors.find((f) => f.columns.length < PLAYERS_PER_FLOOR && !f.columns.some((c) => c.ownerId === owner.id));
        if (!floor) {
          floor = { columns: [] };
          floors.push(floor);
        }
        const slots = [...owner.seats.keys()].filter((s) => Math.floor(s / BOTS_PER_COLUMN) === chunk);
        if (standby?.owner === owner && Math.floor(standby.slot / BOTS_PER_COLUMN) === chunk) slots.push(standby.slot);
        // Rows close up over any gap, so a small team stays together.
        const rows = slots.sort((a, b) => a - b).map((slot) => ({
          slot,
          number: slot + 1,
          room: roomOf(slot),
          botId: owner.seats.get(slot) ?? null,
          standby: !owner.seats.has(slot),
        }));
        const rooms = [...new Set(rows.map((r) => r.room))].map((index) => ({
          // Numbered through all of a player's rooms, across floors.
          number: chunk * Math.ceil(BOTS_PER_COLUMN / BOTS_PER_ROOM) + index + 1,
          rows: rows.filter((r) => r.room === index),
        }));
        if (!rooms.length) rooms.push({ number: chunk * Math.ceil(BOTS_PER_COLUMN / BOTS_PER_ROOM) + 1, rows: [] });
        floor.columns.push({ ownerId: owner.id, ownerName: owner.name, rows, rooms });
      }
    }
    if (!floors.length) floors.push({ columns: [] });
    return { floors };
  }

  return { sync, layout };
}
