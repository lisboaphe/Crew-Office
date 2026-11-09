// Screenshots the agents took, kept on this computer for its owner to look at, keep or delete.
//
// One folder, <dataDir>/shots, and nothing else to it: an agent that saves an image there has
// shared it. Claude's office hook copies the screenshots Claude takes into it by itself
// (bin/aop-send.cjs); any other agent, Codex included, is told the folder and saves there. A
// small JSON file beside an image says who took it and whether the owner chose to keep it, and an
// image that arrives without one is still shown, named after whoever its file name says.
//
// None of this goes anywhere else. The images are never put in a room, never sent through the
// relay, and the routes that serve them answer only the owner of this computer (lib/crew/api.cjs).

'use strict';

const fs = require('fs');
const path = require('path');
const { httpError } = require('./auth.cjs');

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
// A plain file name with an image's extension. Anything with a separator, a leading dot or a
// `..` cannot get past this, so a name from a request can only ever mean a file in the folder.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(png|jpe?g|webp|gif)$/i;
const MAX_LISTED = 500;
// Who an image without notes came from, by how its file name starts.
const BY_PREFIX = [[/^claude/i, 'Claude'], [/^codex/i, 'Codex'], [/^cursor/i, 'Cursor'], [/^openclaw/i, 'OpenClaw']];

function createShots({ dataDir }) {
  const folder = path.join(dataDir, 'shots');

  function file(name) {
    if (!NAME.test(String(name ?? '')) || String(name).includes('..')) throw httpError(400, 'Not a screenshot name.');
    return path.join(folder, name);
  }
  const notesFile = (full) => `${full}.json`;
  const readNotes = (full) => { try { return JSON.parse(fs.readFileSync(notesFile(full), 'utf8')); } catch { return {}; } };

  function list() {
    let names = [];
    try { names = fs.readdirSync(folder).filter((n) => NAME.test(n)); } catch { /* no folder yet */ }
    const shots = [];
    for (const name of names) {
      const full = path.join(folder, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const notes = readNotes(full);
      const by = typeof notes.by === 'string' ? notes.by.slice(0, 40) : BY_PREFIX.find(([re]) => re.test(name))?.[1] ?? 'An agent';
      shots.push({
        name, by, size: st.size,
        title: typeof notes.title === 'string' ? notes.title.slice(0, 200) : null,
        project: typeof notes.project === 'string' ? notes.project.slice(0, 120) : null,
        createdAt: Number.isFinite(notes.createdAt) ? notes.createdAt : Math.round(st.mtimeMs),
        kept: notes.kept === true,
      });
    }
    shots.sort((a, b) => b.createdAt - a.createdAt);
    return { folder, shots: shots.slice(0, MAX_LISTED), total: shots.length };
  }

  /** The image itself, for an <img> on the owner's own page. */
  function read(name) {
    const full = file(name);
    if (!fs.existsSync(full)) throw httpError(404, 'That screenshot is gone.');
    return { bytes: fs.readFileSync(full), type: TYPES[path.extname(full).toLowerCase()] };
  }

  function keep(name, kept = true) {
    const full = file(name);
    if (!fs.existsSync(full)) throw httpError(404, 'That screenshot is gone.');
    const notes = readNotes(full);
    notes.kept = Boolean(kept);
    fs.writeFileSync(notesFile(full), JSON.stringify(notes));
    return { name, kept: notes.kept };
  }

  function remove(name) {
    const full = file(name);
    fs.rmSync(full, { force: true });
    fs.rmSync(notesFile(full), { force: true });
    return { name, deleted: true };
  }

  /** Every screenshot not marked to keep, gone in one go. */
  function clearUnkept() {
    let deleted = 0;
    for (const s of list().shots) {
      if (s.kept) continue;
      remove(s.name);
      deleted++;
    }
    return { deleted };
  }

  const ensureFolder = () => { fs.mkdirSync(folder, { recursive: true }); return folder; };

  return { folder, list, read, keep, remove, clearUnkept, ensureFolder };
}

module.exports = { createShots, SHOT_NAME: NAME };
