// Add Worker: Choose the worker → Choose the AI → Official sign-in → Configure → Start working.
//
// A person's password never comes near this. Sign-in happens on the provider's own page or in
// its own tool; this watches the worker on this computer for the answer. Someone on another
// computer than the host cannot be helped from this page, because a remote office must not be
// able to drive their worker, so they get their worker's own page and the same steps there.

import { h, api, toast, modal } from './common.js';
import { statusChip, STATUS, connectForm, verifyForm, modelPicker, GROUPS } from './connections.js';

// Every agent starts able to do everything a player can switch on: files, delegating, running code,
// the web and Git. Switching one off is the choice; having to find and switch each on was the chore.
const ALL_TOOLS = ['messaging', 'files.read', 'files.write', 'memory', 'delegate', 'exec', 'web', 'git'];
const PRESETS = [
  { id: 'developer', name: 'Developer', role: 'Software Developer', skills: ['code', 'testing', 'git'], tools: ALL_TOOLS, blurb: 'Writes and changes code on its own branch.', instructions: 'Work in small, tested steps. Say plainly what you could not finish.' },
  { id: 'reviewer', name: 'Code Reviewer', role: 'Code Reviewer', skills: ['review', 'security', 'quality'], tools: ALL_TOOLS, orchestrationRole: 'reviewer', blurb: 'Reads changes and approves them or asks for fixes.', instructions: 'Review the diff against the goal. Be specific about file and line, and say what is good as well as what is wrong.' },
  { id: 'python', name: 'Python Developer', role: 'Python Developer', skills: ['python', 'testing', 'scripting'], tools: ALL_TOOLS, blurb: 'Writes Python scripts and tools.', instructions: 'Write clear Python with tests. Note any packages you need.' },
  { id: 'researcher', name: 'Researcher', role: 'Researcher', skills: ['research', 'analysis', 'writing'], tools: ALL_TOOLS, blurb: 'Finds things out and writes them up with sources.', instructions: 'Cite where each finding came from, and say how sure you are.' },
  { id: 'qa', name: 'QA Tester', role: 'QA Engineer', skills: ['testing', 'qa', 'bugs'], tools: ALL_TOOLS, orchestrationRole: 'tester', blurb: 'Writes and runs tests, and reports what really happened.', instructions: 'Report only results you observed, with the command and the output.' },
  { id: 'pm', name: 'Project Manager', role: 'Project Manager', skills: ['planning', 'coordination'], tools: ALL_TOOLS, isManager: true, orchestrationRole: 'lead', blurb: 'Plans the work and hands it to the team.', instructions: 'Break the goal into small tasks, each with one clear owner and a way to check it is done.' },
  { id: 'custom', name: 'Custom Agent', role: '', skills: [], tools: ALL_TOOLS, blurb: 'Start from nothing and set it up yourself.', instructions: '' },
];
const STEPS = ['Worker', 'AI', 'Setup', 'Configure', 'Finish'];
const check = (checked, label) => { const c = h('input', { type: 'checkbox', checked }); const row = h('label.cr-check', c, h('span', label)); row.box = c; return row; };

export function addWorkerWizard(ctx) {
  const { S, roomId, ownerOfComputer } = ctx;
  const R = `/api/crew/rooms/${roomId}`;
  const link = ctx.workerLink();
  const state = { step: 0, preset: null, card: null, cards: null, neverPaid: true };

  return modal('Add an agent', (close) => {
    const stepper = h('ol.cr-stepper');
    const page = h('div.cr-wizard-page');
    const root = h('div.cr-wizard', stepper, page);

    const go = (n) => { state.step = n; render(); };
    function render() {
      stepper.replaceChildren(...STEPS.map((s, i) => h('li', { class: i === state.step ? 'on' : i < state.step ? 'done' : '' }, h('span', i + 1), s)));
      page.replaceChildren(h('div.cr-fade', [choosePreset, chooseAi, setup, configure, finish][state.step]()));
    }
    const nav = (back, next) => h('div.actions', back ? h('button.btn', { onclick: () => go(state.step - 1) }, 'Back') : h('button.btn', { onclick: () => close() }, 'Cancel'), next);

    // --- 1. which worker ------------------------------------------------------------------
    function choosePreset() {
      return h('div', h('h3', 'What should it do?'), h('div.cr-preset-grid', ...PRESETS.map((p) => h('button.cr-preset', { class: state.preset?.id === p.id ? 'on' : '', onclick: () => { state.preset = p; go(1); } }, h('b', p.name), h('span.hint', p.blurb)))), nav(false));
    }

    // --- 2. which AI ----------------------------------------------------------------------
    /** Make sure a worker exists here. On the host's computer that takes no terminal. */
    async function ensureWorker() {
      try { await link.get('/status'); } catch {
        if (!ownerOfComputer) return false;
        await api('POST', `${R}/workers/start-here`, { name: 'This computer' });
        await ctx.refreshState();
        return true;
      }
      if (ownerOfComputer && !S.workers.some((w) => w.online)) {
        await api('POST', `${R}/workers/start-here`, { name: 'This computer' });
        await ctx.refreshState();
      }
      return true;
    }

    function chooseAi() {
      const box = h('div', h('p.hint', 'Checking this computer…'));
      (async () => {
        try {
          if (!await ensureWorker()) { box.replaceChildren(remote()); return; }
          const data = await link.get('/setup/connections');
          state.cards = data.cards;
          state.neverPaid = data.neverPaidApi;
          const pick = (c) => h('button.cr-preset.cr-ai', { class: c.status === 'working' ? 'ready' : '', onclick: () => { state.card = c; go(2); } }, h('div.row', h('b.grow', c.name), statusChip(c)), h('span.hint', c.method));
          const group = (g) => data.cards.filter((c) => c.group === g).map(pick);
          box.replaceChildren(
            ...GROUPS.flatMap(([g, title]) => (group(g).length ? [h('h4', title), h('div.cr-preset-grid', ...group(g))] : [])),
            h('details', h('summary', 'Advanced: paid APIs'), h('p.hint', 'Billed per token, separately from any subscription. Nothing ever falls back to these.'), h('div.cr-preset-grid', ...group('paid'))));
        } catch (e) { box.replaceChildren(h('p.error', e.message), h('button.btn', { onclick: render }, 'Try again')); }
      })();
      return h('div', h('h3', 'Which AI should it use?'), box, nav(true));
    }

    /** Joined from another computer: set up the AI on that computer's own worker page. */
    function remote() {
      const providers = S.providers;
      const pick = h('select', ...Object.entries(providers).filter(([k]) => k !== 'scripted').map(([k, p]) => h('option', { value: k, selected: k === 'chatgpt-plan' }, p.label)));
      return h('div',
        h('p', 'Your agents run on your own computer, so sign-ins happen there, not through this office.'),
        h('ol.hint', h('li', 'Install Crew Office on your computer, and open ', h('b', 'Crew Office Worker'), ' from the Start menu.'), h('li', 'Open ', h('a', { href: 'http://127.0.0.1:8790', target: '_blank', rel: 'noopener' }, 'your worker’s page'), ' and sign in to your AI there.'), h('li', 'Connect it to this office under My Crew → Run on another computer.')),
        h('label', 'The AI you will use'), pick,
        h('div.actions', h('button.btn.primary', { onclick: () => { state.card = { provider: pick.value, name: providers[pick.value].label, status: 'untested', remote: true }; go(3); } }, 'Continue')));
    }

    // --- 3. detect and set up --------------------------------------------------------------
    function setup() {
      const box = h('div');
      let timer = null;
      const stop = () => { clearInterval(timer); };
      const continueBtn = h('button.btn.primary', { disabled: true, onclick: () => { stop(); go(3); } }, 'Continue');
      const row = (ok, label, detail) => h('li', { class: ok === true ? 'ok' : ok === false ? 'bad' : '' }, h('span.cr-mark', ok === true ? '✓' : ok === false ? '✕' : '•'), h('span', h('b', label), detail ? h('span.hint', ` ${detail}`) : null));

      const draw = (c) => {
        state.card = c;
        const installed = c.status !== 'notinstalled' && c.status !== 'unavailable';
        const signedIn = !['signin', 'notinstalled'].includes(c.status);
        const refresh = async () => { const { cards } = await link.get('/setup/connections'); const now = cards.find((x) => x.id === c.id); if (now) draw(now); };
        const manual = c.provider === 'claude-handoff';
        const ready = (c.status === 'working' && (!c.connected || Boolean(c.chosenModel) || c.provider === 'kiro')) || (manual && signedIn && installed);
        continueBtn.disabled = !ready;
        const note = h('p.hint');
        const action = (label, fn) => { const b = h('button.btn.primary', label); b.addEventListener('click', async () => { b.disabled = true; try { await fn(note); } catch (e) { note.textContent = e.message; } b.disabled = false; }); return b; };
        const steps = h('div.cr-actions');
        if (c.status === 'notinstalled' && c.install?.tool) steps.append(action(`Install ${c.name}`, async (n) => {
          if (!confirm(`Install ${c.name} by running this on your computer?\n\n${c.install.command}`)) return;
          n.textContent = 'Installing. This can take a few minutes…';
          await link.post('/setup/install', { tool: c.install.tool });
          n.textContent = 'Installed. If it is still not found, close Crew Office and open it again.';
        }));
        if (c.install?.docs && !installed) steps.append(h('a.btn', { href: c.install.docs, target: '_blank', rel: 'noopener' }, 'Official instructions'));
        if (c.status === 'signin' && c.signIn?.kind === 'chatgpt') steps.append(action('Sign in with ChatGPT', async (n) => {
          const { url } = await link.post('/chatgpt/login');
          window.open(url, '_blank', 'noopener');
          n.replaceChildren('Finish on OpenAI’s page. If nothing opened, ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'open it here'), '. This continues by itself.');
        }));
        if (c.status === 'signin' && c.signIn?.kind === 'tool') steps.append(action(`Sign in to ${c.name}`, async (n) => {
          await link.post('/setup/signin', { tool: c.signIn.tool });
          n.textContent = `${c.name} opened its own sign-in. Finish it there. This continues by itself.`;
        }));
        const guided = [];
        if (c.connected && c.needsKey && c.statusText === 'API key needed') guided.push(connectForm(link, c, refresh));
        if (c.connected && !c.needsKey && c.status === 'notinstalled') guided.push(h('ol.hint', ...c.steps.map((s) => h('li', s))));
        if (c.connected && c.status === 'verify') guided.push(h('h4', 'Check your account first'), verifyForm(link, c, refresh));
        if (c.connected && c.isConnected && c.status !== 'verify' && c.provider !== 'kiro') guided.push(h('h4', 'Choose a model'), modelPicker(link, c, { onPick: (m) => { state.model = m.id; refresh(); } }));
        if (c.needsKey && c.status === 'unavailable') steps.append(h('p.cr-provider-note', 'Paid API is off, so this cannot be used. To allow it, turn off “Never use paid API” under Connections. Only agents you set to it would ever use it.'));
        if (c.canTest && c.status !== 'working') steps.append(action('Run a real test', async (n) => {
          n.textContent = 'Sending one small real request…';
          const r = await link.post('/test', { provider: c.provider });
          n.textContent = r.ok ? r.reason : `That failed: ${r.reason}`;
        }));
        box.replaceChildren(...[
          h('h3', `Setting up ${c.name}`),
          h('ul.cr-checklist',
            row(installed, 'Installed', c.installed),
            c.technical?.path && c.technical.path !== 'not found' ? row(true, 'Found on this computer', c.technical.path) : null,
            row(signedIn ? true : installed ? false : null, c.group === 'local' ? 'No account needed' : /^None needed/.test(c.account ?? '') ? 'No account needed' : c.fields?.length && !c.signIn ? 'Key saved' : 'Signed in', c.account),
            manual ? row(signedIn && installed ? true : null, 'Runs by hand', 'You run each task in Claude Code') : row(c.status === 'working' ? true : null, 'A real test got an answer', c.status === 'working' ? null : 'Not yet')),
          c.detail ? h('p', c.detail) : null, c.notice ? h('p.cr-provider-note', c.notice) : null, ...guided, steps, note, nav(true, continueBtn)].filter(Boolean));
      };
      draw(state.card);
      // Whatever the person does in the provider's own window, this notices and moves on.
      timer = setInterval(async () => {
        if (!box.isConnected) { stop(); return; }
        try {
          const { cards } = await link.get('/setup/connections');
          const now = cards.find((x) => x.id === state.card.id);
          if (now && (now.status !== state.card.status || now.account !== state.card.account) && !box.querySelector('input:focus')) { toast(`${now.name}: ${STATUS[now.status]?.label}`); draw(now); }
        } catch { /* the worker is restarting */ }
      }, 3000);
      return box;
    }

    // --- 4. configure ----------------------------------------------------------------------
    function configure() {
      const p = state.preset;
      const name = h('input', { value: p.id === 'custom' ? '' : p.name, placeholder: 'What should they be called?', maxLength: 40 });
      const color = h('input', { type: 'color', value: ['#3d85c6', '#9b5de5', '#2a9d8f', '#e07a5f', '#f15bb5'][Math.floor(Math.random() * 5)] });
      const role = h('input', { value: p.role, placeholder: 'e.g. Backend Developer' });
      const instructions = h('textarea', { value: p.instructions, rows: 3, placeholder: 'How they should work. Only you can see this.' });
      const tools = Object.entries(S.permissions).map(([k, label]) => { const r = check(p.tools.includes(k), `${k}: ${label}`); r.k = k; return r; });
      const tests = check(true, 'Run suitable tests before marking work done');
      const review = check(true, 'Have another agent review before merging');
      const approval = h('select', ...[['balanced', 'Balanced: ask me before merges'], ['manual', 'Manual: ask me for every risky step'], ['autonomous', 'Autonomous: ask only for deletes and rollbacks']].map(([v, l]) => h('option', { value: v }, l)));
      const playbook = h('select', h('option', { value: '' }, 'None yet'), ...ctx.playbooks().map((x) => h('option', { value: x.id }, x.name)));
      const err = h('p.error');
      const create = async () => {
        err.textContent = '';
        try {
          const model = state.model ?? state.card.chosenModel ?? S.providers[state.card.provider]?.defaultModel;
          const { agent } = await api('POST', `${R}/agents`, { name: name.value, role: role.value, skills: p.skills, instructions: instructions.value, provider: state.card.provider, model, color: color.value, tools: tools.filter((t) => t.box.checked).map((t) => t.k), isManager: Boolean(p.isManager) });
          if (p.orchestrationRole) await api('PUT', `${R}/agents/${agent.id}/profile`, { orchestrationRole: p.orchestrationRole });
          await api('PUT', `${R}/rules/agent/${agent.id}`, { rules: { approvalMode: approval.value, testsBeforeDone: tests.box.checked, requireReview: review.box.checked } });
          if (playbook.value) await ctx.addToPlaybook(playbook.value, agent);
          await ctx.refreshState();
          state.agent = agent;
          go(4);
        } catch (e) { err.textContent = e.message; }
      };
      return h('div', h('h3', 'Set them up'),
        h('div.row.cr-two', h('div.cr-field.grow', h('label', 'Name'), name), h('div.cr-field', h('label', 'Colour'), color)),
        h('div.cr-field', h('label', 'Role'), role), h('div.cr-field', h('label', 'Instructions'), instructions),
        h('div.cr-field', h('label', 'Approval policy'), approval), tests, review,
        h('div.cr-field', h('label', 'Git workspace'), h('p.hint', 'Automatic. Each task gets its own clone and branch on your worker, and merges through review.')),
        h('div.cr-field', h('label', 'Playbook'), playbook),
        h('details', h('summary', 'Tools they may use'), h('div.cr-checks', ...tools)),
        err, nav(true, h('button.btn.primary', { onclick: create }, 'Create')));
    }

    // --- 5. finish -------------------------------------------------------------------------
    function finish() {
      const a = S.agents.find((x) => x.id === state.agent.id) ?? state.agent;
      return h('div.cr-wizard-done', h('div.cr-done-mark', '✓'), h('h3', `${a.name} is on the team`),
        h('p.hint', a.available ? 'They are in the office now.' : 'They appear in the office once your worker is connected and you are here.'),
        h('div.actions.center', h('button.btn', { onclick: () => close() }, 'Done'), h('button.btn.primary', { onclick: () => { close(); ctx.firstTask(a); } }, 'Give them a first task')));
    }

    render();
    return root;
  });
}
