// What must not end up in memory or in a code graph that other players can read: credentials, and
// paths that say whose computer something came from. Used on the way in, so there is nothing to
// leak later. A pattern can miss a secret, which is why the screens also say not to store them.

'use strict';

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bwk_[A-Za-z0-9_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/gi,
  /\b([A-Za-z0-9_-]*(?:password|passwd|secret|api[_-]?key|token)[A-Za-z0-9_-]*["']?\s*[:=]\s*)["']?[^\s"',;]{4,}["']?/gi,
];
const HOME_PATHS = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|]+/g,
  /\/(?:home|Users)\/[^/\s"'<>|]+/g,
  /\/root\b(?=\/)/g,
];

/** Files a graph is never built from, and whose names are never shown. */
const SENSITIVE_FILE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;

/** Returns the text made safe, and how many things had to be taken out. */
function scrub(text) {
  let out = String(text ?? '');
  let removed = 0;
  for (const re of SECRETS) {
    out = out.replace(re, (match, keep) => {
      removed++;
      return typeof keep === 'string' && keep && !keep.startsWith('-----') ? `${keep}[removed]` : '[removed]';
    });
  }
  for (const re of HOME_PATHS) out = out.replace(re, () => { removed++; return '~'; });
  return { text: out, removed };
}

const clean = (text) => scrub(text).text;

module.exports = { scrub, clean, SENSITIVE_FILE };
