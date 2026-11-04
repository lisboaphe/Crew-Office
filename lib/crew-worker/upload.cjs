// A resumable, verified upload to the room's shared file store. If the host already holds
// the bytes nothing is sent. Each chunk carries its own hash and is retried with backoff; a
// dropped connection resumes from the chunks the host says it has.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

async function uploadFile({ host, jobId, source, target, note = null, attempts = 5, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const size = fs.statSync(source).size;
  const sha256 = await hashFile(source);
  const begun = await host.post('/api/crew/worker/uploads', { jobId, path: target, size, sha256, note });
  if (begun.done) return begun.file;
  const fd = fs.openSync(source, 'r');
  try {
    for (let i = 0; i < begun.chunks; i++) {
      const length = i === begun.chunks - 1 ? size - i * begun.chunkSize : begun.chunkSize;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, i * begun.chunkSize);
      const chunkSha = crypto.createHash('sha256').update(buf).digest('hex');
      for (let tryNo = 1; ; tryNo++) {
        try {
          await host.putRaw(`/api/crew/worker/uploads/${begun.uploadId}/chunks/${i}?jobId=${encodeURIComponent(jobId)}`, buf, { 'X-Chunk-Sha256': chunkSha });
          break;
        } catch (err) {
          if (tryNo >= attempts || (err.status && err.status < 500 && err.status !== 422)) throw err;
          await wait(Math.min(30_000, 500 * 2 ** tryNo));
        }
      }
    }
  } finally { fs.closeSync(fd); }
  return (await host.post(`/api/crew/worker/uploads/${begun.uploadId}/finalize`, { jobId })).file;
}

module.exports = { uploadFile, hashFile };
