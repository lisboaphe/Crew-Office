// Fewer characters in each prompt, without hiding anything silently. Every model turn resends the
// job so far, so a long test log is paid for again on every step.
//
// Two things, both reversible by the agent running or reading again:
//   compactResult   long command output: colour codes go, repeats collapse, and the middle of
//                   very long output goes, keeping any line that names an error
//   compactHistory  older tool results in a long job, shortened with a note saying so
//
// A file an agent has just read is never touched: it may be about to edit it. The idea of
// compressing tool output comes from RTK and 9Router; this is written fresh for this project.

'use strict';

const COMMAND_TOOLS = new Set(['run_command']);
const OUTPUT_FIELDS = ['stdout', 'stderr', 'output'];
const MAX_LINES = 240;
const KEEP_EACH_END = 80;
const MAX_IMPORTANT = 60;
const IMPORTANT = /\b(error|fail(ed|ure)?|exception|assert|panic|traceback|fatal|not ok)\b/i;
const KEEP_RECENT_RESULTS = 6;
const SHORTEN_OVER = 1500;
const SHORTEN_TO = 800;

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function collapseRepeats(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(j - i > 2 ? `${lines[i]}  [repeated ${j - i} times]` : lines[i]);
    if (j - i === 2) out.push(lines[i]);
    i = j;
  }
  return out;
}

function compactText(text) {
  const lines = collapseRepeats(stripAnsi(String(text)).split(/\r?\n/));
  if (lines.length <= MAX_LINES) return lines.join('\n');
  const middle = lines.slice(KEEP_EACH_END, -KEEP_EACH_END);
  const kept = middle.filter((l) => IMPORTANT.test(l)).slice(0, MAX_IMPORTANT);
  return [
    ...lines.slice(0, KEEP_EACH_END),
    `[${middle.length - kept.length} lines left out to save tokens. Run a narrower command to see them.]`,
    ...kept,
    ...lines.slice(-KEEP_EACH_END),
  ].join('\n');
}

/** A tool's result, shortened if it is command output and that helps. Returns it unchanged if not. */
function compactResult(toolName, result) {
  if (!COMMAND_TOOLS.has(toolName) || !result || typeof result !== 'object') return { result, saved: 0 };
  const out = { ...result };
  let saved = 0;
  for (const k of OUTPUT_FIELDS) {
    if (typeof out[k] !== 'string') continue;
    const short = compactText(out[k]);
    if (short.length < out[k].length) { saved += out[k].length - short.length; out[k] = short; }
  }
  return { result: out, saved };
}

/** What to send for this turn. The saved transcript keeps everything. */
function compactHistory(transcript) {
  const toolEntries = transcript.filter((e) => e.role === 'tool');
  const old = new Set(toolEntries.slice(0, -KEEP_RECENT_RESULTS));
  if (!old.size) return { transcript, saved: 0 };
  let saved = 0;
  const out = transcript.map((e) => {
    if (!old.has(e)) return e;
    return {
      ...e,
      results: e.results.map((r) => {
        if (typeof r.content !== 'string' || r.content.length <= SHORTEN_OVER) return r;
        saved += r.content.length - SHORTEN_TO;
        return { ...r, content: `${r.content.slice(0, SHORTEN_TO)}\n[Older result shortened to save tokens. Use the tool again if you need the rest.]` };
      }),
    };
  });
  return { transcript: out, saved };
}

module.exports = { compactResult, compactHistory, compactText };
