// A .zip file made in memory, for downloading a project's files in one go. Deflated where that
// helps, stored where it does not. Plain ZIP: no ZIP64, so it stays well under 4 GB, which the
// caller makes sure of.

'use strict';

const zlib = require('zlib');

/** DOS date and time, which is what ZIP records, from a JS time. */
function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {Array<{name: string, data: Buffer, mtime?: number}>} entries  names use forward slashes
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime = Date.now() } of entries) {
    const nameBytes = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = zlib.crc32(data);
    const { time, date } = dosTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The files in a .zip, read from its central directory. Deflated and stored entries are read; any
 * other method, a folder entry or an encrypted one is listed in `skipped` with the reason. It
 * refuses an archive that would unpack past `maxTotal`, holds over `maxEntries` entries, or names
 * a path that climbs out of where it is unpacked.
 *
 * @param {Buffer} buf
 * @returns {{files: Array<{name: string, data: Buffer}>, skipped: Array<{name: string, why: string}>}}
 */
function readZip(buf, { maxEntries = 5000, maxTotal = 100 * 1024 * 1024, maxEntry = 20 * 1024 * 1024 } = {}) {
  // The end record is in the last 64 KB, after any comment.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a .zip file, or it is damaged.');
  const count = buf.readUInt16LE(end + 10);
  if (count > maxEntries) throw new Error(`This .zip holds ${count} entries; at most ${maxEntries} are read.`);
  let at = buf.readUInt32LE(end + 16);
  const files = [];
  const skipped = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('This .zip is damaged: its list of files does not add up.');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // a folder
    if (name.split('/').some((part) => part === '..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) { skipped.push({ name, why: 'its path leaves the archive' }); continue; }
    if (flags & 0x0001) { skipped.push({ name, why: 'encrypted' }); continue; }
    if (method !== 0 && method !== 8) { skipped.push({ name, why: `packed in a way this does not read (method ${method})` }); continue; }
    if (size > maxEntry) { skipped.push({ name, why: `too large (${Math.round(size / 1048576)} MB)` }); continue; }
    if (total + size > maxTotal) throw new Error(`This .zip unpacks to more than ${Math.round(maxTotal / 1048576)} MB.`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`This .zip is damaged at ${name}.`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    let data;
    try {
      // The size it claims is all it may grow to, so a small file cannot unpack into a huge one.
      data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(body);
    } catch { skipped.push({ name, why: 'could not be unpacked' }); continue; }
    if (data.length !== size) { skipped.push({ name, why: 'its size does not match what the archive says' }); continue; }
    total += size;
    files.push({ name, data });
  }
  return { files, skipped };
}

module.exports = { makeZip, readZip };
