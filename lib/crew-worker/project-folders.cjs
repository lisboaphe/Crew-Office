// Where a project's files live on this computer: one folder per project, inside one folder for
// them all, made the first time a project needs it. Agents' clones and manual hand-offs for a
// project all go in its folder, so an old project is cleared away by deleting that one folder.
//
// The office keeps its own copy of everything that matters, the board, the chat, the shared files
// and the repository, so deleting a folder here loses only work not yet handed back.
//
//   Crew Office Projects/
//     <office name>/
//       <project name>/
//         .crew-project.json      which project this is, so a rename finds the same folder
//         agents/<agent name>/<task>/<repository>
//         handoffs/<task>/HANDOFF.md, RESULT.md

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '.crew-project.json';

/**
 * The folder holding every project, for the worker itself: in the home folder, outside OneDrive
 * and the like, as clones churn files. A worker given a data folder of its own keeps its projects
 * in that instead, so a second worker never writes into somebody's real projects.
 *
 * Anything else that makes the worker's tools, a test or the demo, gets `insideDataDir`, so only
 * the worker that somebody runs ever writes to their home folder.
 */
function projectsRoot(dataDir) {
  if (process.env.CREW_PROJECTS_DIR) return process.env.CREW_PROJECTS_DIR;
  if (process.env.CREW_WORKER_DIR) return insideDataDir(dataDir);
  return path.join(os.homedir(), 'Crew Office Projects');
}
const insideDataDir = (dataDir) => path.join(dataDir, 'Projects');

/** A name Windows, macOS and Linux all accept as one folder. */
function folderName(text, fallback = 'Untitled') {
  const clean = String(text ?? '')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return fallback;
  return clean;
}

const readMarker = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
};

const README = `Crew Office keeps each project's files here, in a folder per office and project.

Each project folder holds what your agents worked on for it on this computer: their copies of its
repository, and any tasks handed to you to run in Claude Code.

To clear away an old project, delete its folder. The office keeps the project's board, chat,
shared files and repository, so only work that was never handed back is lost.
`;

/**
 * The folder for a task's project, made if it is not there yet, or null for work outside a project.
 *
 * @param {{room?: {name?: string}, project?: {id: string, name: string}}} ctx
 */
function projectFolder(ctx, root) {
  if (!ctx?.project?.id) return null;
  const office = path.join(root, folderName(ctx.room?.name, 'Office'));
  const id = String(ctx.project.id);

  // A project keeps its folder when it is renamed: look for the one that says it is this project.
  if (fs.existsSync(office)) {
    for (const entry of fs.readdirSync(office, { withFileTypes: true })) {
      if (entry.isDirectory() && readMarker(path.join(office, entry.name))?.id === id) return path.join(office, entry.name);
    }
  }

  const name = folderName(ctx.project.name, 'Project');
  for (const candidate of [name, `${name} (${id.slice(-6)})`]) {
    const dir = path.join(office, candidate);
    const marker = readMarker(dir);
    if (marker && marker.id !== id) continue; // another project of the same name
    if (!marker && fs.existsSync(dir) && fs.readdirSync(dir).length) continue; // somebody's own folder
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify({ id, name: ctx.project.name, office: ctx.room?.name ?? null, createdAt: Date.now() }, null, 2)}\n`);
    const readme = path.join(root, 'README.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
    return dir;
  }
  throw new Error(`No folder could be made for the project “${ctx.project.name}” in ${office}.`);
}

/** A task's own folder name: its title, readable, and the end of its id, so two never meet. */
const taskFolderName = (title, id) => `${folderName(title, 'Task').slice(0, 40)} (${String(id).replace(/[^\w-]/g, '').slice(-6)})`;

module.exports = { projectsRoot, insideDataDir, projectFolder, folderName, taskFolderName, MARKER };
