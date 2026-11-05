// What an invitation looks like, and what is allowed to count as one.
//
// Invitations arrive from outside: pasted from a chat, or handed to the app by the operating
// system through crewoffice://. So nothing here trusts its input. It says what the text means, or
// null, and the only things that survive are an http(s) origin, an invitation token and a code.
//
//   crewoffice://join?host=https%3A%2F%2Fabc.relay.example.org&invite=<token>
//   crewoffice://join/ABCDE-FGHIJ
//   https://abc.relay.example.org/crew/join?invite=<token>
//   ABCDE-FGHIJ
//
// A code is a credential with a short life, not a label: it is drawn from a CSPRNG, is 50 bits,
// and the relay and the host each rate-limit guesses. It is separate from the room's keycard,
// which is an address and is not secret.

'use strict';

const crypto = require('crypto');

const SCHEME = 'crewoffice';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

function mintShortCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

/** Forgiving about what people do when retyping a code: case, spaces, and O for 0. */
function normalizeCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** What the relay stores. It can route a code it is given, and cannot list the codes it holds. */
const codeHash = (code) => crypto.createHash('sha256').update(`crew-room-code:${code}`).digest('hex');

/**
 * What a host announces on its own network. Deliberately slow, because everyone on that network
 * hears it and 50 bits is not enough against a fast hash on a graphics card.
 */
const lanCodeHash = (code) => crypto.scryptSync(code, 'crew-office-lan-code', 16, { N: 16384, r: 8, p: 1 }).toString('hex');

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
}

const isLoopback = (hostname) => ['localhost', '[::1]'].includes(hostname.toLowerCase()) || /^127\./.test(hostname);

/** The origin to go to. Plain http only for addresses that stay on a private network. */
function safeOrigin(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname) return null;
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) return null;
  return u.origin;
}

function parseInvitation(text) {
  const raw = String(text ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f"<>\\^`{|}]/.test(raw)) return null;
  const bare = normalizeCode(raw);
  if (bare) return { kind: 'code', code: bare };

  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === `${SCHEME}:`) {
    if (u.hostname !== 'join' || u.username || u.password) return null;
    const fromPath = normalizeCode(u.pathname.replace(/^\/+/, ''));
    const code = fromPath ?? normalizeCode(u.searchParams.get('code'));
    if (code) return { kind: 'code', code };
    const origin = safeOrigin(u.searchParams.get('host'));
    const invite = u.searchParams.get('invite');
    return origin && TOKEN.test(invite ?? '') ? { kind: 'invite', origin, invite } : null;
  }
  const origin = safeOrigin(u.href);
  if (!origin) return null;
  const invite = u.searchParams.get('invite');
  if (TOKEN.test(invite ?? '')) return { kind: 'invite', origin, invite };
  const code = normalizeCode(u.searchParams.get('code'));
  return code ? { kind: 'code', code, origin } : null;
}

/** The address a parsed invitation opens at. Always a Crew Office join page. */
function joinUrl(parsed) {
  const q = parsed.kind === 'invite' ? `invite=${encodeURIComponent(parsed.invite)}` : `code=${formatCode(parsed.code)}`;
  return `${parsed.origin ?? ''}/crew/join?${q}`;
}

const appLink = (origin, invite) => `${SCHEME}://join?host=${encodeURIComponent(origin)}&invite=${encodeURIComponent(invite)}`;

module.exports = { SCHEME, mintShortCode, normalizeCode, formatCode, codeHash, lanCodeHash, safeOrigin, isLoopback, parseInvitation, joinUrl, appLink, TOKEN };
