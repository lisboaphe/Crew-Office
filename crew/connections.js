// The AI Connections and Usage screens. Both talk straight to the worker on this computer, not
// to the room host, which is why a sign-in or a usage figure never reaches anyone else. The same
// module runs in the office and on the worker's own page.

import { h, toast, modal } from './common.js';

export function workerLink(base = 'http://127.0.0.1:8790') {
  const req = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The worker answered ${res.status}.`);
    return data;
  };
  return { base, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b ?? {}) };
}

export const STATUS = {
  working: { label: 'Working', tone: 'ok' },
  untested: { label: 'Connected, not tested', tone: 'info' },
  signin: { label: 'Sign-in required', tone: 'warn' },
  verify: { label: 'Verification required', tone: 'warn' },
  notinstalled: { label: 'Not installed', tone: 'muted' },
  unavailable: { label: 'Unavailable', tone: 'muted' },
  error: { label: 'Error', tone: 'bad' },
};

export const GROUPS = [
  ['subscription', 'My subscriptions', 'Your own plan, through the provider’s official route.'],
  ['free', 'Free and developer AI', 'Your own account, on a service’s free or developer allowance. Nothing runs here until it is established that it costs nothing.'],
  ['cloud', 'Other cloud providers', 'Hosted services where most models cost money. Only what is free or included runs.'],
  ['local', 'Local AI', 'Runs on this computer. No account and no charges.'],
];

export function statusChip(card) {
  const s = STATUS[card.status] ?? STATUS.error;
  return h('span.cr-status-chip', { class: s.tone }, h('span.dot'), card.statusText ?? s.label);
}

const TROUBLESHOOT = {
  'chatgpt-plan': ['Port 1455 has to be free during sign-in. Close anything else using it, such as a Codex login in progress.', 'If a test says plan usage is not available, your account or plan may not include it. The message is OpenAI’s.', 'Cap or review this app’s use in ChatGPT Settings → Usage.'],
  'codex-cli': ['Install Codex, then press Sign in. It opens OpenAI’s own page.', 'If it was just installed, restart your worker so it can find the command.'],
  'claude-handoff': ['Install Claude Code, then press Sign in. It opens Anthropic’s own page.', 'If it was just installed, restart your worker so it can find the command.', 'Tasks then appear on this page with the folder to run them in.'],
  ollama: ['Start Ollama, then pull a model with its own app.', 'It listens at http://127.0.0.1:11434.'],
  lmstudio: ['Start LM Studio and turn on its local server.', 'It listens at http://127.0.0.1:1234.'],
  openai: ['This bills per token, separately from any ChatGPT plan.', 'It stays off until you turn off “Never use paid API”.'],
  'openrouter-free': ['Get a key at openrouter.ai/keys and press Configure.', 'If a free model will not use tools, the agent cannot do much: try a specific model ending in :free.', 'A limit here pauses the work, or moves it to a backup you chose.'],
  anthropic: ['This bills per token, separately from any Claude plan.', 'It stays off until you turn off “Never use paid API”.'],
};

const fmtContext = (n) => (n ? `${n >= 1000 ? `${Math.round(n / 1000)}k` : n} tokens` : 'Not reported');
const fmtYes = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Not reported');

/** Guided connection: the service's own page, how to get a key, and a check that it works. */
export function connectForm(link, card, done) {
  const note = h('p.hint');
  const inputs = card.fields.map((f) => { const i = h('input', { type: f.secret ? 'password' : 'text', autocomplete: 'off', placeholder: card.isConnected ? 'Saved. Enter a new value to replace it.' : f.optional ? 'Optional' : '' }); i.dataset.field = f.name; return [f, i]; });
  const save = h('button.btn.primary', 'Save and check');
  save.addEventListener('click', async () => {
    save.disabled = true; note.textContent = 'Asking the service…';
    try {
      const r = await link.post('/ai/connect', { provider: card.provider, ...Object.fromEntries(inputs.map(([f, i]) => [f.name, i.value])) });
      note.textContent = r.ok ? `Saved on this computer. The service lists ${r.models.length} models.` : `Saved, but the service said: ${r.reason}`;
      for (const [, i] of inputs) i.value = '';
      done?.(r);
    } catch (e) { note.textContent = e.message; }
    save.disabled = false;
  });
  return h('div.cr-connect',
    h('ol.hint', ...card.steps.map((s) => h('li', s))),
    h('p', h('a.btn.small', { href: card.setupUrl, target: '_blank', rel: 'noopener' }, `Open ${card.name}`)),
    ...inputs.map(([f, i]) => h('div.cr-field', h('label', f.label), i)),
    inputs.length ? h('p.hint', 'Encrypted on this computer, and sent only to this service. It never reaches the office host or other players.') : null,
    inputs.length ? h('div.actions', save) : null, note);
}

/** The owner looks at their own account, and says so. Until then it runs nothing. */
export function verifyForm(link, card, done) {
  const note = h('p.error');
  return h('div.cr-verify',
    h('p.hint', card.verifyHint),
    ...card.verify.map((v) => {
      const box = h('input', { type: 'checkbox' });
      const go = h('button.btn.primary', { disabled: true }, 'Confirm');
      box.addEventListener('change', () => { go.disabled = !box.checked; });
      go.addEventListener('click', async () => { try { await link.post('/ai/verify', { provider: card.provider, class: v.class }); done?.(); } catch (e) { note.textContent = e.message; } });
      return h('div', h('label.cr-check', box, h('span', v.statement)), h('div.actions', go));
    }), note);
}

/** Every model the service reported, with what it reported, and “Not reported” for the rest. */
export function modelPicker(link, card, { onPick = null } = {}) {
  const root = h('div.cr-models', h('p.hint', 'Asking the service…'));
  const draw = (data) => {
    if (!data.models.length) { root.replaceChildren(h('p.hint', 'No models listed yet.'), refresh()); return; }
    const row = (m) => {
      const pick = h('button.btn.small', { disabled: Boolean(m.blocked), title: m.blocked ?? '', class: m.id === data.chosen ? 'primary' : '' }, m.id === data.chosen ? 'Chosen' : 'Use');
      pick.addEventListener('click', async () => {
        try { await link.post('/ai/choose', { provider: card.provider, model: m.id }); onPick?.(m); data.chosen = m.id; draw(data); toast(`${m.name} chosen`); } catch (e) { toast(e.message); }
      });
      return h('tr', { class: m.blocked ? 'blocked' : '' }, h('td', h('b', m.name), m.name !== m.id ? h('div.hint', m.id) : null), h('td', fmtContext(m.context)), h('td', fmtYes(m.tools)), h('td', fmtYes(m.streaming)), h('td', fmtYes(m.reasoning)), h('td', m.coding), h('td', h('span.cr-usage-class', { class: m.usage }, m.usageLabel)), h('td', m.rateLimit ?? 'Not reported'), h('td', pick));
    };
    root.replaceChildren(
      h('div.cr-models-wrap', h('table', h('thead', h('tr', ...['Model', 'Context', 'Tools', 'Streaming', 'Reasoning', 'For coding', 'Cost', 'Rate limit', ''].map((c) => h('th', c)))), h('tbody', ...data.models.map(row)))),
      h('p.hint', `${data.source ?? ''}. Anything a service did not report says so, rather than being guessed.`), refresh());
  };
  const refresh = () => h('button.btn.small', { onclick: () => load(true) }, 'Refresh from the service');
  const load = async (force) => {
    root.replaceChildren(h('p.hint', 'Asking the service…'));
    try {
      let data = await link.get(`/ai/models?provider=${encodeURIComponent(card.provider)}`);
      if (force || !data.models.length) data = await link.get(`/ai/models?provider=${encodeURIComponent(card.provider)}&refresh=1`);
      draw(data);
    } catch (e) { root.replaceChildren(h('p.error', e.message), refresh()); }
  };
  load(false);
  return root;
}

function configureModal(link, card, reload) {
  modal(`Configure ${card.name}`, (close) => h('div.cr-configure',
    connectForm(link, card, () => reload()),
    card.verify ? h('details', { open: !card.verified }, h('summary', h('b', card.verified ? 'Your confirmation' : 'Confirm your account')),
      card.verified
        ? h('div', h('p.hint', `You confirmed this on ${new Date(card.verified.at).toLocaleDateString()}. If your account has changed, remove it.`), h('button.btn.small', { onclick: async () => { await link.post('/ai/unverify', { provider: card.provider }); close(); reload(); } }, 'Remove my confirmation'))
        : verifyForm(link, card, () => { close(); reload(); })) : null,
    card.paidOn && !card.verify ? h('details', h('summary', 'Paid models'), (() => {
      const box = h('input', { type: 'checkbox', checked: card.paidAllowed });
      box.addEventListener('change', async () => {
        if (box.checked && !confirm(`Let agents you set to a paid model on ${card.name} run and charge your account?\n\nNothing switches to a paid model by itself.`)) { box.checked = false; return; }
        await link.post('/ai/allow-paid', { provider: card.provider, allowed: box.checked }); reload();
      });
      return h('label.cr-check', box, h('span', 'Allow paid models on this connection'));
    })()) : null,
    h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'))));
}

function connectionCard(link, card, reload) {
  const note = h('p.hint.cr-card-note');
  const busy = (button, text, fn) => async () => {
    const was = button.textContent;
    button.disabled = true; button.textContent = text; note.textContent = '';
    try { await fn(); } catch (e) { note.textContent = e.message; note.classList.add('bad'); }
    button.disabled = false; button.textContent = was;
  };
  const actions = h('div.cr-actions');
  const add = (label, cls, onclick) => { const b = h(`button.btn.small${cls}`, label); b.addEventListener('click', onclick(b)); actions.append(b); return b; };

  if (card.status === 'signin' && card.signIn?.kind === 'chatgpt') {
    add('Sign in with ChatGPT', '.primary', (b) => busy(b, 'Opening…', async () => {
      const { url } = await link.post('/chatgpt/login');
      window.open(url, '_blank', 'noopener');
      note.replaceChildren('Finish on OpenAI’s page. If nothing opened, ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'open it here'), '. This updates by itself.');
      pollUntilChanged(link, card, reload);
    }));
  }
  if (card.status === 'signin' && card.signIn?.kind === 'tool') {
    add('Sign in', '.primary', (b) => busy(b, 'Opening…', async () => {
      await link.post('/setup/signin', { tool: card.signIn.tool });
      note.textContent = `${card.name} opened its own sign-in. Finish it there. This updates by itself.`;
      pollUntilChanged(link, card, reload);
    }));
  }
  if (card.status === 'notinstalled' && card.install?.tool) {
    add('Install', '.primary', (b) => busy(b, 'Installing…', async () => {
      if (!confirm(`Install ${card.name} by running this on your computer?\n\n${card.install.command}`)) return;
      await link.post('/setup/install', { tool: card.install.tool });
      note.textContent = 'Installed. If it is still not found, restart your worker.';
      reload();
    }));
  }
  if (card.install?.docs && ['notinstalled', 'unavailable'].includes(card.status)) actions.append(h('a.btn.small', { href: card.install.docs, target: '_blank', rel: 'noopener' }, 'Official site'));
  if (card.group === 'local' && card.status !== 'unavailable' && !card.chosen) {
    add('Use this one', '', (b) => busy(b, 'Saving…', async () => { await link.post('/setup/local', { runtime: card.id }); reload(); }));
  }
  if (card.connected) {
    add('Configure', card.status === 'signin' && card.needsKey || card.status === 'verify' ? '.primary' : '', () => () => configureModal(link, card, reload));
    if (card.isConnected) add('Models', '', () => () => modal(`${card.name} models`, (close) => h('div', modelPicker(link, card, { onPick: () => reload() }), h('div.actions', h('button.btn', { onclick: () => close() }, 'Close')))));
  } else if (card.needsKey && !card.statusText?.startsWith('Off')) {
    add('Configure', '', () => () => askForKey(link, card, reload));
  }
  if (card.canTest) {
    add('Test Connection', card.status === 'untested' ? '.primary' : '', (b) => busy(b, 'Testing…', async () => {
      const r = await link.post('/test', { provider: card.provider });
      note.textContent = r.ok ? r.reason : `Failed: ${r.reason}`;
      note.classList.toggle('bad', !r.ok);
      if (r.ok) reload();
    }));
  }
  if (card.connected && card.isConnected) {
    add('Disconnect', '', (b) => busy(b, 'Removing…', async () => {
      if (!confirm(`Disconnect ${card.name}?${card.fields.length ? ' Its saved key is deleted from this computer.' : ''}`)) return;
      const r = await link.post('/ai/disconnect', { provider: card.provider });
      if (r.cli) toast(`${card.name} stays installed, and signed in to its own app.`);
      reload();
    }));
  }
  if (card.provider === 'chatgpt-plan' && card.account === 'Signed in') {
    add('Disconnect', '', (b) => busy(b, 'Signing out…', async () => { if (confirm('Sign out of ChatGPT on this worker?')) { await link.post('/chatgpt/logout'); reload(); } }));
  }
  if (!card.connected && card.needsKey && card.account === 'Key saved on this computer') {
    add('Disconnect', '', (b) => busy(b, 'Removing…', async () => { if (confirm(`Delete the saved ${card.name} key from this computer?`)) { await link.post('/keys', { provider: card.provider, apiKey: '' }); reload(); } }));
  }

  const details = h('details.cr-card-more', h('summary', 'Troubleshoot and details'),
    h('ul.hint', ...(card.troubleshoot ?? TROUBLESHOOT[card.id] ?? []).map((t) => h('li', t))),
    Object.keys(card.technical).length ? h('dl.cr-kv', ...Object.entries(card.technical).flatMap(([k, v]) => [h('dt', k), h('dd', h('code', String(v)))])) : null);

  return h('article.cr-conn-card',
    h('div.cr-conn-head', h('b', card.name), statusChip(card)),
    h('p.hint', card.method),
    h('dl.cr-kv.tight', h('dt', 'Installed'), h('dd', card.installed), h('dt', 'Account'), h('dd', card.account),
      card.connected ? [h('dt', 'Cost'), h('dd', h('span.cr-usage-class', { class: card.usageClass }, card.status === 'verify' ? 'Verification required' : card.usageLabel)),
        h('dt', 'Models'), h('dd', card.chosenModel ? `${card.chosenModel} chosen${card.modelCount ? `, of ${card.modelCount}` : ''}` : card.modelCount != null ? `${card.modelCount} listed, none chosen` : 'Not listed yet'),
        h('dt', 'Usage'), h('dd', card.usageNote)] : []),
    card.detail ? h('p.cr-conn-detail', card.detail) : null,
    card.notice ? h('p.cr-provider-note', card.notice) : null,
    actions, note, details);
}

function askForKey(link, card, reload) {
  modal(`${card.name} key`, (close) => {
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Stored encrypted on this computer' });
    const save = async () => { await link.post('/keys', { provider: card.provider, apiKey: key.value }); close(); reload(); };
    return h('div', h('p.hint', 'This is billed per token by the provider. It stays on this computer and never reaches the office host.'), key,
      h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
  });
}

function pollUntilChanged(link, card, reload, tries = 60) {
  const timer = setInterval(async () => {
    if (--tries <= 0) { clearInterval(timer); return; }
    try {
      const { cards } = await link.get('/setup/connections');
      const now = cards.find((c) => c.id === card.id);
      if (now && now.status !== card.status) { clearInterval(timer); toast(`${card.name}: ${STATUS[now.status]?.label}`); reload(); }
    } catch { /* the worker restarted */ }
  }, 3000);
}

/** This computer's own controls. They work whether or not any office can be reached. */
async function safetyPanel(link, reload) {
  const s = await link.get('/sandbox');
  const stop = h('button.btn', { class: s.localStop ? '' : 'cr-stop', onclick: async () => { await link.post('/stop', { stopped: !s.localStop }); toast(s.localStop ? 'This computer is working again' : 'All AI on this computer is stopped'); reload(); } }, s.localStop ? 'Resume AI on this computer' : 'STOP ALL AI ON THIS COMPUTER');
  const weak = h('input', { type: 'checkbox', checked: s.allowWeakSandbox });
  weak.addEventListener('change', async () => {
    if (weak.checked && !confirm('Run code from other players without Docker?\n\nIt would run under Node’s permission model and a network guard. Node says this is not a defence against deliberately malicious code. Only accept this for people you trust.')) { weak.checked = false; return; }
    await link.post('/settings', { allowWeakSandbox: weak.checked });
    reload();
  });
  return h('section.cr-conn-group',
    h('div.row', h('h3.grow', 'This computer'), stop),
    s.localStop ? h('p.cr-provider-note', 'Stopped here. No agent will run on this computer until you resume, whatever any office asks.') : null,
    s.docker
      ? h('p.hint', 'Docker is available, so code from other players runs in a throwaway container with no network.')
      : [h('p.cr-provider-note', 'Docker is not installed. Tests and scripts in shared projects are refused here, so other players’ code cannot run on this computer. Your own solo projects are unaffected. Install Docker Desktop to run shared tests safely.'),
        h('label.cr-switch', weak, h('span', ' Run other players’ code without Docker'), h('span.hint', ' Weaker. Only for people you trust.'))]);
}

/** The whole screen. `offline` is what to show when no worker answers here. */
export function connectionsView(link, { offline = null, onChange = null } = {}) {
  const root = h('div.cr-connections', h('p.hint', 'Checking this computer…'));
  const load = async () => {
    let data;
    try { data = await link.get('/setup/connections'); } catch {
      root.replaceChildren(h('div.cr-empty', h('h3', 'Your worker is not running'), h('p.hint', 'It runs your agents and holds your sign-ins, on this computer. Without it there is nothing to connect yet.'), offline ? offline(load) : null));
      return;
    }
    onChange?.(data);
    const section = ([key, title, hint]) => {
      const cards = data.cards.filter((c) => c.group === key);
      return h('section.cr-conn-group', h('h3', title), h('p.hint', hint), h('div.cr-conn-grid', ...cards.map((c) => connectionCard(link, c, load))));
    };
    const paid = data.cards.filter((c) => c.group === 'paid');
    const keptIn = data.keyStore ? h('p.hint', `Keys on this computer are encrypted, with the key to them held by: ${data.keyStore}.`) : null;
    const neverPaid = h('input', { type: 'checkbox', checked: data.neverPaidApi });
    neverPaid.addEventListener('change', async () => {
      if (!neverPaid.checked && !confirm('Allow agents set to a paid API to run and charge your key?\n\nNothing switches to a paid API by itself: only agents you set to one will use it.')) { neverPaid.checked = true; return; }
      await link.post('/settings', { neverPaidApi: neverPaid.checked });
      load();
    });
    root.replaceChildren(await safetyPanel(link, load), keptIn ?? '', ...GROUPS.map(section),
      h('details.cr-conn-group', h('summary', h('b', 'Advanced: paid APIs')),
        h('label.cr-switch', neverPaid, h('b', ' Never use paid API'), h('span.hint', ' On by default. No agent ever falls back to these; a subscription limit pauses the work.')),
        h('div.cr-conn-grid', ...paid.map((c) => connectionCard(link, c, load)))));
  };
  load();
  root.reload = load;
  return root;
}

// --- usage ---------------------------------------------------------------------------------

const when = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'not reported');

export function usageBar(usedPercent, { small = false } = {}) {
  const tone = usedPercent >= 90 ? 'bad' : usedPercent >= 75 ? 'warn' : 'ok';
  return h('div.cr-usage-bar', { class: `${tone}${small ? ' small' : ''}`, role: 'progressbar', 'aria-valuenow': Math.round(usedPercent), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: { width: `${Math.min(100, usedPercent)}%` } }));
}

/** Allowance and everything else kept apart, each named for what it is. */
export function usageView(link, { offline = null, agents = [] } = {}) {
  const root = h('div.cr-usage', h('p.hint', 'Reading usage…'));
  const names = { 'openrouter-free': 'OpenRouter free models', 'chatgpt-plan': 'ChatGPT plan', 'codex-cli': 'Codex', 'claude-cli': 'Claude Code', 'claude-handoff': 'Claude Code (manual)', local: 'Local model', openai: 'OpenAI API', anthropic: 'Anthropic API' };

  function providerCard(id, data, cards) {
    const reported = data.reported[id];
    const local = data.local[id];
    const card = cards.find((c) => c.provider === id);
    const running = agents.filter((a) => a.provider === id && ['WORKING', 'PLANNING', 'REVIEW', 'ASSIGNED'].includes(a.status));
    const warnAt = local?.warnAt ?? [50, 75, 90];
    const toggles = [50, 75, 90, 100].map((n) => {
      const box = h('input', { type: 'checkbox', checked: warnAt.includes(n) });
      box.addEventListener('change', async () => {
        const next = [50, 75, 90, 100].filter((x) => (x === n ? box.checked : warnAt.includes(x)));
        await link.post('/settings', { provider: { name: id, warnAt: next } });
        load();
      });
      return h('label.cr-inline', box, ` ${n}%`);
    });
    const pause = h('input', { type: 'number', min: 1, max: 100, value: local?.pauseAtPercent ?? '', placeholder: 'off', style: { width: '76px' } });
    pause.addEventListener('change', async () => { await link.post('/settings', { provider: { name: id, pauseAtPercent: pause.value } }); toast('Saved'); });
    return h('article.cr-conn-card',
      h('div.cr-conn-head', h('b', card?.name ?? names[id] ?? id), card ? statusChip(card) : null),
      h('h4', 'Allowance'),
      reported
        ? [...Object.entries(reported.windows).map(([name, w]) => h('div.cr-usage-window',
            h('div.row', h('span.grow', name), h('b', `${Math.round(w.usedPercent)}% used`)), usageBar(w.usedPercent), h('p.hint', `Resets ${when(w.resetsAt)}`))),
          h('p.hint', `${reported.source}, ${when(reported.observedAt)}.${reported.stale ? ' This reading is old: it updates when an agent next runs here.' : ''}`),
          h('div.cr-usage-policy', h('span.hint', 'Warn me at'), ...toggles),
          h('div.cr-usage-policy', h('span.hint', 'Pause new tasks at'), pause, h('span.hint', '% of a reported limit')) ]
        : [h('p', h('b', 'Usage unavailable')), h('p.hint', card?.usageNote ?? id === 'chatgpt-plan' ? 'OpenAI does not publish a way for apps to read plan usage. See ChatGPT Settings → Usage for the real figure. A limit still pauses the work when OpenAI reports it.' : 'The provider has not reported a figure to this worker yet, and none is guessed.')],
      h('h4', 'On this computer'),
      h('dl.cr-kv.tight',
        h('dt', 'Requests made here'), h('dd', local ? `${local.requestsInWindow} this ${local.window === 'weekly' ? 'week' : local.window === 'daily' ? 'day' : '5 hours'}` : 'none yet'),
        h('dt', 'Tokens counted here'), h('dd', local?.tokensInWindow ? local.tokensInWindow.toLocaleString() : 'None reported'),
        h('dt', 'Credit balance'), h('dd', 'Usage unavailable: this app does not read balances'),
        h('dt', 'Agents running now'), h('dd', String(local?.running ?? running.length)),
        h('dt', 'Your own estimate'), h('dd', local?.capacity ? `${local.estimatedPct}% of the ${local.capacity} you estimated (not the provider’s figure)` : 'none set')));
  }

  const load = async () => {
    let data, cards;
    try { [data, { cards }] = await Promise.all([link.get('/usage'), link.get('/setup/connections')]); } catch {
      root.replaceChildren(h('div.cr-empty', h('h3', 'Your worker is not running'), h('p.hint', 'Usage is read from the worker on this computer.'), offline ? offline(load) : null));
      return;
    }
    const inUse = new Set([...Object.keys(data.reported), ...Object.keys(data.local), ...agents.map((a) => a.provider), ...cards.filter((c) => c.group !== 'paid' && c.status === 'working').map((c) => c.provider)]);
    inUse.delete('scripted');
    const saver = h('input', { type: 'checkbox', checked: data.tokenSaver !== false });
    saver.addEventListener('change', async () => { await link.post('/settings', { tokenSaver: saver.checked }); toast('Saved'); });
    root.replaceChildren(...[
      h('section.cr-conn-group', h('label.cr-switch', saver, h('b', ' Token saver'), h('span.hint', ` Keeps long command output and old results out of prompts, with a note wherever something was left out. ${(data.savedChars ?? 0).toLocaleString()} characters kept out so far (measured).`))),
      h('div.cr-conn-grid', ...[...inUse].map((id) => providerCard(id, data, cards))),
      !inUse.size ? h('p.hint', 'Nothing has run on this computer yet.') : null,
      h('p.hint', 'Plan allowance, context size, tokens, API costs and task budgets are different things and are never converted into each other. Tokens and task budgets are under Task costs.')].filter(Boolean));
  };
  load();
  root.reload = load;
  return root;
}
