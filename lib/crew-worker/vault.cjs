// The worker's credential vault: provider API keys, on the owner's machine only.
//
// Keys are encrypted at rest (AES-256-GCM). The key to that is held by the operating system's
// own store (os-secret.cjs), or where there is none, a file readable only by the user who
// created it, and status() says which. Environment variables win over the vault, so a
// deployment can inject keys without writing them anywhere. Nothing in this module ever
// sends a key anywhere but to its provider; the room host never sees one.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createOsSecret } = require('./os-secret.cjs');

const ENV = {
  anthropic: { apiKey: 'ANTHROPIC_API_KEY' },
  openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  local: { apiKey: 'LOCAL_LLM_API_KEY', baseUrl: 'LOCAL_LLM_BASE_URL' },
  'openrouter-free': { apiKey: 'OPENROUTER_API_KEY' },
  cloudflare: { apiKey: 'CLOUDFLARE_API_TOKEN', accountId: 'CLOUDFLARE_ACCOUNT_ID' },
  gemini: { apiKey: 'GEMINI_API_KEY' },
  mistral: { apiKey: 'MISTRAL_API_KEY' },
  zai: { apiKey: 'ZAI_API_KEY' },
  nvidia: { apiKey: 'NVIDIA_API_KEY' },
  'ollama-cloud': { apiKey: 'OLLAMA_API_KEY' },
  kiro: { apiKey: 'KIRO_API_KEY' },
};

function createVault(dir, osOptions = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'vault.key');
  const dataFile = path.join(dir, 'vault.json');

  const osSecret = createOsSecret(dir, osOptions);
  let cachedKey = null;
  let keyStore = 'file';

  /**
   * The key comes from the operating system if it holds one. An older key file moves there, and is
   * only removed once the store has given the same key back. A store that holds a key it can no
   * longer open is an error, never a reason to make a new key: that would orphan every saved secret.
   */
  function key() {
    if (cachedKey) return cachedKey;
    if (osSecret.exists()) {
      let held;
      try { held = osSecret.read(); } catch { held = null; }
      if (!held?.length) throw new Error(`Could not open the saved keys with ${osSecret.name}. They can only be opened by the same user on the same computer. Add your keys again after removing ${dataFile}.`);
      keyStore = osSecret.name;
      cachedKey = held;
      return cachedKey;
    }
    const fromFile = fs.existsSync(keyFile) ? Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex') : null;
    const fresh = fromFile ?? crypto.randomBytes(32);
    if (osSecret.write(fresh)) {
      keyStore = osSecret.name;
      fs.rmSync(keyFile, { force: true });
    } else if (!fromFile) fs.writeFileSync(keyFile, fresh.toString('hex'), { mode: 0o600 });
    cachedKey = fresh;
    return cachedKey;
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

  /** Forget everything saved for one connection. A key from the environment is not ours to forget. */
  function remove(provider) {
    const all = load();
    delete all[provider];
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

  /** Where the key to this vault is held. Opening it is what establishes the answer. */
  const storage = () => { try { key(); } catch { /* reported when used */ } return keyStore; };

  return { get, set, remove, status, storage, setSecret, getSecret };
}

module.exports = { createVault };
