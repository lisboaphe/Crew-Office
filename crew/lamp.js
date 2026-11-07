// A light bulb hanging from the ceiling in the lobby. Mostly on; it flickers now and then, and every
// so often goes out for a moment. It is only there to make the place feel lived in.

import { h } from './common.js';

const randomBetween = (low, high) => low + Math.random() * (high - low);

export function hangingLamp() {
  const bulb = h('div.cr-lamp-bulb');
  const el = h('div.cr-lamp.on', { 'aria-hidden': 'true' },
    h('div.cr-lamp-beam'),
    h('div.cr-lamp-swing', h('div.cr-lamp-cord'), bulb, h('div.cr-lamp-glow')));
  const set = (on) => el.classList.toggle('on', on);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return el;

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  (async () => {
    // Stops by itself once the lobby has redrawn without it.
    await wait(randomBetween(1500, 4000));
    while (el.isConnected || !el.dataset.started) {
      el.dataset.started = '1';
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
  })();
  return el;
}
