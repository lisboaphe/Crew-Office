// The AI services a person can connect on their own computer, and the rule that decides what each
// one may run. Keys and account facts stay here, on the owner's worker. The room host only ever
// hears a connection's state and one line of reason.
//
// Whether a request costs money is decided per model, never per provider, because most of these
// services sell paid and free models through the same key. A service that cannot tell an app
// whether billing is on starts as "unknown", which runs nothing until its owner has looked at
// their own account and said so. docs/developer/ai-providers.md lists what each service documents.
//
// Capabilities are only ever what the service reported. A null means not reported, and the screen
// says so, rather than a guess.

'use strict';

const fs = require('fs');
const path = require('path');

const USAGE_CLASSES = {
  free: 'Free tier',
  promo: 'Free promotional access',
  subscription: 'Included in your subscription',
  trial: 'Trial credits',
  paid: 'Paid API',
  local: 'Local',
  unknown: 'Verification required',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const yesNo = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/** Z.ai's pricing page lists exactly these text models as free. Everything else bills the account. */
const ZAI_FREE = new Set(['glm-4.7-flash', 'glm-4.5-flash']);
const isOpenRouterFree = (m) => m === 'openrouter/free' || String(m).endsWith(':free');

const DEFS = {
  cloudflare: {
    name: 'Cloudflare Workers AI', group: 'free', kind: 'api', method: 'Your Cloudflare API token and account ID',
    fields: [{ name: 'apiKey', label: 'API token', secret: true }, { name: 'accountId', label: 'Account ID' }],
    setupUrl: 'https://dash.cloudflare.com',
    steps: ['Open the Cloudflare dashboard and sign in.', 'Copy your Account ID from the Workers AI page.', 'Create an API token with the Workers AI Read and Edit permissions.', 'Paste both here.'],
    base: (c) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.accountId ?? '')}/ai/v1`,
    accountClass: 'unknown',
    verify: { free: 'My Cloudflare account is on the Workers Free plan. Cloudflare says it fails with an error past the daily limit rather than charging.' },
    verifyHint: 'On Workers Free the daily allowance stops with an error. On Workers Paid, use past it is billed. Cloudflare does not tell apps which plan an account is on.',
    usage: 'Cloudflare does not report the remaining daily allowance to this app. See your dashboard.',
    troubleshoot: ['The token needs Workers AI permissions on this account.', 'The daily allowance resets at 00:00 UTC.'],
    list: async (c, get) => {
      const data = await get(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.accountId ?? '')}/ai/models/search?task=${encodeURIComponent('Text Generation')}&per_page=100`);
      return (data.result ?? []).map((m) => {
        const prop = (id) => (m.properties ?? []).find((p) => p.property_id === id)?.value;
        return { id: m.name, name: m.name, context: num(prop('context_window')), tools: yesNo(prop('function_calling')), reasoning: yesNo(prop('reasoning')) };
      });
    },
  },
  gemini: {
    name: 'Google Gemini', group: 'free', kind: 'api', method: 'Your AI Studio API key',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://aistudio.google.com/apikey',
    steps: ['Open Google AI Studio and sign in.', 'Create an API key, in a project with no billing account linked if you want free use only.', 'Paste it here.'],
    base: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
    streaming: true,
    accountClass: 'unknown',
    verify: { free: 'This key’s project has no billing account linked. AI Studio shows its Billing Tier as Free.' },
    verifyHint: 'A key takes its tier from its project. Google does not tell apps which tier that is, and a project with billing linked is charged per token.',
    notice: 'Without billing linked, Google’s protection against using your prompts to improve its products does not apply. Do not send private code on the free tier.',
    usage: 'Google shows limits per project in AI Studio, and does not report them to this app.',
    troubleshoot: ['A model that fails with limit 0 is not on your free tier: pick another.', 'If you ever link billing to this project, remove this confirmation.'],
    list: async (c, get) => {
      const data = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': c.apiKey });
      return (data.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => {
        const id = String(m.name).replace(/^models\//, '');
        return { id, name: m.displayName ?? id, context: num(m.inputTokenLimit), tools: null, reasoning: yesNo(m.thinking) };
      });
    },
  },
  mistral: {
    name: 'Mistral AI', group: 'free', kind: 'api', method: 'Your Mistral API key',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://console.mistral.ai',
    steps: ['Open the Mistral console and sign in.', 'Choose the free Experiment plan if you do not want billing.', 'Create an API key and paste it here.'],
    base: () => 'https://api.mistral.ai/v1',
    accountClass: 'unknown',
    verify: { free: 'My Mistral workspace is on the free Experiment plan, with no paid plan or payment method active.' },
    verifyHint: 'The same key works on free and paid plans, and Mistral does not tell apps which plan a workspace is on.',
    notice: 'Check Mistral’s terms for how free plan requests may be used before sending private code.',
    usage: 'Mistral shows limits in its console, per workspace.',
    troubleshoot: ['Free plan limits are low: a limit pauses the work rather than charging.', 'The Experiment plan may ask you to verify a phone number.'],
    list: async (c, get) => {
      const data = await get('https://api.mistral.ai/v1/models', { Authorization: `Bearer ${c.apiKey}` });
      const rows = Array.isArray(data) ? data : data.data ?? [];
      return rows.filter((m) => m.capabilities?.completion_chat !== false && !m.archived).map((m) => ({ id: m.id, name: m.name ?? m.id, context: num(m.max_context_length), tools: yesNo(m.capabilities?.function_calling), reasoning: null }));
    },
  },
  'openrouter-free': {
    name: 'OpenRouter free models', group: 'free', kind: 'api', method: 'Your OpenRouter key. Only free models can run',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://openrouter.ai/keys',
    steps: ['Open OpenRouter and sign in.', 'Create a key, and set its credit limit to 0 if you like.', 'Paste it here.'],
    modelClass: (id, known) => (isOpenRouterFree(id) && known?.usage !== 'paid' ? 'free' : 'paid'),
    notice: 'Free models can log what they are sent, so do not use them for private code. This connection refuses anything that is not free.',
    usage: 'OpenRouter reports free requests used today once an agent has run.',
    troubleshoot: ['If a free model will not use tools, the agent falls back to asking in plain text. A model marked as using tools does better.', 'A limit here pauses the work, or moves it to a backup you chose.'],
    list: async (c, get) => {
      const data = await get(`${process.env.CREW_OPENROUTER_BASE || 'https://openrouter.ai/api/v1'}/models`);
      const zero = (p) => p !== undefined && Number(p) === 0;
      return (data.data ?? []).filter((m) => zero(m.pricing?.prompt) && zero(m.pricing?.completion) && (m.pricing?.request === undefined || zero(m.pricing.request))).map((m) => ({
        id: m.id, name: m.name ?? m.id, context: num(m.context_length),
        tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null,
        reasoning: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('reasoning') : null,
        rateLimit: 'Free models: 20 a minute, and 50 a day until you have bought 10 credits',
      }));
    },
  },
  nvidia: {
    name: 'NVIDIA NIM', group: 'free', kind: 'api', method: 'Your build.nvidia.com API key',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://build.nvidia.com',
    steps: ['Open build.nvidia.com and sign in with your NVIDIA developer account.', 'Open a model and create an API key.', 'Paste it here.'],
    base: () => 'https://integrate.api.nvidia.com/v1',
    accountClass: 'trial',
    verify: { trial: 'I understand this uses NVIDIA’s developer trial access, which is for development and is limited.' },
    verifyHint: 'NVIDIA’s hosted endpoints are developer trial access with a limited allowance. Use it only after agreeing to that.',
    usage: 'NVIDIA does not report the remaining allowance to this app. See build.nvidia.com.',
    troubleshoot: ['Trial access is rate limited. A limit pauses the work.', 'Not every model listed accepts every key.'],
    list: async (c, get) => {
      const data = await get('https://integrate.api.nvidia.com/v1/models', c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {});
      return (data.data ?? []).map((m) => ({ id: m.id, name: m.id, context: null, tools: null, reasoning: null }));
    },
  },
  zai: {
    name: 'Z.ai', group: 'cloud', kind: 'api', method: 'Your Z.ai API key',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://z.ai/manage-apikey/apikey-list',
    steps: ['Open Z.ai and sign in.', 'Create an API key on the API keys page.', 'Paste it here.'],
    base: () => 'https://api.z.ai/api/paas/v4',
    modelClass: (id) => (ZAI_FREE.has(String(id).toLowerCase()) ? 'free' : 'paid'),
    usage: 'Z.ai shows quotas in its dashboard, and does not report them to this app.',
    troubleshoot: ['Only the Flash models listed as free can run while paid use is off.', 'A Coding Plan key uses a different address, which this connection does not use yet.'],
    pinned: [...ZAI_FREE].map((id) => ({ id, name: id, context: null, tools: null, reasoning: null })),
    list: async (c, get) => {
      const data = await get('https://api.z.ai/api/paas/v4/models', { Authorization: `Bearer ${c.apiKey}` });
      return (data.data ?? []).map((m) => ({ id: m.id, name: m.id, context: null, tools: null, reasoning: null }));
    },
  },
  'ollama-cloud': {
    name: 'Ollama Cloud', group: 'cloud', kind: 'api', method: 'Your ollama.com API key',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    setupUrl: 'https://ollama.com/settings/keys',
    steps: ['Open ollama.com and sign in.', 'Create a key under Settings → Keys.', 'Paste it here.'],
    base: () => 'https://ollama.com/v1',
    accountClass: 'unknown',
    verify: { subscription: 'I am on an Ollama plan with included cloud usage, and hold no purchased usage credit it could draw on.' },
    verifyHint: 'Ollama’s $0 plan is pay per token for cloud models, and any plan draws on purchased credit after its included usage. Ollama does not tell apps which applies.',
    usage: 'Ollama shows usage at ollama.com/settings/usage, and does not report it to this app.',
    troubleshoot: ['Models on your own computer are under Local AI, and never cost anything.', 'Requests over your plan’s concurrency queue, then get refused.'],
    list: async (c, get) => {
      const data = await get('https://ollama.com/api/tags', c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {});
      return (data.models ?? []).map((m) => ({ id: m.name, name: m.name, context: null, tools: null, reasoning: null }));
    },
  },
  opencode: {
    name: 'OpenCode', group: 'free', kind: 'cli', method: 'The official OpenCode app. Only its free models can run',
    fields: [],
    cli: 'opencode',
    setupUrl: 'https://opencode.ai',
    steps: ['Press Install, or install OpenCode from its site.', 'No account is needed for its free models.'],
    modelClass: (id, known) => known?.usage ?? 'unknown',
    notice: 'Free models are free for a limited time, and several may keep or learn from what they are sent. Do not send private code.',
    usage: 'OpenCode reports what each run cost, and this connection stops if that is ever more than nothing.',
    troubleshoot: ['If it was just installed, restart your worker so it can find the command.', 'The list of free models changes: refresh it if one stops working.'],
  },
  kiro: {
    name: 'Kiro', group: 'subscription', kind: 'cli', method: 'The official Kiro CLI, signed in with your own account',
    fields: [{ name: 'apiKey', label: 'API key (optional, paid Kiro plans only)', secret: true, optional: true }],
    cli: 'kiro',
    setupUrl: 'https://kiro.dev',
    steps: ['Install the Kiro CLI from its site.', 'Press Sign in, and finish in Kiro’s own page.', 'Kiro’s documentation describes API keys, from paid plans, for running without a person. A sign-in alone may not be enough: Run a real test to find out.'],
    modelClass: () => 'subscription',
    usage: 'Kiro counts credits on your account, and does not report them to this app. See kiro.dev.',
    notice: 'Every request spends your Kiro credits. This app never buys add-on credits, but check your plan does not have them turned on automatically.',
    troubleshoot: ['Run kiro-cli whoami to see which sign-in is active.', 'API keys are made at app.kiro.dev, on Pro plans and above.'],
  },
};

const baseOverride = (id) => process.env[`CREW_AI_BASE_${id.replace(/-/g, '_').toUpperCase()}`] || null;

function createConnections(dataDir, { vault = null, now = () => Date.now(), cliModels = null } = {}) {
  const file = dataDir ? path.join(dataDir, 'ai-connections.json') : null;
  let state = { verified: {}, chosen: {}, models: {}, paidAllowed: {}, noTools: {} };
  try { if (file) state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => {
    if (!file) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  };

  const def = (provider) => DEFS[provider] ?? null;
  const known = (provider, model) => state.models[provider]?.list?.find((m) => m.id === model) ?? null;

  /** What using this model on this account would be, as far as anyone has been able to establish. */
  function classOf(provider, model) {
    const d = def(provider);
    if (!d) return null;
    if (d.modelClass) return d.modelClass(model, known(provider, model));
    return state.verified[provider]?.class ?? d.accountClass ?? 'unknown';
  }

  /** Why this provider cannot run anything at all right now, before any model is considered. */
  function providerBlock(provider) {
    const d = def(provider);
    if (!d || d.modelClass) return null;
    const c = classOf(provider);
    if (c === 'unknown') return `${d.name}: verification required. ${d.verifyHint}`;
    if (c === 'trial' && !state.verified[provider]) return `${d.name}: ${d.verifyHint}`;
    return null;
  }

  /** The one rule. Null means this request may go. Anything else is why it may not. */
  function block(provider, model, { neverPaid = true } = {}) {
    const d = def(provider);
    if (!d) return null;
    const first = providerBlock(provider);
    if (first) return first;
    const c = classOf(provider, model);
    if (c === 'unknown') return `${d.name} has not said what ${model} costs, so it will not run. Refresh its models.`;
    if (c === 'paid') {
      if (neverPaid) return `${model} on ${d.name} is a paid model, and paid API use is off on this computer. Nothing was sent.`;
      if (!state.paidAllowed[provider]) return `${model} on ${d.name} is a paid model, and you have not allowed paid models on this connection. Nothing was sent.`;
    }
    return null;
  }

  const allowed = (provider, opts) => (state.models[provider]?.list ?? []).filter((m) => !block(provider, m.id, opts));

  /** A placeholder means the owner's choice. Nothing here picks a model silently on their behalf. */
  function resolveModel(provider, model) {
    const asked = String(model ?? '');
    if (asked && asked !== 'default') return asked;
    return state.chosen[provider] ?? null;
  }

  async function fetchJson(url, headers = {}) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 401 || res.status === 403 ? 'The service refused this key.' : `The service answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Ask the service what exists. Each row carries its billing class and nothing made up. */
  async function discover(provider) {
    const d = def(provider);
    if (!d) throw new Error('Unknown AI connection.');
    const creds = vault?.get(provider) ?? {};
    let rows;
    let source = 'Reported by the service';
    if (d.cli && cliModels) rows = await cliModels(provider);
    else if (d.list) {
      try { rows = await d.list(creds, fetchJson); }
      catch (err) {
        if (!d.pinned) throw err;
        rows = d.pinned;
        source = `Could not list models (${err.message}). Showing the free models from the service’s pricing page.`;
      }
    } else rows = [];
    const stamp = (m) => ({ provider, streaming: d.streaming ?? null, rateLimit: null, ...m });
    const list = rows.map(stamp).map((m) => ({ ...m, usage: m.usage ?? (d.modelClass ? d.modelClass(m.id, m) : null) }));
    state.models[provider] = { at: now(), source, list };
    save();
    return models(provider);
  }

  /** The list a screen shows: facts as reported, and whether each may run right now. */
  function models(provider, opts = {}) {
    const entry = state.models[provider];
    const rows = (entry?.list ?? []).map((m) => {
      const usage = classOf(provider, m.id);
      const tools = state.noTools[`${provider}:${m.id}`] ? false : m.tools;
      return {
        ...m, tools, usage, usageLabel: USAGE_CLASSES[usage],
        coding: tools === true ? 'Can use the office’s tools directly' : tools === false ? 'No direct tool use: works through plain text instead' : 'Not reported',
        blocked: block(provider, m.id, opts),
      };
    });
    rows.sort((a, b) => Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) || Number(b.tools === true) - Number(a.tools === true) || String(a.id).localeCompare(String(b.id)));
    return { provider, at: entry?.at ?? null, source: entry?.source ?? null, chosen: state.chosen[provider] ?? null, models: rows };
  }

  function choose(provider, model, opts) {
    if (!def(provider)) throw new Error('Unknown AI connection.');
    const reason = block(provider, model, opts);
    if (reason) throw new Error(reason);
    state.chosen[provider] = String(model);
    save();
  }

  /** The owner has looked at their own account, and says what it is. Recorded with when. */
  function verify(provider, cls) {
    const d = def(provider);
    if (!d?.verify?.[cls]) throw new Error('That is not something this connection can be confirmed as.');
    state.verified[provider] = { class: cls, at: now() };
    save();
  }
  function unverify(provider) { delete state.verified[provider]; save(); }

  function allowPaid(provider, allowedNow) {
    if (allowedNow) state.paidAllowed[provider] = true; else delete state.paidAllowed[provider];
    save();
  }

  function disconnect(provider) {
    delete state.verified[provider];
    delete state.chosen[provider];
    delete state.models[provider];
    delete state.paidAllowed[provider];
    save();
  }

  const noteNoTools = (provider, model) => { state.noTools[`${provider}:${model}`] = true; save(); };
  const toolsOf = (provider, model) => (state.noTools[`${provider}:${model}`] ? false : known(provider, model)?.tools ?? null);

  /** The model a Test Connection may use: the owner's choice, or else one that may run and can use tools. */
  async function modelForTest(provider, opts) {
    if (state.chosen[provider]) return state.chosen[provider];
    if (!state.models[provider]?.list?.length) await discover(provider);
    const list = allowed(provider, opts);
    return (list.find((m) => m.tools === true) ?? list[0])?.id ?? null;
  }

  const summary = (provider) => {
    const d = def(provider);
    return { verified: state.verified[provider] ?? null, chosen: state.chosen[provider] ?? null, modelCount: state.models[provider]?.list?.length ?? null, paidAllowed: Boolean(state.paidAllowed[provider]), name: d?.name };
  };

  return { def, classOf, providerBlock, block, resolveModel, discover, models, choose, verify, unverify, allowPaid, disconnect, modelForTest, summary, noteNoTools, toolsOf, allowed };
}

module.exports = { createConnections, DEFS, USAGE_CLASSES, baseOverride, ZAI_FREE };
