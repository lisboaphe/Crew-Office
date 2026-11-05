// Subscription providers: an agent that runs on its owner's Claude Pro/Max plan through
// Claude Code, or on their ChatGPT Plus/Pro plan through Codex — the owner's own CLI, on
// the owner's own machine, signed in with their own account. No API key involved.
//
// These CLIs are agents in their own right with their own tools. Here they are used as a
// plain model: their built-in tools are switched off (Claude Code) or confined to a
// read-only sandbox in an empty folder (Codex), and the office's tools are offered through
// a small JSON protocol instead — the model answers with one JSON object naming the tool
// calls it wants, the runner executes them exactly as it does for the API providers, and
// the results go back in the next prompt. So permissions, approvals, budgets and the bus
// apply unchanged.
//
// Each turn is one CLI run with the whole transcript in the prompt (the CLIs are run
// statelessly). Subscription usage is not billed per token, so cost is reported as $0;
// the plan's own usage limits apply instead.
//
// Commands can be overridden with CREW_CLAUDE_CLI / CREW_CODEX_CLI (a path, or a command).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { SCHEMAS } = require('./schemas.cjs');
const { fromCodexEvent, fromClaudeEvent } = require('./quota.cjs');

// The colour and cursor codes a command-line tool prints for a terminal.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

const TIMEOUT_MS = 10 * 60_000;

class CliError extends Error {
  constructor(message, { retryable = false, limit = false } = {}) { super(message); this.retryable = retryable; this.limit = limit; }
}

/** The office's tools, described for a model that answers in JSON rather than tool blocks. */
function toolGuide(tools) {
  const lines = [
    '',
    '## How you act in this office',
    'You do not have any built-in tools. You act ONLY by replying with ONE JSON object and nothing else:',
    '{"say": "<short note, optional>", "tool_calls": [{"name": "<tool>", "input": {…}}]}',
    'The office runs the calls in order and sends you the results. When you are completely finished, reply with:',
    '{"say": "<your final answer or summary>", "tool_calls": []}',
    'No markdown fences, no prose outside the JSON. Available tools:',
  ];
  for (const t of tools) lines.push(`- ${t}: ${SCHEMAS[t].description}\n  input schema: ${JSON.stringify(SCHEMAS[t].input)}`);
  return lines.join('\n');
}

function renderTranscript(transcript) {
  const out = [];
  for (const e of transcript) {
    if (e.role === 'user') out.push(`### Task\n${e.text}`);
    else if (e.role === 'assistant') out.push(`### You replied\n${JSON.stringify({ say: e.text || undefined, tool_calls: (e.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input })) })}`);
    else if (e.role === 'tool') out.push(`### Tool results\n${e.results.map((r) => `${r.name}${r.isError ? ' (error)' : ''}: ${r.content}`).join('\n')}`);
  }
  out.push('### Your next reply (one JSON object)');
  return out.join('\n\n');
}

/** Pull the JSON object out of whatever the model said, tolerating fences and preambles. */
function parseReply(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object') {
        const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
        return {
          text: String(obj.say ?? '').trim(),
          toolCalls: calls.filter((x) => x && typeof x.name === 'string').slice(0, 8)
            .map((x, i) => ({ id: `cli_${Date.now().toString(36)}_${i}`, name: x.name, input: x.input && typeof x.input === 'object' ? x.input : {} })),
        };
      }
    } catch { /* try the next shape */ }
  }
  // Not JSON at all: treat it as a final plain-text answer rather than failing the job.
  return { text: raw, toolCalls: [] };
}

/** Take down a CLI and whatever it started. On Windows the child is only the shell around it. */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ } } else child.kill('SIGKILL');
}

function run(cmd, args, input, { cwd, signal = null, env = null }) {
  return new Promise((resolve, reject) => {
    // npm installs these CLIs as .cmd shims on Windows, which only start through a shell.
    // Every argument is a fixed flag or a validated model name; the prompt goes via stdin.
    const win = process.platform === 'win32';
    const child = spawn(win ? quoteWin(cmd) : cmd, win ? args.map(quoteWin) : args, { cwd, shell: win, windowsHide: true, env: env ?? subscriptionEnv(), stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { killTree(child); reject(new CliError(`${cmd} took longer than ${TIMEOUT_MS / 60000} minutes.`, { retryable: true })); }, TIMEOUT_MS);
    const stopped = () => { clearTimeout(timer); killTree(child); reject(new CliError('Stopped.')); };
    if (signal?.aborted) stopped(); else signal?.addEventListener('abort', stopped, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new CliError(e.code === 'ENOENT' ? `“${cmd}” is not installed on this worker's computer, or not on its PATH.` : e.message));
    });
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', stopped); resolve({ code, out, err }); });
    if (input !== null) child.stdin.end(input);
  });
}

/**
 * The CLI's environment, without anything that would switch it from the owner's subscription
 * to per-token billing. Claude Code prefers ANTHROPIC_API_KEY over a signed-in plan when it
 * finds one, so a key sitting in the shell would silently start charging. Exported for tests.
 */
function subscriptionEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY)$/i.test(k)) delete env[k];
  return env;
}

/** cmd.exe drops empty arguments and splits on spaces, so quote anything that needs it. */
function quoteWin(a) {
  const s = String(a);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

const safeModel = (m) => (/^[\w.:-]{1,80}$/.test(String(m ?? '')) ? String(m) : null);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cli-'));
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* Windows can hold a folder a moment after a CLI exits; it is only temp. */ } };

// Where a run's provider-reported usage goes. Set by the worker's main; nothing listens in tests
// unless they ask.
let quotaSink = () => {};
const setQuotaSink = (fn) => { quotaSink = fn; };
const reportQuota = (provider, reading) => quotaSink(provider, reading);

const jsonLines = (out) => String(out).split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

/** Claude Code, signed in with a Claude Pro or Max subscription (`claude` once, then /login). */
function claudeCliAdapter() {
  const cmd = process.env.CREW_CLAUDE_CLI || 'claude';
  return {
    name: 'claude-cli',
    async complete({ system, transcript, tools, model, signal }) {
      // `--tools ""` switches off every built-in tool; the system prompt travels in stdin
      // with the rest, so nothing long or user-written is ever on a command line.
      // stream-json rather than json: it is the form that carries the plan's usage events.
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config'];
      const m = safeModel(model);
      if (m && m !== 'default') args.push('--model', m);
      const cwd = tempDir();
      try {
        const prompt = `${system}\n${toolGuide(tools)}\n\n${renderTranscript(transcript)}`;
        const r = await run(cmd, args, prompt, { cwd, signal });
        const events = jsonLines(r.out);
        const data = events.findLast((e) => e.result !== undefined || e.type === 'result') ?? null;
        for (const e of events) { const q = fromClaudeEvent(e); if (q) quotaSink('claude-cli', q); }
        if (r.code !== 0 || !data) {
          const why = `${data?.result ?? ''} ${r.err}`.trim().slice(0, 400);
          if (/login|log in|auth|credential/i.test(why)) throw new CliError('Claude Code on this worker is not signed in. Run `claude` once and sign in with your Claude account.');
          if (/limit|quota|usage/i.test(why)) throw new CliError(`Your Claude plan’s usage limit was reached: ${why}`, { limit: true });
          throw new CliError(`Claude Code failed (exit ${r.code}): ${why || 'no output'}`, { retryable: true });
        }
        if (data.is_error) throw new CliError(`Claude Code reported an error: ${String(data.result).slice(0, 400)}`, { retryable: true });
        const reply = parseReply(data.result);
        const u = data.usage ?? {};
        return {
          ...reply, raw: null, stopReason: reply.toolCalls.length ? 'tool_use' : 'end_turn', model: `claude-cli:${m ?? 'default'}`,
          usage: { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 },
        };
      } finally { removeDir(cwd); }
    },
  };
}

/** Codex, signed in with a ChatGPT Plus or Pro plan (`codex login`). */
function codexCliAdapter() {
  const cmd = process.env.CREW_CODEX_CLI || 'codex';
  return {
    name: 'codex-cli',
    async complete({ system, transcript, tools, model, signal }) {
      const cwd = tempDir();
      const last = path.join(cwd, 'last-message.txt');
      // Read-only sandbox in an empty folder: if Codex reaches for a shell anyway, there is
      // nothing there to read and nothing it may write.
      const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, '--output-last-message', last];
      const m = safeModel(model);
      if (m && m !== 'default') args.push('-m', m);
      args.push('-');
      try {
        const prompt = `${system}\n${toolGuide(tools)}\n\n${renderTranscript(transcript)}`;
        const r = await run(cmd, args, prompt, { cwd, signal });
        let usage = { in: 0, out: 0 };
        for (const line of r.out.split('\n')) {
          try {
            const ev = JSON.parse(line);
            const u = ev.usage ?? ev.msg?.usage ?? ev.info?.total_token_usage;
            if (u) usage = { in: u.input_tokens ?? usage.in, out: u.output_tokens ?? usage.out };
            const q = fromCodexEvent(ev);
            if (q) quotaSink('codex-cli', q);
          } catch { /* not a JSON line */ }
        }
        const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
        if (r.code !== 0 || !text.trim()) {
          const why = `${r.err} ${r.out.slice(-400)}`.trim().slice(0, 400);
          if (/login|auth|sign in|unauthori/i.test(why)) throw new CliError('Codex on this worker is not signed in. Run `codex login` and sign in with your ChatGPT account.');
          if (/limit|quota|usage/i.test(why)) throw new CliError(`Your ChatGPT plan’s usage limit was reached: ${why}`, { limit: true });
          throw new CliError(`Codex failed (exit ${r.code}): ${why || 'no output'}`, { retryable: true });
        }
        const reply = parseReply(text);
        return { ...reply, raw: null, stopReason: reply.toolCalls.length ? 'tool_use' : 'end_turn', model: `codex-cli:${m ?? 'default'}`, usage };
      } finally { removeDir(cwd); }
    },
  };
}

const OPENCODE = () => process.env.CREW_OPENCODE_CLI || 'opencode';
const KIRO = () => process.env.CREW_KIRO_CLI || 'kiro-cli';

/**
 * Its environment holds none of the owner's API keys. A model name here can only be one of
 * OpenCode's own, so OpenCode has no reason to reach for any other account of theirs.
 */
function cleanCliEnv(extra = {}) {
  const env = subscriptionEnv();
  for (const k of Object.keys(env)) if (/^(GEMINI|GOOGLE|MISTRAL|OPENROUTER|NVIDIA|ZAI|OLLAMA|CLOUDFLARE|KIRO|DEEPSEEK|GROQ|XAI|TOGETHER|FIREWORKS)_.*(KEY|TOKEN)$/i.test(k)) delete env[k];
  return { ...env, ...extra };
}

/** Every model OpenCode's own service lists, with what it says each one costs. */
async function opencodeModels() {
  const r = await run(OPENCODE(), ['models', 'opencode', '--verbose'], null, { cwd: os.tmpdir(), env: cleanCliEnv() });
  if (r.code !== 0) throw new CliError(`OpenCode could not list its models: ${r.err.slice(0, 200)}`);
  const rows = [];
  for (const m of r.out.matchAll(/^opencode\/(\S+)\s*\r?\n(\{[\s\S]*?^\})/gm)) {
    let j;
    try { j = JSON.parse(m[2]); } catch { continue; }
    if (j.status && j.status !== 'active') continue;
    const costs = [j.cost?.input, j.cost?.output];
    const free = costs.every((c) => c === 0);
    const paid = costs.some((c) => c > 0);
    rows.push({ id: m[1], name: j.name ?? m[1], context: j.limit?.context > 0 ? j.limit.context : null, tools: typeof j.capabilities?.toolcall === 'boolean' ? j.capabilities.toolcall : null, reasoning: typeof j.capabilities?.reasoning === 'boolean' ? j.capabilities.reasoning : null, usage: free ? 'promo' : paid ? 'paid' : 'unknown' });
  }
  return rows;
}

/**
 * OpenCode's free models only run through OpenCode, so this is the official app used as a plain
 * model, as with Claude Code and Codex above. It runs in an empty folder with its own tools denied.
 * The prompt is a custom agent's system prompt in a file, which has no command-line length limit,
 * and which a model follows: sent as an attached file instead, models took it for a prompt injection
 * and refused. A rule denying everything makes a run hang, so that one file stays readable by name.
 */
function opencodeCliAdapter() {
  return {
    name: 'opencode',
    async complete({ system, transcript, tools, model, signal }) {
      const m = String(model ?? '').replace(/^opencode\//, '');
      if (!/^[\w.:-]{1,80}$/.test(m)) throw new CliError('That is not one of OpenCode’s own models.');
      const cwd = tempDir();
      try {
        const permission = { '*': 'deny', read: { '*': 'deny', 'prompt.md': 'allow' } };
        fs.writeFileSync(path.join(cwd, 'opencode.json'), JSON.stringify({ permission, agent: { crew: { mode: 'primary', prompt: '{file:./prompt.md}', permission } } }));
        fs.writeFileSync(path.join(cwd, 'prompt.md'), `${system}\n${toolGuide(tools)}\n\n${renderTranscript(transcript)}`);
        // PWD, because OpenCode believes that over the real working folder, and a shell can leave a stale one.
        const r = await run(OPENCODE(), ['run', 'Give your next reply now, as your instructions say.', '--format', 'json', '--agent', 'crew', '-m', `opencode/${m}`], null, { cwd, signal, env: cleanCliEnv({ PWD: cwd }) });
        const events = jsonLines(r.out);
        const text = events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('');
        const steps = events.filter((e) => e.type === 'step_finish').map((e) => e.part ?? {});
        const failure = events.find((e) => e.type === 'error');
        // It says what each step cost. If that ever is not nothing, nothing more goes out.
        const cost = steps.reduce((sum, s) => sum + (Number(s.cost) || 0), 0);
        if (cost > 0) { const e = new CliError(`OpenCode says this request cost ${cost}. It should have been free, so this connection has stopped.`); e.signIn = true; throw e; }
        if (r.code !== 0 || failure || !text.trim()) {
          const why = `${JSON.stringify(failure?.error ?? '')} ${r.err}`.replace(ANSI, '').trim().slice(0, 300);
          if (/rate.?limit|quota|too many|credit|insufficient|429|402/i.test(why)) throw new CliError(`OpenCode reported a limit: ${why}`, { limit: true });
          throw new CliError(`OpenCode failed (exit ${r.code}): ${why || 'no answer'}`, { retryable: true });
        }
        const reply = parseReply(text);
        const sum = (k) => steps.reduce((n, s) => n + (Number(s.tokens?.[k]) || 0), 0);
        return { ...reply, raw: null, stopReason: reply.toolCalls.length ? 'tool_use' : 'end_turn', model: `opencode/${m}`, usage: { in: sum('input'), out: sum('output') } };
      } finally { removeDir(cwd); }
    },
  };
}

/** Kiro's own list of the models this account has. Its documented JSON output. */
async function kiroModels() {
  const r = await run(KIRO(), ['chat', '--list-models', '--format', 'json'], null, { cwd: os.tmpdir(), env: cleanCliEnv() });
  if (r.code !== 0) throw new CliError(`Kiro could not list its models: ${r.err.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(r.out); } catch { throw new CliError('Kiro listed its models in a form this version does not read.'); }
  const rows = Array.isArray(data) ? data : data.models ?? [];
  return rows.map((x) => {
    const id = typeof x === 'string' ? x : x.model_id ?? x.id ?? x.name;
    return { id, name: id, context: x.context_window ?? null, tools: null, reasoning: null };
  }).filter((x) => x.id);
}

/**
 * The official Kiro CLI, on the owner's own plan. No tool is trusted, in an empty folder, so a tool
 * it reaches for is not approved. Written from Kiro's documentation: no real account has run this.
 */
function kiroCliAdapter(creds = {}) {
  return {
    name: 'kiro',
    async complete({ system, transcript, tools, model, signal }) {
      const args = ['chat', '--no-interactive'];
      const m = safeModel(model);
      if (m && m !== 'default') args.push('--model', m);
      const cwd = tempDir();
      try {
        const r = await run(KIRO(), args, `${system}\n${toolGuide(tools)}\n\n${renderTranscript(transcript)}`, { cwd, signal, env: cleanCliEnv(creds.apiKey ? { KIRO_API_KEY: creds.apiKey } : {}) });
        const out = r.out.replace(ANSI, '').trim();
        if (r.code !== 0 || !out) {
          const why = `${r.err} ${out}`.replace(ANSI, '').trim().slice(0, 300);
          if (/log.?in|auth|api.?key|credential/i.test(why)) { const e = new CliError('Kiro on this computer is not signed in, or running without a person needs an API key from a paid Kiro plan.'); e.signIn = true; throw e; }
          if (/credit|limit|quota/i.test(why)) throw new CliError(`Kiro reported a limit: ${why}`, { limit: true });
          throw new CliError(`Kiro failed (exit ${r.code}): ${why || 'no answer'}`, { retryable: true });
        }
        const reply = parseReply(out);
        return { ...reply, raw: null, stopReason: reply.toolCalls.length ? 'tool_use' : 'end_turn', model: `kiro:${m ?? 'default'}`, usage: { in: 0, out: 0 } };
      } finally { removeDir(cwd); }
    },
  };
}

module.exports = { opencodeCliAdapter, kiroCliAdapter, opencodeModels, kiroModels, cleanCliEnv, setQuotaSink, reportQuota, claudeCliAdapter, codexCliAdapter, parseReply, toolGuide, renderTranscript, quoteWin, subscriptionEnv };
