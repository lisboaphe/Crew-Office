// The one or two sentences of an agent's report that go into the project chat.
//
// A finished task used to post up to 1,500 characters of its report there, plus a list of files.
// Reports written by autonomous and handoff runs are whole documents — headings, change lists,
// paths — so the chat filled with text people scrolled past. The full report stays on the task;
// the chat gets its opening, in plain words.

'use strict';

const MAX = 240;

/** The opening of a report: the first prose paragraph, at most two sentences and MAX characters. */
function brief(text, max = MAX) {
  const prose = String(text ?? '')
    .replace(/```[\s\S]*?```/g, '\n\n')                 // code blocks say nothing to a person in chat
    .split(/\n\s*\n/)
    .map((para) => para.split('\n')
      .filter((l) => !/^\s*(#|[-*+]\s|\d+[.)]\s|>|\||VERDICT:)/i.test(l))  // headings, lists, quotes, tables
      .join(' '))
    .map((para) => para.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim())
    .find((para) => /[a-z]{3}/i.test(para)) ?? '';
  if (!prose) return '';
  // A sentence ends at . ! or ? followed by a space, so "Godot 4.7.2" and "lib/a.js" stay whole.
  const sentences = prose.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let out = '';
  for (const s of sentences.slice(0, 2)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  // One sentence longer than the limit: cut at a word.
  return `${prose.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

module.exports = { brief };
