// The shared project file store, distinct from Git: release ZIPs, images, designs, reports
// and other binaries, with versions, quotas and resumable transfers.
//
//   POST   …/uploads                { path, size, sha256 }  → done at once if the host
//                                     already holds those bytes (only changed data is sent)
//   PUT    …/uploads/:id/chunks/:n  raw bytes; each chunk is checked against X-Chunk-Sha256
//   GET    …/uploads/:id            which chunks have arrived (resume after a dropped link)
//   POST   …/uploads/:id/finalize   the whole file is hashed; only a match is published,
//                                     atomically, as a new version — then people are told
//
// Content is stored once per hash; a path is a list of versions pointing at hashes.
// Downloads are always attachments with nosniff, so nothing published runs in a browser.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newId, now, json, parse } = require('./db.cjs');
const { httpError } = require('./auth.cjs');

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL, version INTEGER NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, by_type TEXT NOT NULL, by_id TEXT NOT NULL, task_id TEXT, note TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS blobs_path ON blobs(project_id, path, version);
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    chunk_size INTEGER NOT NULL, chunks INTEGER NOT NULL, received TEXT NOT NULL, by_type TEXT NOT NULL, by_id TEXT NOT NULL,
    task_id TEXT, note TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

const CHUNK = 1024 * 1024;
const MAX_FILE = 512 * 1024 * 1024;
const QUOTA = (Number(process.env.CREW_PROJECT_QUOTA_MB) || 2048) * 1024 * 1024;
const UPLOAD_TTL = 24 * 3600_000;

function createFiles(crew) {
  const { db } = crew;
  db.raw.exec(MIGRATION);

  const dirs = (roomId, projectId) => {
    const base = path.join(crew.dataDir, 'rooms', roomId, 'projects', projectId);
    return { store: path.join(base, 'blobs'), tmp: path.join(base, 'uploads') };
  };
  const shaOk = (s) => /^[a-f0-9]{64}$/.test(String(s ?? ''));

  function used(projectId) {
    return db.get('SELECT COALESCE(SUM(size),0) n FROM (SELECT DISTINCT sha256, size FROM blobs WHERE project_id = ?)', projectId).n;
  }

  function begin(project, by, { path: rel, size, sha256, taskId = null, note = null }) {
    const safe = crew.work.safeRel(rel);
    const n = Number(size);
    if (!(n >= 0 && n <= MAX_FILE)) throw httpError(413, `Files are limited to ${MAX_FILE / 1024 / 1024} MB.`);
    if (!shaOk(sha256)) throw httpError(400, 'sha256 must be the file’s hex SHA-256.');
    const { store, tmp } = dirs(project.room_id, project.id);
    // The host already has these bytes: publish a new version without any transfer.
    if (fs.existsSync(path.join(store, sha256))) return { done: true, file: publish(project, by, { path: safe, size: n, sha256, taskId, note }) };
    if (used(project.id) + n > QUOTA) throw httpError(507, `This project’s storage quota (${QUOTA / 1024 / 1024} MB) would be exceeded.`);
    const id = newId('upl');
    const chunks = Math.max(1, Math.ceil(n / CHUNK));
    fs.mkdirSync(path.join(tmp, id), { recursive: true });
    db.run('INSERT INTO uploads (id, room_id, project_id, path, size, sha256, chunk_size, chunks, received, by_type, by_id, task_id, note, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, project.room_id, project.id, safe, n, sha256, CHUNK, chunks, '[]', by.type, by.id, taskId, note, 'open', now(), now() + UPLOAD_TTL);
    return { done: false, uploadId: id, chunkSize: CHUNK, chunks, received: [] };
  }

  function getUpload(project, id, by) {
    const u = db.get('SELECT * FROM uploads WHERE id = ? AND project_id = ?', id, project.id);
    if (!u) throw httpError(404, 'No such upload (it may have expired).');
    if (u.by_type !== by.type || u.by_id !== by.id) throw httpError(403, 'Only whoever started this upload can continue it.');
    return u;
  }

  function status(project, id, by) {
    const u = getUpload(project, id, by);
    return { uploadId: u.id, path: u.path, size: u.size, chunks: u.chunks, chunkSize: u.chunk_size, received: parse(u.received, []), status: u.status };
  }

  function chunk(project, id, by, index, bytes, chunkSha = null) {
    const u = getUpload(project, id, by);
    if (u.status !== 'open') throw httpError(409, 'This upload is already finished.');
    const i = Number(index);
    if (!(Number.isInteger(i) && i >= 0 && i < u.chunks)) throw httpError(400, 'Bad chunk index.');
    const expected = i === u.chunks - 1 ? u.size - i * u.chunk_size : u.chunk_size;
    if (bytes.length !== expected && !(u.size === 0 && bytes.length === 0)) throw httpError(400, `Chunk ${i} must be ${expected} bytes, got ${bytes.length}.`);
    if (chunkSha && crypto.createHash('sha256').update(bytes).digest('hex') !== chunkSha) throw httpError(422, `Chunk ${i} arrived corrupted; send it again.`);
    const { tmp } = dirs(project.room_id, project.id);
    const file = path.join(tmp, u.id, String(i));
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
    const received = new Set(parse(u.received, []));
    received.add(i);
    db.run('UPDATE uploads SET received = ? WHERE id = ?', json([...received].sort((a, b) => a - b)), u.id);
    return { received: received.size, of: u.chunks };
  }

  function finalize(project, id, by) {
    const u = getUpload(project, id, by);
    const received = new Set(parse(u.received, []));
    const missing = [];
    for (let i = 0; i < u.chunks; i++) if (!received.has(i)) missing.push(i);
    if (missing.length) throw httpError(409, `Chunks still missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}.`, { missing });
    const { store, tmp } = dirs(project.room_id, project.id);
    fs.mkdirSync(store, { recursive: true });
    const assembled = path.join(tmp, u.id, 'assembled');
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(assembled, 'w');
    try {
      for (let i = 0; i < u.chunks; i++) {
        const b = fs.readFileSync(path.join(tmp, u.id, String(i)));
        hash.update(b);
        fs.writeSync(fd, b);
      }
    } finally { fs.closeSync(fd); }
    const got = hash.digest('hex');
    if (got !== u.sha256) {
      db.run("UPDATE uploads SET status = 'failed' WHERE id = ?", u.id);
      fs.rmSync(path.join(tmp, u.id), { recursive: true, force: true });
      throw httpError(422, 'The assembled file does not match its SHA-256. Nothing was published; start the upload again.');
    }
    // Atomic: the content appears under its hash in one rename, or not at all.
    const dest = path.join(store, got);
    if (!fs.existsSync(dest)) fs.renameSync(assembled, dest);
    fs.rmSync(path.join(tmp, u.id), { recursive: true, force: true });
    db.run("UPDATE uploads SET status = 'done' WHERE id = ?", u.id);
    return publish(project, by, { path: u.path, size: u.size, sha256: got, taskId: u.task_id, note: u.note });
  }

  function publish(project, by, { path: rel, size, sha256, taskId, note }) {
    const version = (db.get('SELECT MAX(version) v FROM blobs WHERE project_id = ? AND path = ?', project.id, rel)?.v ?? 0) + 1;
    const id = newId('blb');
    db.run('INSERT INTO blobs (id, room_id, project_id, path, version, size, sha256, by_type, by_id, task_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, project.room_id, project.id, rel, version, size, sha256, by.type, by.id, taskId ?? null, note ? String(note).slice(0, 500) : null, now());
    const f = shape(db.get('SELECT * FROM blobs WHERE id = ?', id));
    crew.hub.broadcast(project.room_id, 'file', f);
    crew.audit(project.room_id, by.id, 'file.publish', { projectId: project.id, path: rel, version, sha256 });
    return f;
  }

  function shape(b) {
    const by = b.by_type === 'agent' ? crew.agents.get(b.by_id)?.name : crew.auth.getUser(b.by_id)?.displayName;
    return { id: b.id, projectId: b.project_id, path: b.path, version: b.version, size: b.size, sha256: b.sha256, byType: b.by_type, byName: by ?? '?', taskId: b.task_id, note: b.note, createdAt: b.created_at };
  }

  function list(project) {
    const rows = db.all('SELECT * FROM blobs WHERE project_id = ? ORDER BY path, version DESC', project.id).map(shape);
    const byPath = new Map();
    for (const r of rows) { if (!byPath.has(r.path)) byPath.set(r.path, { ...r, history: [] }); byPath.get(r.path).history.push(r); }
    return { files: [...byPath.values()], usedBytes: used(project.id), quotaBytes: QUOTA };
  }

  function download(project, blobId, res) {
    const b = db.get('SELECT * FROM blobs WHERE id = ? AND project_id = ?', blobId, project.id);
    if (!b) throw httpError(404, 'No such file version.');
    const file = path.join(dirs(project.room_id, project.id).store, b.sha256);
    const name = path.basename(b.path).replace(/[^\w.-]+/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': b.size, 'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'X-Crew-Sha256': b.sha256, 'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }

  function sweep() {
    for (const u of db.all("SELECT * FROM uploads WHERE status = 'open' AND expires_at < ?", now())) {
      fs.rmSync(path.join(dirs(u.room_id, u.project_id).tmp, u.id), { recursive: true, force: true });
      db.run("UPDATE uploads SET status = 'expired' WHERE id = ?", u.id);
    }
  }

  /** The newest version of each uploaded file, with where its bytes are, for a download of them all. */
  function latest(project) {
    return list(project).files.map((f) => ({ path: f.path, size: f.size, createdAt: f.createdAt, file: path.join(dirs(project.room_id, project.id).store, f.sha256) }));
  }

  return { begin, status, chunk, finalize, list, latest, download, sweep, CHUNK };
}

module.exports = { createFiles };
