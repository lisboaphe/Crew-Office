// The worker's credential vault: provider API keys, on the owner's machine only.
//
// Keys are encrypted at rest (AES-256-GCM) with a random key file beside them, readable
// only by the user who created it. Environment variables win over the vault, so a
// deployment can inject keys without writing them anywhere. Nothing in this module ever
// sends a key anywhere but to its provider; the room host never sees one.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = {
  anthropic: { apiKey: 'ANTHROPIC_API_KEY' },
  openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  local: { apiKey: 'LOCAL_LLM_API_KEY', baseUrl: 'LOCAL_LLM_BASE_URL' },
};

function createVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'vault.key');
  const dataFile = path.join(dir, 'vault.json');

  function key() {
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }

  function load() {
    if (!fs.existsSync(dataFile)) return {};
    const { iv, tag, data } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8'));
  }

  function save(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    fs.writeFileSync(dataFile, JSON.stringify({ iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600 });
  }

  function set(provider, field, value) {
    if (!ENV[provider] || !ENV[provider][field]) throw new Error(`Unknown credential ${provider}.${field}`);
    const all = load();
    all[provider] = { ...(all[provider] ?? {}), [field]: value || undefined };
    save(all);
  }

  /** A structured secret that is not an API key, such as a sign-in's tokens. */
  const SECRET_PREFIX = 'secret:';
  function setSecret(name, value) {
    const all = load();
    all[SECRET_PREFIX + name] = value;
    save(all);
  }
  const getSecret = (name) => load()[SECRET_PREFIX + name] ?? null;

  function get(provider) {
    const stored = load()[provider] ?? {};
    const env = ENV[provider] ?? {};
    const out = {};
    for (const [field, name] of Object.entries(env)) out[field] = process.env[name] || stored[field] || undefined;
    return out;
  }

  /** What the local settings page shows: whether each is set, never the value. */
  function status() {
    return Object.fromEntries(Object.keys(ENV).map((p) => {
      const c = get(p);
      return [p, { apiKey: Boolean(c.apiKey), baseUrl: c.baseUrl ?? null, fromEnv: Boolean(process.env[ENV[p].apiKey]) }];
    }));
  }

  return { get, set, status, setSecret, getSecret };
}

module.exports = { createVault };
