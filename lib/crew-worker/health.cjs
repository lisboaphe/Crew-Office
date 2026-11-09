// What real work says about each AI connection: a reply from it during a task, or the reason it
// stopped. Whoever holds the connection states listens, so an agent finishing work counts as much
// as pressing Test Connection, and a sign-out or a used-up plan shows at once rather than as a task
// that quietly fails. Nothing is sent from here and nothing is stored here.

'use strict';

const listeners = new Set();

/**
 * @param {string} provider
 * @param {{ok: boolean, limit?: boolean, signIn?: boolean, reason?: string}} outcome
 */
function observe(provider, outcome) {
  for (const listener of listeners) {
    try { listener(provider, outcome); } catch { /* a listener's trouble is not the task's */ }
  }
}

/** Hear every outcome. Returns the way to stop. */
function listen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { observe, listen };
