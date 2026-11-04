// The vocabulary shared by the room host and every worker: tool permissions, the tools
// they unlock, where each tool runs, and the agent and task lifecycles.
//
// Permissions are granted in groups ("files.write"), not per function, because that is the
// granularity a person deciding "may Bob's agent touch my files?" actually thinks in.

'use strict';

/** Permission groups an owner can give an agent, and grant on a project. */
const PERMISSIONS = {
  messaging: 'Message and ask other agents on the same project',
  'files.read': 'Read the shared project files',
  'files.write': 'Create and change shared project files',
  memory: 'Read and add to shared project notes',
  delegate: 'Create subtasks and request reviews',
  exec: 'Run code in a sandbox on the owner’s worker',
  web: 'Fetch web pages from the owner’s worker',
  git: 'Work in the project’s Git repositories on its own branch',
};

/**
 * Every tool an agent can call. `runs` says where: `host` tools touch shared state and are
 * executed by the room host after a permission check; `worker` tools run on the agent
 * owner's own machine and are authorised by the host before they run.
 * `needs: null` is always available to any agent working on a task.
 */
const TOOLS = {
  list_team: { needs: null, runs: 'host', class: 'knowledge' },
  read_task: { needs: null, runs: 'host', class: 'read' },
  send_message: { needs: 'messaging', runs: 'host', class: 'other' },
  ask_agent: { needs: 'messaging', runs: 'host', class: 'other' },
  report_progress: { needs: null, runs: 'host', class: 'other' },
  list_files: { needs: 'files.read', runs: 'host', class: 'search' },
  read_file: { needs: 'files.read', runs: 'host', class: 'read' },
  write_file: { needs: 'files.write', runs: 'host', class: 'edit' },
  delete_file: { needs: 'files.write', runs: 'host', class: 'edit', sensitive: true },
  search_memory: { needs: 'memory', runs: 'host', class: 'knowledge' },
  write_note: { needs: 'memory', runs: 'host', class: 'edit' },
  delegate_task: { needs: 'delegate', runs: 'host', class: 'agent' },
  request_review: { needs: 'delegate', runs: 'host', class: 'agent' },
  request_human_approval: { needs: null, runs: 'host', class: 'wait' },
  submit_plan: { needs: null, runs: 'host', class: 'other', managerOnly: true },
  complete_task: { needs: null, runs: 'host', class: 'scm' },
  run_command: { needs: 'exec', runs: 'worker', class: 'execute' },
  fetch_url: { needs: 'web', runs: 'worker', class: 'network' },
  remember: { needs: null, runs: 'worker', class: 'edit' },
  recall: { needs: null, runs: 'worker', class: 'knowledge' },
  // Git: each agent works in its own clone, on its own branch, on its owner's machine.
  repo_files: { needs: 'git', runs: 'worker', class: 'search' },
  repo_read: { needs: 'git', runs: 'worker', class: 'read' },
  repo_write: { needs: 'git', runs: 'worker', class: 'edit' },
  repo_status: { needs: 'git', runs: 'worker', class: 'read' },
  repo_sync: { needs: 'git', runs: 'worker', class: 'scm' },
  repo_fetch: { needs: 'git', runs: 'worker', class: 'network' },
  repo_merge_main: { needs: 'git', runs: 'worker', class: 'edit' },
  request_merge: { needs: 'git', runs: 'host', class: 'scm' },
  review_decision: { needs: 'git', runs: 'host', class: 'other' },
  publish_file: { needs: 'files.write', runs: 'worker', class: 'scm' },
};

/** Tools a quick reply (answering another agent's question, or a chat) may use. */
const REPLY_TOOLS = ['list_team', 'read_file', 'list_files', 'search_memory', 'recall'];

const AGENT_STATES = ['IDLE', 'ASSIGNED', 'PLANNING', 'WORKING', 'WAITING', 'REVIEW', 'COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED', 'BLOCKED', 'OFFLINE'];
const TASK_STATES = ['pending', 'awaiting_approval', 'queued', 'in_progress', 'waiting', 'review', 'completed', 'failed', 'cancelled', 'blocked'];
const TASK_KINDS = ['plan', 'work', 'review', 'synthesis'];

/** USD per million tokens. A model not listed is costed at zero and flagged as unpriced. */
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50],
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
};

function costOf(model, tokensIn, tokensOut) {
  const p = PRICES[model];
  if (!p) return { usd: 0, priced: false };
  return { usd: (tokensIn * p[0] + tokensOut * p[1]) / 1e6, priced: true };
}

/**
 * How an agent reaches a model. `billing` is what the owner is charged through:
 *   subscription — the owner's own plan, through the provider's official route
 *   paid         — per-token API billing; refused unless the owner turns off
 *                  "Never use paid API" on their own worker
 *   local        — a model on the owner's machine
 *   none         — the scripted test provider, not AI
 * `support` is the honest state of the integration (docs/upgrade/PROVIDERS.md).
 */
const PROVIDERS = {
  'chatgpt-plan': { label: 'ChatGPT plan — Sign in with ChatGPT', billing: 'subscription', support: 'implemented; verify with Test Connection after signing in', defaultModel: 'default', models: ['default'], subscription: true, setup: 'On your worker’s settings page press “Sign in with ChatGPT”. Usage comes from your ChatGPT plan; you can cap this app in ChatGPT Settings → Usage.' },
  'codex-cli': { label: 'ChatGPT plan — official Codex app', billing: 'subscription', support: 'implemented through the official Codex CLI', defaultModel: 'default', models: ['default', 'gpt-5', 'gpt-5-codex'], subscription: true, setup: 'Install Codex on your worker computer and run `codex login` with your ChatGPT account.' },
  'claude-handoff': { label: 'Claude plan — manual handoff to your own Claude Code', billing: 'subscription', support: 'manual: you run each task yourself in Claude Code', defaultModel: 'default', models: ['default'], subscription: true, setup: 'Install Claude Code and sign in with your Claude account. Each task appears on your worker page with its folder and instructions; you run it in Claude Code and press Done.' },
  'claude-cli': { label: 'Claude plan — automated Claude Code (Limited, opt-in)', billing: 'subscription', support: 'limited: off unless you opt in on your worker after reading Anthropic’s terms', defaultModel: 'default', models: ['default', 'opus', 'sonnet', 'haiku'], subscription: true, setup: 'Anthropic does not allow third-party apps to route requests through Claude plan credentials on behalf of users. Prefer the manual handoff; this mode stays off unless you opt in on your worker.' },
  anthropic: { label: 'Anthropic API key (paid per token)', billing: 'paid', support: 'implemented (official SDK)', defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  openai: { label: 'OpenAI API key (paid per token)', billing: 'paid', support: 'implemented', defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'] },
  local: { label: 'Local model (Ollama, LM Studio — OpenAI-compatible)', billing: 'local', support: 'implemented', defaultModel: 'llama3.1', models: [] },
  scripted: { label: 'Scripted test provider (no AI — demos and tests)', billing: 'none', support: 'test only', defaultModel: 'scripted', models: ['scripted'] },
};

module.exports = { PERMISSIONS, TOOLS, REPLY_TOOLS, AGENT_STATES, TASK_STATES, TASK_KINDS, PRICES, PROVIDERS, costOf };
