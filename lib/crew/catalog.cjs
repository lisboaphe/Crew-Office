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

const PROVIDERS = {
  'claude-cli': { label: 'Claude subscription (Pro / Max) via Claude Code', defaultModel: 'default', models: ['default', 'opus', 'sonnet', 'haiku'], subscription: true, setup: 'Install Claude Code on your worker computer and sign in once with `claude`.' },
  'codex-cli': { label: 'ChatGPT subscription (Plus / Pro) via Codex', defaultModel: 'default', models: ['default', 'gpt-5', 'gpt-5-codex'], subscription: true, setup: 'Install Codex on your worker computer and run `codex login` with your ChatGPT account.' },
  anthropic: { label: 'Anthropic API key (Claude)', defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  openai: { label: 'OpenAI API key', defaultModel: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'] },
  local: { label: 'Local model (Ollama, LM Studio — OpenAI-compatible)', defaultModel: 'llama3.1', models: [] },
  scripted: { label: 'Scripted test provider (no AI — for automated tests)', defaultModel: 'scripted', models: ['scripted'] },
};

module.exports = { PERMISSIONS, TOOLS, REPLY_TOOLS, AGENT_STATES, TASK_STATES, TASK_KINDS, PRICES, PROVIDERS, costOf };
