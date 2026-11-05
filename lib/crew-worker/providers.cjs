// Provider adapters: one interface over Anthropic, OpenAI, local OpenAI-compatible
// servers (Ollama, LM Studio, vLLM), and a scripted test provider.
//
//   complete({ system, transcript, tools, model }) ->
//     { text, toolCalls: [{ id, name, input }], raw, stopReason, usage: { in, out }, model }
//
// The runner keeps a neutral transcript:
//   { role: 'user', text }
//   { role: 'assistant', text, toolCalls, raw, provider }
//   { role: 'tool', results: [{ id, name, content, isError }] }
// and each adapter renders it into its API's own message format. For Anthropic the
// assistant turn is replayed from `raw` — the response content exactly as returned —
// because thinking blocks must be passed back unchanged.

'use strict';

const { SCHEMAS } = require('./schemas.cjs');
const { createScripted } = require('./scripted.cjs');
const { claudeCliAdapter, codexCliAdapter, reportQuota } = require('./cli-providers.cjs');

const OPENROUTER_BASE = () => process.env.CREW_OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const { createChatgptPlan } = require('./chatgpt-plan.cjs');

const MAX_TOKENS = 16000;

class ProviderError extends Error {
  constructor(message, { retryable = false, limit = false } = {}) { super(message); this.retryable = retryable; this.limit = limit; }
}

// --- Anthropic (official SDK) ------------------------------------------------

/** Models that accept the server-side refusal fallback in its `"default"` form. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

function anthropicAdapter(creds) {
  let client = null;
  async function sdk() {
    if (client) return client;
    let mod;
    try { mod = require('@anthropic-ai/sdk'); } catch { throw new ProviderError('The Anthropic SDK is not installed on this worker. Run `npm install` in the app folder.'); }
    const Anthropic = mod.default ?? mod;
    client = { api: new Anthropic({ apiKey: creds.apiKey, maxRetries: 2 }), Anthropic };
    return client;
  }

  function render(transcript) {
    const out = [];
    for (const e of transcript) {
      if (e.role === 'user') out.push({ role: 'user', content: e.text });
      else if (e.role === 'assistant') out.push({ role: 'assistant', content: e.provider === 'anthropic' && e.raw ? e.raw : assistantBlocks(e) });
      else if (e.role === 'tool') out.push({ role: 'user', content: e.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })) });
    }
    return out;
  }

  function assistantBlocks(e) {
    const blocks = [];
    if (e.text) blocks.push({ type: 'text', text: e.text });
    for (const c of e.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    return blocks.length ? blocks : [{ type: 'text', text: '(no reply)' }];
  }

  return {
    name: 'anthropic',
    async complete({ system, transcript, tools, model, effort }) {
      if (!creds.apiKey) throw new ProviderError('No Anthropic API key on this worker. Add one on the worker’s settings page or set ANTHROPIC_API_KEY.');
      const { api, Anthropic } = await sdk();
      const params = {
        model, max_tokens: MAX_TOKENS, system, messages: render(transcript),
        tools: tools.map((t) => ({ name: t, description: SCHEMAS[t].description, input_schema: SCHEMAS[t].input })),
      };
      if (effort) params.output_config = { effort };
      // Opted in: if the model declines on policy grounds, the API re-runs the request on
      // a fallback model inside the same call instead of failing the task.
      if (FALLBACK_MODELS.has(model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
      let res;
      try {
        res = await api.beta.messages.create(params);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Anthropic rejected the API key on this worker.');
        if (err instanceof Anthropic.RateLimitError) throw new ProviderError('Anthropic rate limit reached; work is paused.', { limit: true });
        if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic refused the request: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, { retryable: (err.status ?? 0) >= 500 });
        throw new ProviderError(`Could not reach Anthropic: ${err.message}`, { retryable: true });
      }
      if (res.stop_reason === 'refusal') throw new ProviderError(`The model declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`);
      const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const u = res.usage ?? {};
      return {
        text, toolCalls, raw: res.content, stopReason: res.stop_reason, model: res.model ?? model,
        usage: { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 },
      };
    },
  };
}

// --- OpenAI and OpenAI-compatible local servers ----------------------------

function openaiCompatibleAdapter(creds, { name, defaultBase, keyRequired, extraBody = {} }) {
  const base = String(creds.baseUrl || defaultBase).replace(/\/+$/, '');

  function render(system, transcript) {
    const out = [{ role: 'system', content: system }];
    for (const e of transcript) {
      if (e.role === 'user') out.push({ role: 'user', content: e.text });
      else if (e.role === 'assistant') {
        const m = { role: 'assistant', content: e.text || null };
        if (e.toolCalls?.length) m.tool_calls = e.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
        out.push(m);
      } else if (e.role === 'tool') for (const r of e.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
    return out;
  }

  return {
    name,
    async complete({ system, transcript, tools, model }) {
      if (keyRequired && !creds.apiKey) throw new ProviderError(`No ${name} API key on this worker.`);
      const body = {
        model, messages: render(system, transcript),
        tools: tools.map((t) => ({ type: 'function', function: { name: t, description: SCHEMAS[t].description, parameters: SCHEMAS[t].input } })),
      };
      if (name === 'openai') body.max_completion_tokens = MAX_TOKENS; else body.max_tokens = 4096;
      Object.assign(body, extraBody);
      let res;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        throw new ProviderError(`Could not reach ${name} at ${base}: ${err.message}`, { retryable: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(`${name} error ${res.status}: ${data?.error?.message ?? res.statusText}`, { retryable: res.status === 429 || res.status >= 500 });
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((c) => {
        let input;
        try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = { __invalid_json: c.function?.arguments }; }
        return { id: c.id, name: c.function?.name, input };
      });
      return {
        text: String(msg.content ?? '').trim(), toolCalls, raw: null, stopReason: data.choices?.[0]?.finish_reason, model: data.model ?? model,
        usage: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

const isFreeModel = (m) => m === 'openrouter/free' || String(m).endsWith(':free');
const nextUtcMidnight = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
const KEY_CHECK_MS = 5 * 60_000;
let lastKeyCheck = 0;

/** A key that can only ever spend nothing: free models by name, and a price cap of zero as well. */
function openrouterFreeAdapter(creds) {
  const inner = openaiCompatibleAdapter({ apiKey: creds.apiKey }, { name: 'openrouter-free', defaultBase: OPENROUTER_BASE(), keyRequired: true, extraBody: { provider: { max_price: { prompt: 0, completion: 0 } } } });
  return {
    name: 'openrouter-free',
    async complete(args) {
      if (!isFreeModel(args.model)) throw new ProviderError(`${args.model} is not a free model, so this connection will not run it. Use openrouter/free, or a model ending in :free.`);
      let res;
      try { res = await inner.complete(args); } catch (err) {
        // 429 is its free-request limit and 402 a credit problem: both are answers, not glitches.
        if (/error (402|429)\b/.test(err.message)) throw new ProviderError(err.message, { limit: true });
        throw err;
      }
      reportFreeQuota(creds.apiKey).catch(() => {});
      return res;
    },
  };
}

/** OpenRouter's documented reading of a key's own free-model requests today. */
async function reportFreeQuota(apiKey) {
  if (Date.now() - lastKeyCheck < KEY_CHECK_MS) return;
  lastKeyCheck = Date.now();
  const res = await fetch(`${OPENROUTER_BASE()}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  const free = (await res.json())?.data?.free_model_daily_requests;
  if (!res.ok || !(free?.limit > 0)) return;
  reportQuota('openrouter-free', { windows: { 'free requests today': { usedPercent: Math.min(100, (100 * free.used) / free.limit), resetsAt: nextUtcMidnight() } }, source: 'Reported by OpenRouter' });
}

/**
 * The billing check is here, in the one place every model call passes through, so no code
 * path can reach a paid API while "Never use paid API" is on.
 */
function createProvider(provider, vault, budget = null) {
  const blocked = budget?.billingBlock(provider);
  if (blocked) throw new ProviderError(blocked);
  if (provider === 'chatgpt-plan') return createChatgptPlan(vault);
  if (provider === 'anthropic') return anthropicAdapter(vault.get('anthropic'));
  if (provider === 'openai') return openaiCompatibleAdapter(vault.get('openai'), { name: 'openai', defaultBase: 'https://api.openai.com/v1', keyRequired: true });
  if (provider === 'openrouter-free') return openrouterFreeAdapter(vault.get('openrouter-free'));
  if (provider === 'local') return openaiCompatibleAdapter(vault.get('local'), { name: 'local', defaultBase: 'http://127.0.0.1:11434/v1', keyRequired: false });
  if (provider === 'claude-cli') return claudeCliAdapter();
  if (provider === 'codex-cli') return codexCliAdapter();
  if (provider === 'scripted') return createScripted();
  throw new ProviderError(`Unknown provider ${provider}.`);
}

module.exports = { createProvider, ProviderError };
