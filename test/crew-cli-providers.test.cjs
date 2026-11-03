// The subscription providers (Claude Code, Codex) against stand-in executables that
// behave like the real CLIs' headless modes: arguments, prompt on stdin, JSON out. The real
// CLIs are not needed — and a test cannot sign in to anyone's subscription anyway.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeCliAdapter, codexCliAdapter, parseReply } = require('../lib/crew-worker/cli-providers.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-fakecli-'));

/** Write a fake CLI as an executable this platform can start by name. */
function fake(name, js) {
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(script, js);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}

const COMMON = `
const fs = require('fs');
let input = ''; process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => main(input));
fs.writeFileSync(${JSON.stringify(path.join(dir, 'ARGV'))}, JSON.stringify(process.argv.slice(2)));
`;

test('Claude Code adapter: tools off, prompt on stdin, JSON protocol both ways', async () => {
  process.env.CREW_CLAUDE_CLI = fake('claude', `${COMMON}
function main(prompt) {
  const done = prompt.includes('### Tool results');
  const reply = done ? { say: 'All finished.', tool_calls: [] } : { say: 'Reading first.', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] };
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Sure:\\n\`\`\`json\\n' + JSON.stringify(reply) + '\\n\`\`\`', usage: { input_tokens: 120, output_tokens: 30 } }));
}`);
  const ad = claudeCliAdapter();
  const transcript = [{ role: 'user', text: 'Do the task' }];
  const r1 = await ad.complete({ system: 'You are Ada.', transcript, tools: ['read_file', 'complete_task'], model: 'sonnet' });
  const argv = JSON.parse(fs.readFileSync(path.join(dir, 'ARGV'), 'utf8'));
  assert.deepStrictEqual(argv.slice(0, 6), ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config'], 'built-in tools are switched off with an empty --tools');
  assert.deepStrictEqual(argv.slice(6), ['--model', 'sonnet']);
  assert.strictEqual(r1.toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(r1.toolCalls[0].input, { path: 'a.txt' });
  assert.deepStrictEqual(r1.usage, { in: 120, out: 30 });
  transcript.push({ role: 'assistant', text: r1.text, toolCalls: r1.toolCalls }, { role: 'tool', results: [{ id: r1.toolCalls[0].id, name: 'read_file', content: '{"content":"hi"}' }] });
  const r2 = await ad.complete({ system: 'You are Ada.', transcript, tools: ['read_file'], model: 'default' });
  assert.strictEqual(r2.toolCalls.length, 0);
  assert.strictEqual(r2.text, 'All finished.');
});

test('Claude Code adapter: a signed-out CLI says how to sign in', async () => {
  process.env.CREW_CLAUDE_CLI = fake('claude-out', `${COMMON}
function main() { console.log(JSON.stringify({ is_error: true, result: 'Invalid API key · Please run /login' })); process.exit(1); }`);
  await assert.rejects(claudeCliAdapter().complete({ system: '', transcript: [{ role: 'user', text: 'x' }], tools: [], model: 'default' }), /not signed in/);
});

test('Codex adapter: read-only sandbox in an empty folder, last message parsed', async () => {
  process.env.CREW_CODEX_CLI = fake('codex', `${COMMON}
function main(prompt) {
  const a = process.argv.slice(2);
  const out = a[a.indexOf('--output-last-message') + 1];
  if (!prompt.includes('submit_plan')) process.exit(3);
  fs.writeFileSync(out, JSON.stringify({ say: 'Plan ready', tool_calls: [{ name: 'submit_plan', input: { tasks: [{ key: 'a', title: 'A', description: 'd' }] } }] }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 80 } }));
}`);
  const r = await codexCliAdapter().complete({ system: 'You are Paige.', transcript: [{ role: 'user', text: 'Plan it' }], tools: ['submit_plan'], model: 'gpt-5' });
  const argv = JSON.parse(fs.readFileSync(path.join(dir, 'ARGV'), 'utf8'));
  assert.deepStrictEqual(argv.slice(0, 5), ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check']);
  assert.ok(argv.includes('-m') && argv.includes('gpt-5') && argv[argv.length - 1] === '-');
  assert.strictEqual(r.toolCalls[0].name, 'submit_plan');
  assert.deepStrictEqual(r.usage, { in: 900, out: 80 });
});

test('a missing CLI is reported as not installed', async () => {
  process.env.CREW_CLAUDE_CLI = path.join(dir, 'definitely-not-here');
  await assert.rejects(claudeCliAdapter().complete({ system: '', transcript: [{ role: 'user', text: 'x' }], tools: [], model: 'default' }), /not installed|failed/);
});

test('reply parsing tolerates prose and falls back to plain text', () => {
  assert.strictEqual(parseReply('Here you go {"say":"x","tool_calls":[{"name":"list_files","input":{}}]} done').toolCalls[0].name, 'list_files');
  assert.deepStrictEqual(parseReply('just words'), { text: 'just words', toolCalls: [] });
  assert.strictEqual(parseReply('{"tool_calls":[{"nope":1}]}').toolCalls.length, 0, 'calls without a name are dropped');
});
