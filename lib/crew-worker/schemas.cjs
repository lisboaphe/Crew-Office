// What each tool looks like to a model: a description and a JSON Schema for its input.
// Provider adapters translate these into each API's own tool format.

'use strict';

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const SCHEMAS = {
  list_team: { description: 'List the agents on this project: name, role, skills, owner, status and whether they are available.', input: obj({}) },
  read_task: { description: 'See every task in the project with its status, assignee, result and files.', input: obj({}) },
  send_message: {
    description: 'Send a message. `to` is an agent name (direct message, visible in the project channel) or a #channel. Use for handoffs, sharing results and progress. Do not use it to ask a question you need answered now — use ask_agent.',
    input: obj({ to: str('Agent name, or #channel'), body: str('The message'), kind: { type: 'string', enum: ['chat', 'progress', 'handoff', 'artifact', 'review_request'] } }, ['to', 'body']),
  },
  ask_agent: {
    description: 'Ask another agent on this project a question and wait for its answer (up to ~2 minutes). Use sparingly: each question costs its owner budget, and conversations are capped.',
    input: obj({ agent: str('Agent name'), question: str('One clear, self-contained question') }, ['agent', 'question']),
  },
  report_progress: { description: 'Post a short progress update to the project channel.', input: obj({ text: str('What you did and what is next') }, ['text']) },
  list_files: { description: 'List the shared project files.', input: obj({}) },
  read_file: { description: 'Read a shared project file.', input: obj({ path: str('Relative path, e.g. src/server.js') }, ['path']) },
  write_file: { description: 'Create or overwrite a shared project file (max 256 KB). This is how you produce deliverables.', input: obj({ path: str('Relative path'), content: str('Full file content') }, ['path', 'content']) },
  delete_file: { description: 'Delete a shared project file. Always needs a human’s approval.', input: obj({ path: str('Relative path') }, ['path']) },
  search_memory: { description: 'Search the project’s shared notes (requirements, decisions, contracts).', input: obj({ query: str('Words to look for; empty for the latest') }) },
  write_note: { description: 'Add a note to the project’s shared memory, e.g. an agreed API contract or a decision.', input: obj({ title: str('Short title'), body: str('The note') }, ['title', 'body']) },
  code_graph: { description: 'Look up where something is in the project’s code and what it connects to, from a map built from merged code. Reference only; it can be behind main.', input: obj({ query: str('Names of functions, classes, files or concepts') }, ['query']) },
  delegate_task: {
    description: 'Create a subtask and assign it to a teammate (by name, or by role). Its owner may have to approve it.',
    input: obj({ title: str('Task title'), description: str('What done looks like'), role: str('Role or skill needed'), agent: str('Optional: a specific agent name'), handoff: str('What is done, what is left, where things are, how to test. Required when handoff notes are on.') }, ['title', 'description']),
  },
  request_review: { description: 'Ask a teammate to review files you produced. Creates a review task for them.', input: obj({ agent: str('Reviewer name'), files: { type: 'array', items: { type: 'string' } }, note: str('What to look at') }, ['agent']) },
  request_human_approval: { description: 'Stop and ask the humans for a decision before continuing. Your job pauses until they answer.', input: obj({ reason: str('What you need decided, and why') }, ['reason']) },
  submit_plan: {
    description: 'Submit the project plan (managers, planning task only). Each task: a key, title, description, the role best suited, optional assignee name from list_team, keys it depends on, expected deliverable file paths, and kind work|review.',
    input: obj({
      tasks: {
        type: 'array',
        items: obj({
          key: str('Short unique key, e.g. api'), title: str('Task title'), description: str('What to do and what done looks like'), role: str('Role needed'),
          assignee: str('Agent name, if a specific teammate should do it'), depends_on: { type: 'array', items: { type: 'string' } },
          deliverables: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['work', 'review'] }, milestone: str('Milestone name'),
        }, ['key', 'title', 'description']),
      },
    }, ['tasks']),
  },
  complete_task: {
    description: 'Finish your task. You must give evidence: `artifacts` lists the project files you produced (they are checked to exist), and/or `tests` carries a test run. Reviews and summaries: put the full text in `summary`; it is saved as a file.',
    input: obj({
      summary: str('What you did, how it was verified, anything left open'),
      artifacts: { type: 'array', items: { type: 'string' } },
      tests: obj({ command: str('Command that was run'), exitCode: { type: 'integer' }, output: str('Its output') }, ['command', 'exitCode', 'output']),
    }, ['summary']),
  },
  run_command: {
    description: 'Run a Node.js command against a copy of the project files in a sandbox on your owner’s machine, e.g. "node --test" or "node scripts/check.js". 60 s limit. Files changed by the command are not saved back — use write_file for deliverables.',
    input: obj({ command: str('The command'), repo: str('In a Git project: which repository clone to run in') }, ['command']),
  },
  fetch_url: { description: 'Fetch a public web page (GET, text only, 200 KB cap).', input: obj({ url: str('http(s) URL') }, ['url']) },
  remember: { description: 'Save something to your private memory (only you and your owner can see it). Kept across tasks.', input: obj({ key: str('Short key'), value: str('What to remember') }, ['key', 'value']) },
  recall: { description: 'Read your private memory.', input: obj({ query: str('Optional filter') }) },
  repo_files: { description: 'List the files in your own clone of a project repository.', input: obj({ repo: str('Repository name; optional when there is one') }) },
  repo_read: { description: 'Read a file from your clone, or from another ref such as origin/main or origin/agent/boris/abc after repo_fetch.', input: obj({ repo: str('Repository name'), path: str('Relative path'), ref: str('Optional git ref') }, ['path']) },
  repo_write: { description: 'Save a file in your own clone. Local only: nobody else sees it until repo_sync.', input: obj({ repo: str('Repository name'), path: str('Relative path'), content: str('Full file content') }, ['path', 'content']) },
  repo_status: { description: 'See your branch, uncommitted changes and diff.', input: obj({ repo: str('Repository name') }) },
  repo_sync: { description: 'Publish your work. In smart mode: run the tests, commit, and push your branch; failing tests stop it and your changes stay local. Then call request_merge.', input: obj({ repo: str('Repository name'), message: str('Commit message: what and why'), final: { type: 'boolean', description: 'In live mode, run the full tested sync' }, push: { type: 'boolean', description: 'In manual mode, push as well as commit' } }, ['message']) },
  repo_fetch: { description: 'See what others published (new commits on main, other branches) without changing your working tree.', input: obj({ repo: str('Repository name') }) },
  repo_merge_main: { description: 'Bring the latest main into your branch. Conflicts are left marked in the files for you to resolve; nothing is overwritten.', input: obj({ repo: str('Repository name') }) },
  request_merge: { description: 'Ask for your pushed branch to be merged into main. An independent reviewer is assigned; your task completes when the merge does.', input: obj({ repo: str('Repository name'), summary: str('What changed, why, and how it was tested') }, ['summary']) },
  review_decision: { description: 'Finish a merge review: approve, or request changes with precise comments.', input: obj({ verdict: { type: 'string', enum: ['approve', 'request_changes'] }, summary: str('Your overall assessment'), comments: { type: 'array', items: obj({ file: str('Path'), line: { type: 'integer' }, body: str('The comment') }, ['body']) } }, ['verdict', 'summary']) },
  publish_file: { description: 'Publish a built release, image or other binary from your clone to the shared project file store.', input: obj({ repo: str('Repository name'), path: str('Path in your clone'), as: str('Optional path in the shared store'), note: str('What this is') }, ['path']) },
};

module.exports = { SCHEMAS };
