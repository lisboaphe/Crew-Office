// What the Connections page and the Add Worker wizard ask this computer. It looks for the official
// tools, asks them whether they are signed in, and starts their own sign-in. It never sees a
// password or a token: the official tool holds those, and this only reads its yes or no.
//
// Status words are what they say. `working` comes only from a Test Connection that really got
// an answer (provider-status.cjs). Anything not proven says so.

'use strict';

const fs = require('fs');
const { exec, spawn } = require('child_process');
const { subscriptionEnv } = require('./cli-providers.cjs');
const { DEFS, USAGE_CLASSES } = require('./ai-connections.cjs');

const TOOLS = {
  codex: { cmd: () => process.env.CREW_CODEX_CLI || 'codex', install: 'npm install -g @openai/codex', signIn: ['login'], signedIn: ['login', 'status'], docs: 'https://developers.openai.com/codex/cli' },
  claude: { cmd: () => process.env.CREW_CLAUDE_CLI || 'claude', install: 'npm install -g @anthropic-ai/claude-code', signIn: ['auth', 'login'], signedIn: ['auth', 'status'], docs: 'https://code.claude.com/docs' },
  opencode: { cmd: () => process.env.CREW_OPENCODE_CLI || 'opencode', install: 'npm install -g opencode-ai', docs: 'https://opencode.ai/docs' },
  kiro: { cmd: () => process.env.CREW_KIRO_CLI || 'kiro-cli', signIn: ['login'], signedIn: ['whoami'], docs: 'https://kiro.dev/docs/getting-started/installation/' },
};

const LOCAL_RUNTIMES = {
  ollama: { name: 'Ollama', url: 'http://127.0.0.1:11434/v1', probe: 'http://127.0.0.1:11434/api/tags', models: (d) => (d.models ?? []).map((m) => m.name), docs: 'https://ollama.com/download' },
  lmstudio: { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1', probe: 'http://127.0.0.1:1234/v1/models', models: (d) => (d.data ?? []).map((m) => m.id), docs: 'https://lmstudio.ai' },
};

function sh(command, timeout = 10_000) {
  return new Promise((resolve) => {
    exec(command, { timeout, windowsHide: true, env: subscriptionEnv() }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}

const safeCommand = (cmd) => (/["&|<>^%!;`$\n]/.test(cmd) ? null : `"${cmd}"`);

async function findTool(id) {
  const tool = TOOLS[id];
  const cmd = tool.cmd();
  const quoted = safeCommand(cmd);
  if (!quoted) return { installed: false, cmd };
  // A configured full path is its own answer: Windows' where cannot look one up.
  const direct = /[\\/]/.test(cmd);
  const where = direct ? { ok: fs.existsSync(cmd) || fs.existsSync(`${cmd}.cmd`), out: cmd } : await sh(process.platform === 'win32' ? `where ${quoted}` : `command -v ${quoted}`, 5000);
  if (!where.ok || !where.out) return { installed: false, cmd };
  const version = await sh(`${quoted} --version`);
  const out = { installed: true, cmd, path: where.out.split(/\r?\n/)[0], version: version.ok ? version.out.split(/\r?\n/)[0].slice(0, 80) : null };
  if (!tool.signedIn) return { ...out, signedIn: true, noAccount: true };
  // Only the tool's own yes or no. Its output can name an account, so none of it is kept.
  const status = await sh(`${quoted} ${tool.signedIn.join(' ')}`);
  const unknownCommand = /unknown|unrecognized|invalid (sub)?command|usage:/i.test(`${status.err} ${status.out}`);
  out.signedIn = unknownCommand ? null : status.ok && !/not logged in|not signed in|"loggedIn":\s*false/i.test(status.out);
  return out;
}

async function probeLocal(id) {
  const r = LOCAL_RUNTIMES[id];
  try {
    const res = await fetch(r.probe, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { running: false };
    const models = r.models(await res.json());
    return { running: true, models: models.slice(0, 30) };
  } catch { return { running: false }; }
}

function createSetup({ providerStatus, vault, budget, quota, connections: ai = null }) {
  /** The worker's own record: did a real request come back, or did one fail? */
  function tested(provider) {
    const s = providerStatus.state(provider);
    return { working: s.state === 'Working', limited: s.state === 'Limited', failed: s.state === 'Requires User Action', reason: s.reason };
  }

  const card = (fields) => ({ technical: {}, install: null, signIn: null, ...fields });

  async function connections() {
    await providerStatus.refreshInstalled();
    const [codex, claude, ollama, lmstudio] = await Promise.all([findTool('codex'), findTool('claude'), probeLocal('ollama'), probeLocal('lmstudio')]);
    const cards = [];

    const plan = vault.getSecret('chatgptPlan') ?? {};
    const planState = tested('chatgpt-plan');
    cards.push(card({
      id: 'chatgpt-plan', provider: 'chatgpt-plan', group: 'subscription', name: 'ChatGPT plan', method: 'Sign in with ChatGPT, in your browser',
      status: !plan.accessToken ? 'signin' : planState.working ? 'working' : planState.limited ? 'error' : 'untested',
      detail: !plan.accessToken ? 'Sign in on OpenAI’s own page. This app never sees your password.' : planState.reason,
      installed: 'Built in', account: plan.accessToken ? 'Signed in' : 'Not signed in',
      signIn: { kind: 'chatgpt' }, canTest: Boolean(plan.accessToken), usageNote: 'OpenAI does not publish a way for apps to read plan usage. See ChatGPT Settings → Usage.',
    }));

    const codexState = tested('codex-cli');
    cards.push(card({
      id: 'codex-cli', provider: 'codex-cli', group: 'subscription', name: 'Codex', method: 'The official Codex app, signed in with your ChatGPT plan',
      status: !codex.installed ? 'notinstalled' : codex.signedIn === false ? 'signin' : codexState.working ? 'working' : 'untested',
      detail: !codex.installed ? 'Codex is not installed on this computer.' : codex.signedIn === false ? 'Codex is installed but not signed in.' : codexState.reason,
      installed: codex.installed ? (codex.version ?? 'Installed') : 'Not installed', account: codex.signedIn == null ? 'Unknown until tested' : codex.signedIn ? 'Signed in' : 'Not signed in',
      install: { tool: 'codex', command: TOOLS.codex.install, docs: TOOLS.codex.docs }, signIn: { kind: 'tool', tool: 'codex' }, canTest: codex.installed,
      technical: { path: codex.path ?? 'not found', version: codex.version ?? 'unknown' },
    }));

    const claudeBlocked = budget.billingBlock('claude-cli');
    const handoff = tested('claude-handoff');
    cards.push(card({
      id: 'claude-handoff', provider: 'claude-handoff', group: 'subscription', name: 'Claude Code', method: 'Manual handoff: you run each task in your own Claude Code',
      status: !claude.installed ? 'notinstalled' : claude.signedIn === false ? 'signin' : 'untested',
      statusText: claude.installed && claude.signedIn !== false ? 'Ready, runs by hand' : null,
      detail: !claude.installed ? 'Claude Code is not installed on this computer.' : claude.signedIn === false ? 'Claude Code is installed but not signed in.' : handoff.reason,
      installed: claude.installed ? (claude.version ?? 'Installed') : 'Not installed', account: claude.signedIn == null ? 'Unknown' : claude.signedIn ? 'Signed in' : 'Not signed in',
      install: { tool: 'claude', command: TOOLS.claude.install, docs: TOOLS.claude.docs }, signIn: { kind: 'tool', tool: 'claude' }, canTest: false,
      notice: 'Anthropic does not allow third-party apps to route requests through Claude plan credentials on behalf of users, so this app does not run Claude for you by default. It prepares the task; you run it yourself.',
      technical: { path: claude.path ?? 'not found', version: claude.version ?? 'unknown', 'automated mode': claudeBlocked ? 'off' : 'on, by your choice' },
    }));

    const localUrl = vault.get('local').baseUrl;
    const localState = tested('local');
    for (const [id, r] of Object.entries(LOCAL_RUNTIMES)) {
      const p = id === 'ollama' ? ollama : lmstudio;
      const chosen = (localUrl ?? LOCAL_RUNTIMES.ollama.url) === r.url;
      cards.push(card({
        id, provider: 'local', group: 'local', name: r.name, method: 'Runs on this computer, no account',
        status: !p.running ? 'unavailable' : chosen && localState.working ? 'working' : 'untested',
        detail: !p.running ? `${r.name} is not running here. Start it, or install it first.` : p.models.length ? `Models: ${p.models.slice(0, 5).join(', ')}` : 'Running, with no models downloaded yet.',
        installed: p.running ? 'Running' : 'Not detected', account: 'None needed', canTest: p.running && chosen, baseUrl: r.url, chosen, models: p.models ?? [],
        install: { docs: r.docs }, technical: { address: r.url },
      }));
    }

    for (const [provider, def] of Object.entries(DEFS)) cards.push(await connectedCard(provider, def));

    for (const [provider, name] of [['openai', 'OpenAI API'], ['anthropic', 'Anthropic API']]) {
      const block = budget.billingBlock(provider);
      const key = Boolean(vault.get(provider).apiKey);
      const st = tested(provider);
      cards.push(card({
        id: provider, provider, group: 'paid', name, method: 'Your API key, billed per token by the provider',
        status: block ? 'unavailable' : !key ? 'signin' : st.working ? 'working' : 'untested',
        statusText: block ? 'Off: never use paid API' : !key ? 'API key needed' : null,
        detail: block ? 'Paid API is off on this computer. Nothing here will charge you unless you turn it on.' : st.reason,
        installed: 'Built in', account: key ? 'Key saved on this computer' : 'No key', canTest: !block && key, needsKey: true,
      }));
    }
    return { cards, neverPaidApi: budget.status().neverPaidApi, keyStore: vault.storage?.() ?? null };
  }

  /** One card, for any service in ai-connections.cjs. Every word on it is something established. */
  async function connectedCard(provider, def) {
    const creds = vault.get(provider);
    const info = ai?.summary(provider) ?? {};
    const st = tested(provider);
    const tool = def.cli ? await findTool(def.cli) : null;
    const missing = def.fields.filter((f) => !f.optional && !creds[f.name]);
    const account = ai?.providerBlock(provider) ?? null;
    const paidOn = !budget.status().neverPaidApi;
    const cls = ai?.def(provider)?.modelClass ? null : ai?.classOf(provider);
    const usageClass = cls ?? (provider === 'kiro' ? 'subscription' : 'free');
    const status = tool && !tool.installed ? 'notinstalled'
      : tool && tool.signedIn === false ? 'signin'
        : missing.length ? 'signin'
          : account ? 'verify'
            : st.working ? 'working' : st.limited || (st.failed && !missing.length) ? 'error' : 'untested';
    const texts = { verify: 'Verification required' };
    return card({
      id: provider, provider, group: def.group, name: def.name, method: def.method, status,
      statusText: missing.length && !(tool && !tool.installed) ? 'API key needed' : texts[status] ?? null,
      detail: tool && !tool.installed ? `${def.name} is not installed on this computer.` : missing.length ? def.steps[0] : account ?? st.reason,
      installed: tool ? (tool.installed ? tool.version ?? 'Installed' : 'Not installed') : 'Built in',
      account: tool ? (tool.noAccount ? 'None needed for free models' : tool.signedIn == null ? 'Unknown until tested' : tool.signedIn ? 'Signed in' : 'Not signed in') : missing.length ? 'No key' : 'Saved on this computer',
      canTest: !(tool && !tool.installed) && !missing.length && !account && !(tool && tool.signedIn === false),
      needsKey: def.fields.length > 0, fields: def.fields, steps: def.steps, setupUrl: def.setupUrl, isConnected: !missing.length && !(tool && !tool.installed),
      notice: def.notice ?? null, usageNote: def.usage, troubleshoot: def.troubleshoot ?? [],
      connected: true, usageClass, usageLabel: def.modelClass && provider !== 'kiro' ? 'Decided for each model' : USAGE_CLASSES[usageClass],
      verify: def.verify ? Object.entries(def.verify).map(([k, statement]) => ({ class: k, statement, label: USAGE_CLASSES[k] })) : null,
      verified: info.verified, verifyHint: def.verifyHint ?? null, chosenModel: info.chosen, modelCount: info.modelCount, paidAllowed: info.paidAllowed, paidOn,
      install: tool ? { tool: TOOLS[def.cli].install ? def.cli : null, command: TOOLS[def.cli].install ?? null, docs: TOOLS[def.cli].docs } : { docs: def.setupUrl },
      signIn: tool && TOOLS[def.cli].signIn ? { kind: 'tool', tool: def.cli } : null,
      technical: tool ? { path: tool.path ?? 'not found', version: tool.version ?? 'unknown' } : {},
    });
  }

  /** The official tool's own installer, only after the person pressed the button that names it. */
  async function install(tool) {
    const t = TOOLS[tool];
    if (!t?.install) throw new Error('This one installs from its own site.');
    const r = await sh(t.install, 300_000);
    if (!r.ok) throw new Error(`The install failed: ${(r.err || r.out).slice(-400)}`);
    return { ok: true };
  }

  /** Start the official tool's own browser sign-in. It tells us nothing but, later, yes or no. */
  function signIn(tool) {
    const t = TOOLS[tool];
    if (!t?.signIn) throw new Error('There is nothing to sign in to here.');
    const win = process.platform === 'win32';
    const child = spawn(t.cmd(), t.signIn, { shell: win, detached: !win, stdio: 'ignore', windowsHide: false, env: subscriptionEnv() });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  }

  function useLocal(runtime) {
    const r = LOCAL_RUNTIMES[runtime];
    if (!r) throw new Error('Unknown local runtime.');
    vault.set('local', 'baseUrl', r.url);
    return { ok: true };
  }

  return { connections, install, signIn, useLocal, quota };
}

module.exports = { createSetup, findTool, TOOLS, LOCAL_RUNTIMES };
