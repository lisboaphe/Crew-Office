// A light bulb hanging from the ceiling in the lobby. Mostly on; it sways, flickers now and then, and
// every so often goes out for a moment. It is only there to make the place feel lived in.
//
// Whether it moves is the person's to say. Clicking the bulb switches it, and so does Preferences.
// Until they say, it follows the system: with reduced motion asked for, it hangs still and stays lit.

import { h } from './common.js';

const KEY = 'crew.lamp';
const CHANGED = 'crew-lamp';
const randomBetween = (low, high) => low + Math.random() * (high - low);

/** 'on', 'off', or '' to follow the system's reduced motion setting. */
export function lampSetting() {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function setLampSetting(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch { /* this browser will not remember it, but the lamp still changes for now */ }
  window.dispatchEvent(new Event(CHANGED));
}

/** Whether the lamp sways and flickers right now. */
export function lampMoves() {
  const setting = lampSetting();
  if (setting) return setting === 'on';
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function hangingLamp() {
  const bulb = h('button.cr-lamp-bulb', {
    type: 'button',
    'aria-label': 'Lobby lamp: switch its swing and flicker on or off',
    title: 'Click to switch the swing and flicker on or off',
    onclick: () => setLampSetting(lampMoves() ? 'off' : 'on'),
  });
  const el = h('div.cr-lamp.on',
    h('div.cr-lamp-beam', { 'aria-hidden': 'true' }),
    h('div.cr-lamp-swing', h('div.cr-lamp-cord', { 'aria-hidden': 'true' }), bulb, h('div.cr-lamp-glow', { 'aria-hidden': 'true' })));
  const set = (on) => el.classList.toggle('on', on);
  const sync = () => {
    const moves = lampMoves();
    el.classList.toggle('moving', moves);
    bulb.setAttribute('aria-pressed', String(moves));
    if (!moves) set(true); // a still lamp is a lit one
  };
  sync();
  window.addEventListener(CHANGED, sync);

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  (async () => {
    // Stops by itself once the lobby has redrawn without it.
    await wait(randomBetween(1500, 4000));
    while (el.isConnected || !el.dataset.started) {
      el.dataset.started = '1';
      if (!lampMoves()) {
        await wait(1000);
        continue;
      }
      if (Math.random() < 0.3) {
        // Goes out for a moment, and sputters back.
        set(false);
        await wait(randomBetween(900, 2600));
        for (let i = 0; i < 3; i++) {
          set(true);
          await wait(randomBetween(50, 130));
          set(false);
          await wait(randomBetween(50, 160));
        }
        set(true);
      } else {
        // A quick flicker.
        const flickers = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < flickers; i++) {
          set(false);
          await wait(randomBetween(40, 110));
          set(true);
          await wait(randomBetween(40, 170));
        }
      }
      await wait(randomBetween(3000, 11000));
    }
    window.removeEventListener(CHANGED, sync);
  })();
  return el;
}
