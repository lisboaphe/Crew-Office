// "Sign in with ChatGPT": an agent on the owner's own ChatGPT plan, through the route OpenAI
// documents for open-source clients (developers.openai.com/siwc). Sign-in happens on the
// owner's computer, in OpenAI's own page; tokens are stored encrypted in the worker's vault
// and go only to OpenAI. The room host never sees them.
//
//   authorize  https://auth.openai.com/api/accounts/authorize  (PKCE S256, loopback callback)
//              first time: client_id=dynamic_agent_client; the callback issues the real one
//   token      https://auth.openai.com/api/accounts/oauth/token
//   inference  POST https://api.openai.com/v1/responses  with store:false, stream:true,
//              instructions + input, and function tools
//
// Limits are the provider's: `subscription_sharing_usage_limit_exceeded` pauses the work and
// points at ChatGPT Settings → Usage. There is no fallback to API billing, and no retrying
// around a limit. The docs do not show the refresh request; it is the standard OAuth 2.0
// refresh_token grant against the same token endpoint.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { SCHEMAS } = require('./schemas.cjs');

const AUTH = () => process.env.CREW_OPENAI_AUTH_BASE || 'https://auth.openai.com';
const API = () => process.env.CREW_OPENAI_API_BASE || 'https://api.openai.com/v1';
const REDIRECT_PORT = Number(process.env.CREW_CHATGPT_PORT) || 1455;
const REDIRECT = () => `http://127.0.0.1:${REDIRECT_PORT}/auth/callback`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const VAULT_KEY = 'chatgptPlan';
const b64url = (b) => Buffer.from(b).toString('base64url');

class PlanError extends Error {
  constructor(message, { limit = false, retryable = false, signIn = false } = {}) { super(message); this.limit = limit; this.retryable = retryable; this.signIn = signIn; }
}

function createChatgptPlan(vault) {
  const load = () => vault.getSecret(VAULT_KEY) ?? {};
  const save = (patch) => vault.setSecret(VAULT_KEY, { ...load(), ...patch });

  function hostId() {
    let id = load().hostId;
    if (!id) { id = `urn:uuid:${crypto.randomUUID()}`; save({ hostId: id }); }
    return id;
  }

  /** Start sign-in: returns the URL to open; a one-shot loopback server takes the callback. */
  function startLogin() {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const saved = load();
    const q = new URLSearchParams({
      client_id: saved.clientId || 'dynamic_agent_client', response_type: 'code', redirect_uri: REDIRECT(), scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256', code_challenge: challenge, ext_agent_host_id: hostId(),
    });
    if (!saved.clientId) q.set('agent_name_hint', 'Crew Office');
    const url = `${AUTH()}/api/accounts/authorize?${q}`;
    const done = new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, REDIRECT());
        if (u.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
        const finish = (text) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); server.close(); };
        try {
          if (u.searchParams.get('state') !== state) throw new PlanError('The sign-in response did not match this request. Try again.');
          if (u.searchParams.get('error')) throw new PlanError(`Sign-in declined: ${u.searchParams.get('error')}`);
          const clientId = u.searchParams.get('client_id') || load().clientId;
          if (!clientId) throw new PlanError('OpenAI did not issue a client ID.');
          const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: u.searchParams.get('code'), code_verifier: verifier, redirect_uri: REDIRECT(), resource: RESOURCE });
          saveTokens(tokens, clientId);
          finish('Signed in. You can close this tab and go back to your worker page.');
          resolve(status());
        } catch (err) {
          finish(`Sign-in failed: ${err.message}`);
          reject(err);
        }
      });
      server.on('error', (err) => reject(new PlanError(`Could not listen on 127.0.0.1:${REDIRECT_PORT} for the sign-in callback: ${err.message}`)));
      server.listen(REDIRECT_PORT, '127.0.0.1');
      setTimeout(() => { server.close(); reject(new PlanError('Sign-in timed out.')); }, 10 * 60_000).unref?.();
    });
    done.catch(() => {});
    return { url, done };
  }

  async function tokenRequest(fields) {
    let res;
    try {
      res = await fetch(`${AUTH()}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(30_000) });
    } catch (err) { throw new PlanError(`Could not reach OpenAI to sign in: ${err.message}`, { retryable: true }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data.error?.code ?? data.error ?? `HTTP ${res.status}`;
      const unusable = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code);
      throw new PlanError(`OpenAI sign-in error: ${code}`, { signIn: unusable, retryable: res.status >= 500 });
    }
    return data;
  }

  function saveTokens(t, clientId) {
    save({ clientId, accessToken: t.access_token, refreshToken: t.refresh_token ?? load().refreshToken, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000, scopes: String(t.scope ?? load().scopes ?? SCOPES) });
  }

  async function accessToken() {
    const s = load();
    if (!s.accessToken) throw new PlanError('Not signed in with ChatGPT on this computer. Open the worker’s settings page and press “Sign in with ChatGPT”.', { signIn: true });
    if (!String(s.scopes ?? '').includes(PLAN_SCOPE)) throw new PlanError('You signed in without allowing ChatGPT plan usage. Sign in again and allow it.', { signIn: true });
    if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    if (!s.refreshToken) throw new PlanError('Your ChatGPT sign-in expired. Sign in again.', { signIn: true });
    try {
      saveTokens(await tokenRequest({ grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE }), s.clientId);
    } catch (err) {
      if (err.signIn) save({ accessToken: null, refreshToken: null });
      throw err;
    }
    return load().accessToken;
  }

  /** The models this account may use, as OpenAI lists them. */
  async function listModels() {
    const res = await fetch(`${API()}/models`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw classify(res.status, data);
    const list = data.data ?? data.models ?? [];
    return list.filter((m) => (m.visibility ?? 'list') === 'list').map((m) => ({ slug: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }));
  }

  function classify(status, data) {
    const code = data?.error?.code ?? data?.code ?? '';
    const msg = data?.error?.message ?? data?.message ?? `HTTP ${status}`;
    if (code === 'subscription_sharing_usage_limit_exceeded') return new PlanError('The ChatGPT usage limit for this app or plan was reached. Work is paused; check ChatGPT Settings → Usage. No other billing is used.', { limit: true });
    if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return new PlanError('ChatGPT could not check usage just now; trying again later.', { limit: true });
    if (code === 'subscription_sharing_user_not_eligible') return new PlanError('ChatGPT plan usage is not available for this account, workspace or policy.');
    if (code === 'subscription_sharing_invalid_user' || status === 401) return new PlanError(`ChatGPT rejected the sign-in (${code || status}). You may need to sign in again.`, { signIn: true });
    if (code === 'subscription_sharing_unsupported_capability') return new PlanError(`ChatGPT plan usage does not support part of this request: ${data?.error?.param ?? msg}.`);
    return new PlanError(`ChatGPT error ${code || status}: ${msg}`, { retryable: status >= 500 });
  }

  function render(transcript) {
    const input = [];
    for (const e of transcript) {
      if (e.role === 'user') input.push({ role: 'user', content: e.text });
      else if (e.role === 'assistant') {
        if (e.text) input.push({ role: 'assistant', content: e.text });
        for (const c of e.toolCalls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
      } else if (e.role === 'tool') for (const r of e.results) input.push({ type: 'function_call_output', call_id: r.id, output: r.content });
    }
    return input;
  }

  async function complete({ system, transcript, tools, model }) {
    let slug = model;
    if (!slug || slug === 'default') {
      const models = await listModels();
      if (!models.length) throw new PlanError('This account lists no models for plan usage.');
      slug = models[0].slug;
    }
    const body = { model: slug, instructions: system, input: render(transcript), store: false, stream: true,
      tools: tools.map((t) => ({ type: 'function', name: t, description: SCHEMAS[t].description, parameters: SCHEMAS[t].input })) };
    let res;
    try {
      res = await fetch(`${API()}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
    } catch (err) {
      if (err instanceof PlanError) throw err;
      throw new PlanError(`Could not reach ChatGPT: ${err.message}`, { retryable: true });
    }
    if (!res.ok) throw classify(res.status, await res.json().catch(() => ({})));

    let text = '';
    const toolCalls = [];
    let usage = { in: 0, out: 0 };
    let finished = false;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'response.output_text.delta') text += ev.delta ?? '';
        else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
          let input;
          try { input = JSON.parse(ev.item.arguments || '{}'); } catch { input = { __invalid_json: ev.item.arguments }; }
          toolCalls.push({ id: ev.item.call_id, name: ev.item.name, input });
        } else if (ev.type === 'response.completed') {
          finished = true;
          usage = { in: ev.response?.usage?.input_tokens ?? 0, out: ev.response?.usage?.output_tokens ?? 0 };
        } else if (ev.type === 'response.failed') throw classify(200, { error: ev.response?.error ?? ev.error });
        else if (ev.type === 'response.incomplete') throw new PlanError(`ChatGPT stopped early: ${ev.response?.incomplete_details?.reason ?? 'incomplete'}.`, { retryable: true });
        else if (ev.type === 'error') throw classify(200, { error: ev.error ?? ev });
      }
    }
    // Per the docs, a request succeeded only once response.completed has arrived.
    if (!finished) throw new PlanError('The connection to ChatGPT dropped before the response finished.', { retryable: true });
    return { text: text.trim(), toolCalls, raw: null, stopReason: toolCalls.length ? 'tool_use' : 'end_turn', model: `chatgpt-plan:${slug}`, usage };
  }

  function status() {
    const s = load();
    return { signedIn: Boolean(s.accessToken), planScope: String(s.scopes ?? '').includes(PLAN_SCOPE), expiresAt: s.expiresAt ?? null };
  }

  function signOut() { save({ accessToken: null, refreshToken: null, expiresAt: null, scopes: null }); }

  return { name: 'chatgpt-plan', complete, startLogin, listModels, status, signOut };
}

module.exports = { createChatgptPlan, PlanError };
