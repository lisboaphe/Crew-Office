// The way around the office: a slim dock on the left edge, where each button opens its own menu.
//
// Hovering opens it, after a short pause so that passing the mouse over it on the way to the office
// does nothing. Once open it stays open until something says otherwise: a click outside, Esc, or
// choosing a destination. Moving the mouse away is not one of those, on purpose. On a touch screen,
// or from the keyboard, the same buttons open it by pressing them.

import { h, icon } from './common.js';

const HOVER_MS = 110;

/**
 * @param groups  [{ key, label, icon, items: [{ key, label, icon, hint? }] }]
 * @param onGo    called with an item's key when it is chosen
 * @param current returns the key of the place now on screen
 * @param badgeOf optional: returns a number to show on an item
 */
export function createNav({ groups, onGo, current, badgeOf = () => 0 }) {
  let isOpen = false;
  let openGroup = groups[0].key;
  let hoverTimer = null;
  let trigger = null;

  const panel = h('div.cr-nav-panel', { id: 'cr-nav-panel', role: 'menu', 'aria-label': 'Go to', inert: true });
  const dockButtons = groups.map((g) => {
    const b = h('button.cr-nav-dock-btn', {
      type: 'button', 'aria-label': g.label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'cr-nav-panel', 'data-tip': g.label, 'data-group': g.key,
      onclick: () => { trigger = b; if (isOpen && openGroup === g.key) close(true); else open(g.key, true); },
      onkeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); trigger = b; open(g.key, true); } },
    }, icon(g.icon));
    // Touch has no hover: a tap is a click, and must not arrive at an already-open group and shut it.
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => { trigger = b; open(g.key); }, HOVER_MS);
    });
    b.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
    return b;
  });
  const dock = h('div.cr-nav-dock', ...dockButtons);
  const el = h('nav.cr.cr-nav', { 'aria-label': 'Main navigation' }, dock, panel);

  function draw() {
    const here = current();
    const group = groups.find((g) => g.key === openGroup) ?? groups[0];
    // Only the section being pointed at, beside the button that opened it.
    const button = dockButtons.find((b) => b.dataset.group === group.key);
    panel.style.marginTop = `${button.offsetTop - 6}px`;
    panel.replaceChildren(
      h('div.cr-nav-head', h('b', group.label), h('button.btn.small', { type: 'button', 'aria-label': 'Close navigation', onclick: () => close(true) }, '✕')),
      h('section.cr-nav-group.on',
        h('div.cr-nav-items',
          h('div', ...group.items.map((it) => {
            const n = badgeOf(it.key);
            return h('button.cr-nav-item', {
              type: 'button', role: 'menuitem', class: here === it.key ? 'on' : '', 'aria-current': here === it.key ? 'page' : null, title: it.hint ?? null,
              onclick: () => { close(false); onGo(it.key); },
            }, icon(it.icon), h('span.grow', it.label), n ? h('span.cr-nav-badge', n) : null);
          })))));
  }

  const syncDock = () => {
    for (const b of dockButtons) {
      b.setAttribute('aria-expanded', isOpen && b.dataset.group === openGroup ? 'true' : 'false');
      b.classList.toggle('on', isOpen && b.dataset.group === openGroup);
    }
  };

  function open(group, focusFirst = false) {
    openGroup = group ?? openGroup;
    const wasOpen = isOpen;
    isOpen = true;
    el.classList.add('open');
    panel.inert = false;
    draw();
    syncDock();
    if (!wasOpen) {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keys, true);
    }
    if (focusFirst) panel.querySelector('.cr-nav-group.on .cr-nav-item')?.focus();
  }

  function close(returnFocus) {
    clearTimeout(hoverTimer);
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('open');
    panel.inert = true;
    syncDock();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    if (returnFocus) trigger?.focus();
  }

  const outside = (e) => { if (!el.contains(e.target)) close(false); };

  function keys(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (!el.contains(document.activeElement)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const stops = [...panel.querySelectorAll('button')].filter((b) => !b.closest('[inert]'));
    if (!stops.length) return;
    e.preventDefault();
    e.stopPropagation();
    const at = stops.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? stops.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + stops.length) % stops.length;
    stops[next].focus();
  }

  draw();
  return { el, open, close, refresh: () => { if (isOpen) draw(); }, isOpen: () => isOpen };
}
