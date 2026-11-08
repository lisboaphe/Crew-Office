// "How it works": a short, step-by-step tour of the office for someone who has never seen
// it. Shown once automatically (per browser), and any time from the How it works button.
// In the office, a step can point at the real thing ("Show me") instead of describing it.

import { h } from './common.js';

const SEEN_KEY = 'crew.tutorialSeen';

/** Each step: an icon, a title, a few short lines, and optionally where "Show me" goes. */
const STEPS = [
  {
    icon: '🏢', title: 'Welcome to Crew Office',
    lines: [
      'This is a shared office. Every player brings their own team of AI employees.',
      'You give the office a project; the agents plan it, talk to each other, write the files, test and review them — and you watch it happen on the floor.',
      'Nothing on the floor is pretend: every character movement is something an agent actually did.',
    ],
  },
  {
    icon: '🎮', title: 'Host or join, like a game lobby',
    lines: [
      'Host Office runs the office on your computer. Give it a name, a password and a player limit.',
      'Friends join with an invitation link or a room code, or by finding it on your network. Nobody has to touch a router or install a VPN.',
      'Over the internet this goes through a connectivity service. If none is reachable, Host Office says so and offers no link.',
    ],
    show: 'room',
  },
  {
    icon: '🤖', title: 'Build your AI team',
    lines: [
      'Open the menu on the left, then AI Management → Agents → Add an agent. Give it a name, a role (Backend Developer, QA Engineer…), skills and instructions.',
      'Pick the AI behind each agent: your ChatGPT plan (Sign in with ChatGPT, or the Codex app), your Claude plan (you run each task in your own Claude Code), a local model, or an API key. Mix them freely.',
      'Only you can change, pause or remove your agents — not even the office owner can.',
    ],
    show: 'agents',
  },
  {
    icon: '🔌', title: 'Connect your worker',
    lines: [
      'Your agents run on your own computer through a small “worker” program, with your own logins and keys.',
      'Agents → My Crew. On the computer hosting the office, the app starts your worker for you. On another computer, press Run on another computer.',
      'Your sign-ins and keys never leave your computer, and paid API use is off unless you turn it on there. Limits pause work; they never turn into charges. When you leave the office your agents leave too, unless the worker is always-on.',
    ],
    show: 'crew',
  },
  {
    icon: '📋', title: 'Start a project',
    lines: [
      'New project: a name, a goal (“Build a simple task management web app”) and one of your agents as the manager.',
      'Lend it your agents — you choose what they may do there, how much they may spend, and whether others need your OK to give them work. Friends lend theirs.',
      'Press Start. The manager writes a plan of tasks, each given to the best-suited agent.',
    ],
    show: 'projects',
  },
  {
    icon: '🌿', title: 'Share code with Git, not ZIPs',
    lines: [
      'Git / Sync → New repository. It is hosted right here in the office; GitHub is not needed.',
      'Each agent works in its own copy on its own branch. Smart Sync runs the tests, commits and pushes; nobody else’s work is touched.',
      'Another agent reviews the real diff and can ask for changes. `main` only changes through a reviewed merge. Big files like releases go in Office files.',
    ],
    show: 'git',
  },
  {
    icon: '✅', title: 'Approve the work',
    lines: [
      'You approve the plan. Each player approves the work assigned to their own agents.',
      'Working Rules sets how much asks first: Manual, Balanced or Autonomous. Deleting shared files always asks. The tick at the top shows a red number when something waits for you.',
      'A task only counts as done when the agent hands in proof — the files it made or a test run — and the office checks it.',
    ],
    show: 'approvals',
  },
  {
    icon: '👀', title: 'Watch the office',
    lines: [
      'Agents sit at their desk and type while they work, and take a break by the sofa or the kitchen when they have nothing on.',
      'The tag above each head says what it is doing right now: Thinking, Reading server.js, Asking Boris, Idle.',
      'Speech bubbles are real messages between agents. Click any character to open its control panel.',
    ],
  },
  {
    icon: '🧭', title: 'Getting around',
    lines: [
      'The dock on the left edge is the menu. Rest the mouse on it and it opens, and it stays open until you click somewhere else or press Esc.',
      'The Orchestrator has its own guided tour, for drawing who does what and in what order. Find it on the Orchestrator page.',
      'Memory & Knowledge keeps what your team has learned and a map of your code, each switched on per project.',
    ],
    show: 'memory',
  },
  {
    icon: '💬', title: 'Chat, results and costs',
    lines: [
      'Chat has a channel per project. Messages are marked human or AI. Write @Name to address an agent.',
      'Deliverables holds every file the agents produced, including the final SUMMARY.md.',
      'Costs shows each agent’s spending against its budget. That’s it — have fun!',
    ],
    show: 'deliverables',
  },
];

/**
 * Open the tour. `showMe(target)` is called for a step's "Show me" (office only); without
 * it those buttons are not drawn.
 */
export function openTutorial({ showMe = null, start = 0 } = {}) {
  let i = start;
  const back = h('div.cr.cr-modal-back');
  const box = h('div.cr-modal.cr-tour', { role: 'dialog', 'aria-label': 'How Crew Office works' });
  back.append(box);
  const close = () => { back.remove(); document.removeEventListener('keydown', keys); try { localStorage.setItem(SEEN_KEY, '1'); } catch {} };
  const keys = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight' && i < STEPS.length - 1) { i++; draw(); }
    if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
  };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', keys);

  function draw() {
    const s = STEPS[i];
    const last = i === STEPS.length - 1;
    box.replaceChildren(
      h('div.cr-tour-head', h('span.cr-tour-step', `Step ${i + 1} of ${STEPS.length}`), h('button.btn.small', { onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div.cr-tour-icon', { 'aria-hidden': 'true' }, s.icon),
      h('h2', s.title),
      h('ul.cr-tour-lines', ...s.lines.map((l) => h('li', l))),
      h('div.cr-tour-dots', ...STEPS.map((_, k) => h('button', { class: k === i ? 'on' : '', 'aria-label': `Step ${k + 1}`, onclick: () => { i = k; draw(); } }))),
      h('div.actions',
        showMe && s.show ? h('button.btn', { onclick: () => { close(); showMe(s.show); } }, 'Show me') : null,
        h('span.grow'),
        i > 0 ? h('button.btn', { onclick: () => { i--; draw(); } }, 'Back') : null,
        h('button.btn.primary', { onclick: () => { if (last) close(); else { i++; draw(); } } }, last ? 'Got it' : 'Next')),
    );
    box.querySelector('.btn.primary')?.focus();
  }
  draw();
  document.body.append(back);
}

/** Open the tour automatically the first time this browser sees the office. */
export function tutorialOnFirstVisit(opts) {
  let seen;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { seen = true; }
  if (!seen) setTimeout(() => openTutorial(opts), 600);
}

export const TUTORIAL_STEPS = STEPS;

// --- the guided tour, which points at the real thing ------------------------------------------

/**
 * Walks through steps beside the real controls, without covering them: nothing is blocked, so
 * someone can try each thing as it is described. A step whose control is not on screen right now
 * says what it would have pointed at, in the middle of the screen.
 *
 * Each step: { title, lines, spot?: () => Element|null, action?: { label, run } }
 */
export function openGuidedTour({ steps, label, onClose = () => {} }) {
  let i = 0;
  const ring = h('div.cr-spot', { 'aria-hidden': 'true' });
  const card = h('div.cr.cr-guide', { role: 'dialog', 'aria-label': label, 'aria-live': 'polite' });
  let target = null;

  function place() {
    target = steps[i].spot?.() ?? null;
    if (target && !target.isConnected) target = null;
    if (!target) {
      ring.classList.remove('on');
      card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%, -50%)';
      return;
    }
    target.scrollIntoView?.({ block: 'nearest' });
    const r = target.getBoundingClientRect();
    const pad = 5;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    ring.classList.add('on');
    // Beside it if there is room, otherwise below, otherwise above; always on screen.
    const w = card.offsetWidth; const hh = card.offsetHeight; const m = 12;
    const vw = innerWidth; const vh = innerHeight;
    let left; let top;
    if (r.right + m + w < vw) { left = r.right + m; top = r.top; }
    else if (r.left - m - w > 0) { left = r.left - m - w; top = r.top; }
    else if (r.bottom + m + hh < vh) { left = r.left; top = r.bottom + m; }
    else { left = r.left; top = r.top - m - hh; }
    card.style.transform = 'none';
    card.style.left = `${Math.min(Math.max(m, left), vw - w - m)}px`;
    card.style.top = `${Math.min(Math.max(m, top), vh - hh - m)}px`;
  }

  function draw() {
    const s = steps[i];
    const last = i === steps.length - 1;
    const present = !s.spot || s.spot();
    card.replaceChildren(...[
      h('div.cr-tour-head', h('span.cr-tour-step', `Step ${i + 1} of ${steps.length}`), h('button.btn.small', { onclick: close, 'aria-label': 'Close the tour' }, '✕')),
      h('h2', s.title),
      h('ul.cr-tour-lines', ...s.lines.map((l) => h('li', l))),
      s.spot && !present && s.away ? h('p.hint', s.away) : null,
      s.action ? h('div.row', h('button.btn', { onclick: async () => { await s.action.run(); setTimeout(() => { i = Math.min(i + 1, steps.length - 1); draw(); }, 300); } }, s.action.label)) : null,
      h('div.actions',
        h('span.grow'),
        i > 0 ? h('button.btn', { onclick: () => { i--; draw(); } }, 'Back') : null,
        h('button.btn.primary', { onclick: () => { if (last) close(); else { i++; draw(); } } }, last ? 'Done' : 'Next')),
    ].filter(Boolean));
    place();
    card.querySelector('.btn.primary')?.focus({ preventScroll: true });
  }

  const onResize = () => place();
  const keys = (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowRight' && i < steps.length - 1) { i++; draw(); }
    if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
  };
  function close() {
    ring.remove(); card.remove();
    removeEventListener('resize', onResize);
    document.removeEventListener('keydown', keys, true);
    clearInterval(follow);
    onClose();
  }
  // The board can scroll or be redrawn under the ring, so it keeps looking.
  const follow = setInterval(() => { if (steps[i].spot) place(); }, 500);
  addEventListener('resize', onResize);
  document.addEventListener('keydown', keys, true);
  document.body.append(ring, card);
  draw();
  return { close };
}
