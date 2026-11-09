// Keeping the screenshots an agent takes, for its owner to look at in Crew Office.
//
// A hook that fires after a tool call carries what the tool returned, and a screenshot tool
// returns the picture itself. This finds it there and writes it into the folder Crew Office shows
// (lib/crew/shots.cjs), with a note of who took it. Nothing here touches the network: the image goes
// from the hook's stdin to a file on this computer and no further, and it is never put in an event.
//
// Only screenshots. An agent that opens an image file also gets a picture back, and that one is not
// something it saw happen, so the tool has to say it took a screenshot — by its name, or by the
// `action` a computer-use tool is given.
//
// Off with ROVING_OFFICE_SCREENSHOTS=0, or "screenshots": "off" in ~/.roving-office/settings.json.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 6;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const SCREENSHOT_TOOL = /screenshot|screen_?shot|take_snapshot|capture_?screen/i;
const SCREENSHOT_ACTIONS = new Set(['screenshot', 'zoom']);
const BY = { 'claude-code': 'Claude', 'codex-cli': 'Codex', cursor: 'Cursor', 'rovo-cli': 'Rovo' };

/** Whether this tool call was a screenshot being taken. */
function isScreenshotCall(toolName, input) {
  if (SCREENSHOT_TOOL.test(String(toolName ?? ''))) return true;
  const action = input && typeof input === 'object' ? input.action : null;
  return typeof action === 'string' && SCREENSHOT_ACTIONS.has(action) && /computer|browser/i.test(String(toolName ?? ''));
}

/** What the bytes actually are, whatever the payload claims. */
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

/**
 * The pictures in a tool's result. Both shapes are taken: a Claude content block
 * ({ type: 'image', source: { data, media_type } }) and an MCP one ({ type: 'image', data, mimeType }).
 */
function findImages(value, depth = 0, out = []) {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || out.length >= 4) return out;
  if (Array.isArray(value)) { for (const v of value) findImages(v, depth + 1, out); return out; }
  if (value.type === 'image') {
    const data = typeof value.source?.data === 'string' ? value.source.data : typeof value.data === 'string' ? value.data : null;
    if (data && data.length < MAX_BYTES * 1.4) {
      const buf = Buffer.from(data, 'base64');
      const type = sniff(buf);
      if (type && buf.length <= MAX_BYTES) out.push({ buf, type });
    }
    return out;
  }
  for (const v of Object.values(value)) if (v && typeof v === 'object') findImages(v, depth + 1, out);
  return out;
}

function enabled(settings, env) {
  const flag = String(env.ROVING_OFFICE_SCREENSHOTS ?? '').toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(flag)) return false;
  return !['off', false].includes(settings?.screenshots);
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Write any screenshot in this hook payload into `folder`. Returns the file names written.
 * Never throws: a screenshot that cannot be kept is not worth an agent's hook failing over.
 */
function captureScreenshots({ harness, event, payload, folder, settings = {}, env = process.env, now = new Date() }) {
  try {
    if (!/^PostToolUse$|^post_?tool_?use$|^afterMCPExecution$/i.test(String(event ?? ''))) return [];
    if (!enabled(settings, env) || !payload || typeof payload !== 'object') return [];
    const toolName = payload.tool_name ?? payload.toolName;
    if (!isScreenshotCall(toolName, payload.tool_input ?? payload.toolInput)) return [];
    const images = findImages(payload.tool_response ?? payload.tool_result ?? payload.result);
    if (!images.length) return [];
    fs.mkdirSync(folder, { recursive: true });
    const by = BY[harness] ?? 'An agent';
    const prefix = String(harness ?? 'agent').split('-')[0].replace(/[^a-z0-9]/gi, '').toLowerCase() || 'agent';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    const written = [];
    for (const { buf, type } of images) {
      const name = `${prefix}-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.${EXT[type]}`;
      const full = path.join(folder, name);
      fs.writeFileSync(full, buf, { mode: 0o600 });
      fs.writeFileSync(`${full}.json`, JSON.stringify({
        by, createdAt: now.getTime(),
        title: describe(toolName),
        project: cwd ? path.basename(cwd).slice(0, 120) : null,
      }), { mode: 0o600 });
      written.push(name);
    }
    return written;
  } catch {
    return [];
  }
}

/** A few plain words for the tool, rather than its identifier. */
function describe(toolName) {
  const t = String(toolName ?? '');
  if (/browser|chrome|playwright|puppeteer/i.test(t)) return 'Browser screenshot';
  if (/computer/i.test(t)) return 'Screen screenshot';
  return 'Screenshot';
}

module.exports = { captureScreenshots, isScreenshotCall, findImages, sniff };
