// The newest screenshot an agent took, in a small card on the office floor and in that agent's panel.
//
// Like watching Claude Code work: while a job runs, its latest screenshot shows up here within a few
// seconds, with who took it and when. Click it for the full size. The card is hidden when there is
// nothing recent to show, and a job's screenshots are deleted when it ends (lib/crew-worker/
// shot-cleanup.cjs), so it empties by itself. The images come from the same owner-only routes as the
// Screenshots page (lib/crew/shots.cjs): someone who does not own this computer never sees the card.

import { h, ago } from './common.js';
import { openShot } from './shots.js';

const POLL_MS = 5000;
// Older than this is not "what it is doing now"; the Screenshots page still has it.
const RECENT_MS = 60 * 60_000;
const src = (s) => `/api/crew/shots/${encodeURIComponent(s.name)}?v=${s.size}`;
const who = (s) => s.agent ?? s.by;

export function createShotWatch({ ui, api, onOpen = () => {} }) {
  let shots = [];
  let dismissed = null; // the newest one when the owner closed the card; a newer one opens it again
  const listeners = new Set();
  const card = h('aside.cr.cr-shotcard.hidden', { 'aria-label': 'Newest screenshot', 'aria-live': 'polite' });

  const recent = (agentId) => shots.find((s) => !s.kept && Date.now() - s.createdAt < RECENT_MS && (!agentId || s.agentId === agentId)) ?? null;

  async function tick() {
    if (!ui.ownerOfComputer || document.hidden) return;
    try {
      const d = await api('GET', '/api/crew/shots');
      const next = d.owner ? d.shots : [];
      const changed = next[0]?.name !== shots[0]?.name || next.length !== shots.length;
      shots = next;
      if (changed) { drawCard(); for (const fn of listeners) fn(); }
    } catch { /* the next tick tries again */ }
  }

  function drawCard() {
    const s = recent();
    const show = Boolean(s) && s.name !== dismissed;
    card.classList.toggle('hidden', !show);
    if (!show) { card.replaceChildren(); return; }
    card.replaceChildren(
      h('button.cr-shotcard-img', { type: 'button', title: 'Open it full size', onclick: () => { onOpen(); openShot(s, () => tick()); } },
        h('img', { src: src(s), alt: s.title ?? `Screenshot by ${who(s)}` })),
      h('div.cr-shotcard-cap',
        h('b.grow', who(s)),
        h('span.hint', ago(s.createdAt)),
        h('button.btn.small', { type: 'button', 'aria-label': 'Hide this screenshot', title: 'Hide until the next one', onclick: () => { dismissed = s.name; drawCard(); } }, '✕')));
  }

  /**
   * For an agent's panel: its own newest screenshot, kept up to date in place, or nothing. The
   * panel redraws only now and then, so this element redraws itself and lets go once it is gone.
   */
  function agentCard(agentId) {
    if (!ui.ownerOfComputer) return null;
    const el = h('div.cr-shotcard-agent');
    const draw = () => {
      if (!el.isConnected && el.dataset.drawn) { listeners.delete(draw); return; }
      el.dataset.drawn = '1';
      const s = recent(agentId);
      el.hidden = !s;
      el.replaceChildren(...(s ? [
        h('h3', 'What it sees'),
        h('button.cr-shot-img', { type: 'button', title: 'Open it full size', onclick: () => openShot(s, () => tick()) },
          h('img', { src: src(s), alt: s.title ?? `Screenshot by ${who(s)}` })),
        h('p.hint', [s.title, ago(s.createdAt)].filter(Boolean).join(' · ')),
      ] : []));
    };
    listeners.add(draw);
    draw();
    return el;
  }

  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
  return { el: card, agentCard, refresh: tick };
}
