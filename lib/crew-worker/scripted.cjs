// The scripted test provider. NOT an AI model.
//
// It exists so the whole multiplayer pipeline — planning, cross-team questions with
// correlation ids, approvals, shared files, sandboxed test runs, reviews, the final
// summary — can be exercised end to end, in automated tests and on a machine with no API
// key, through exactly the same tool calls a real model would make. Each turn it looks at
// the transcript so far and emits the next tool call of a fixed per-role script; the code
// it writes is a fixed template. Everything downstream of the provider is real.
//
// Agents using it say so whenever they speak to a human.

'use strict';

const DISCLOSURE = '(scripted test provider — no AI model)';

function createScripted() {
  return {
    name: 'scripted',
    async complete({ system, transcript, tools }) {
      const role = (system.match(/You are .+?, an AI (.+?) working/) ?? [])[1]?.toLowerCase() ?? '';
      const me = (system.match(/You are (.+?), an AI/) ?? [])[1] ?? 'Agent';
      const first = transcript[0]?.text ?? '';
      const results = transcript.filter((e) => e.role === 'tool').flatMap((e) => e.results);
      const lastResult = results.length ? safeJson(results[results.length - 1].content) : null;
      const step = transcript.filter((e) => e.role === 'assistant').length;
      const kind = (first.match(/Your task \((\w+)\)/) ?? [])[1] ?? (first.includes(' asks you: ') ? 'reply' : 'chat');
      const team = parseTeam(system);
      const plan = scriptFor(kind, role, { me, first, team, results, lastResult, tools });
      const next = plan[step];
      const usage = { in: Math.ceil((system.length + JSON.stringify(transcript).length) / 4), out: 60 };
      if (!next) return { text: 'Done.', toolCalls: [], raw: null, stopReason: 'end_turn', model: 'scripted', usage };
      const n = typeof next === 'function' ? next({ results, lastResult }) : next;
      if (n.text !== undefined) return { text: n.text, toolCalls: [], raw: null, stopReason: 'end_turn', model: 'scripted', usage };
      const allowed = n.tool && tools.includes(n.tool);
      if (!allowed) return { text: `I would use ${n.tool} next, but I do not have that permission here. ${DISCLOSURE}`, toolCalls: [], raw: null, stopReason: 'end_turn', model: 'scripted', usage };
      return { text: n.say ?? '', toolCalls: [{ id: `call_${step}_${Math.random().toString(36).slice(2, 8)}`, name: n.tool, input: n.input }], raw: null, stopReason: 'tool_use', model: 'scripted', usage };
    },
  };
}

function parseTeam(system) {
  const out = [];
  for (const line of system.split('\n')) {
    const m = line.match(/^- (.+?): (.+?)(?: \(.*?\))?, owned by (.+?)(, project manager)?(?: — currently unavailable)?$/);
    if (m) out.push({ name: m[1], role: m[2].toLowerCase(), manager: Boolean(m[4]) });
  }
  return out;
}

const pick = (team, words, notManager = true) => team.find((t) => (!notManager || !t.manager) && words.some((w) => t.role.includes(w)));

function scriptFor(kind, role, env) {
  const { team } = env;
  if (kind === 'plan') {
    return [
      { tool: 'list_team', input: {}, say: 'Let me see who is on the team.' },
      () => {
        const be = pick(team, ['backend', 'api', 'server']);
        const fe = pick(team, ['frontend', 'front-end', 'ui developer', 'web']);
        const ds = pick(team, ['design', 'ux']);
        const qa = pick(team, ['qa', 'test', 'quality']);
        const sec = pick(team, ['security']);
        const anyone = team.find((t) => !t.manager) ?? team[0];
        const tasks = [
          { key: 'api', title: 'Design the API contract and build the backend', description: 'Write openapi.json (the contract) and server.js: a Node HTTP server with a JSON task API (list, create, update, delete) that also serves public/. Share the contract with the frontend developer.', role: 'backend developer', assignee: (be ?? anyone).name, deliverables: ['openapi.json', 'server.js'], depends_on: [] },
          { key: 'ui', title: 'Build the task management frontend', description: 'Get the API contract from the backend developer, then write public/index.html and public/app.js that list, add, complete and delete tasks through the API.', role: 'frontend developer', assignee: (fe ?? anyone).name, deliverables: ['public/index.html', 'public/app.js'], depends_on: [] },
        ];
        if (ds) tasks.push({ key: 'style', title: 'Visual design and stylesheet', description: 'Write public/style.css: a clean, readable look for the task list.', role: 'ui designer', assignee: ds.name, deliverables: ['public/style.css'], depends_on: [] });
        tasks.push({ key: 'qa', title: 'Integration tests', description: 'Write tests/api.test.js that start the server and exercise every endpoint, run them, and report defects.', role: 'qa engineer', assignee: (qa ?? be ?? anyone).name, deliverables: ['tests/api.test.js'], depends_on: ['api', 'ui'] });
        if (sec) tasks.push({ key: 'sec', title: 'Security review of the backend', description: 'Review server.js for input validation, limits and unsafe patterns. Report findings.', role: 'security reviewer', assignee: sec.name, kind: 'review', depends_on: ['api'] });
        return { tool: 'submit_plan', input: { tasks }, say: `Here is the plan: ${tasks.length} tasks.` };
      },
      { text: 'Plan submitted; waiting for approval.' },
    ];
  }
  if (kind === 'synthesis') {
    return [
      { tool: 'read_task', input: {} },
      { tool: 'list_files', input: {} },
      ({ results }) => {
        const board = safeJson(results[0]?.content)?.tasks ?? [];
        const files = (safeJson(results[1]?.content)?.files ?? []).map((f) => f.path);
        const done = board.filter((t) => t.status === 'completed' && t.kind !== 'plan');
        const notDone = board.filter((t) => t.status !== 'completed' && t.kind !== 'plan' && t.kind !== 'synthesis');
        const summary = [
          `Project summary ${DISCLOSURE}.`, '',
          `Completed ${done.length} of ${done.length + notDone.length} tasks.`, '',
          ...done.map((t) => `- ${t.title} — ${t.agent}: ${String(t.result ?? '').split('\n')[0].slice(0, 200)}`),
          ...(notDone.length ? ['', 'Not completed:', ...notDone.map((t) => `- [${t.status}] ${t.title}: ${t.result ?? ''}`)] : []),
          '', `Files: ${files.join(', ')}`, '',
          'To run it: `node server.js`, then open http://localhost:3000. Tests: `node --test tests/api.test.js`.',
        ].join('\n');
        return { tool: 'complete_task', input: { summary } };
      },
      { text: 'Summary delivered.' },
    ];
  }
  if (kind === 'reply') {
    const q = env.first.toLowerCase();
    if (/(schema|contract|api|openapi|endpoint)/.test(q)) {
      return [
        { tool: 'read_file', input: { path: 'openapi.json' } },
        ({ lastResult }) => ({ text: lastResult?.content ? `Here is the OpenAPI contract (openapi.json):\n${lastResult.content}` : `The contract is: GET/POST /api/tasks, PATCH/DELETE /api/tasks/{id}; a task is {id, title, done, createdAt}. ${DISCLOSURE}` }),
      ];
    }
    return [{ text: `I can't reason about that question — I am running on the ${DISCLOSURE}.` }];
  }
  if (kind === 'chat') return [{ text: `Hello! I'm running on the ${DISCLOSURE}, so I can only follow fixed scripts. Configure a real provider (Anthropic, OpenAI or a local model) to talk with me properly.` }];

  // Work and review tasks, by role.
  if (kind === 'review' || role.includes('security')) {
    return [
      { tool: 'read_file', input: { path: 'server.js' } },
      ({ lastResult }) => ({ tool: 'complete_task', input: { summary: securityReview(String(lastResult?.content ?? '')) } }),
      { text: 'Review delivered.' },
    ];
  }
  if (/(backend|api|server)/.test(role)) {
    const fe = pick(team, ['frontend', 'front-end', 'web']);
    return [
      { tool: 'write_file', input: { path: 'openapi.json', content: OPENAPI }, say: 'Writing the API contract first.' },
      { tool: 'write_note', input: { title: 'API contract', body: 'Tasks API: GET /api/tasks, POST /api/tasks {title}, PATCH /api/tasks/{id} {title?, done?}, DELETE /api/tasks/{id}. See openapi.json.' } },
      fe ? { tool: 'send_message', input: { to: fe.name, kind: 'handoff', body: 'The API contract is in openapi.json: GET/POST /api/tasks, PATCH/DELETE /api/tasks/{id}; a task is {id, title, done, createdAt}.' } } : { tool: 'report_progress', input: { text: 'API contract written to openapi.json.' } },
      { tool: 'write_file', input: { path: 'server.js', content: SERVER_JS } },
      { tool: 'run_command', input: { command: 'node -e "const s=require(\'./server.js\');console.log(typeof s.createServer)"' } },
      ({ lastResult }) => ({ tool: 'complete_task', input: { summary: `Wrote the OpenAPI contract and a Node HTTP backend for tasks (list/create/update/delete, JSON validation, 16 KB body limit), and shared the contract with the frontend. Smoke check exit code ${lastResult?.exitCode}. ${DISCLOSURE}`, artifacts: ['openapi.json', 'server.js'] } }),
      { text: 'Backend delivered.' },
    ];
  }
  if (/(frontend|front-end|web|ui developer)/.test(role)) {
    const be = pick(team, ['backend', 'api', 'server']);
    return [
      be ? { tool: 'ask_agent', input: { agent: be.name, question: 'Please send the API schema so I can connect the frontend.' }, say: 'I need the API contract first.' } : { tool: 'read_file', input: { path: 'openapi.json' } },
      { tool: 'write_file', input: { path: 'public/index.html', content: INDEX_HTML } },
      { tool: 'write_file', input: { path: 'public/app.js', content: APP_JS } },
      ({ results }) => {
        const got = safeJson(results[0]?.content);
        const how = got?.answered ? `using the contract ${be?.name} sent` : 'using openapi.json';
        return { tool: 'complete_task', input: { summary: `Built the frontend (public/index.html, public/app.js) ${how}: lists tasks, adds, toggles done and deletes through /api/tasks. ${DISCLOSURE}`, artifacts: ['public/index.html', 'public/app.js'] } };
      },
      { text: 'Frontend delivered.' },
    ];
  }
  if (/(design|ux)/.test(role)) {
    return [
      { tool: 'write_file', input: { path: 'public/style.css', content: STYLE_CSS } },
      { tool: 'complete_task', input: { summary: `Wrote public/style.css: a readable single-column layout, clear done state, accessible contrast. ${DISCLOSURE}`, artifacts: ['public/style.css'] } },
      { text: 'Styles delivered.' },
    ];
  }
  if (/(qa|test|quality)/.test(role)) {
    return [
      { tool: 'list_files', input: {} },
      { tool: 'write_file', input: { path: 'tests/api.test.js', content: TEST_JS } },
      { tool: 'run_command', input: { command: 'node --test tests/api.test.js' } },
      ({ lastResult }) => {
        const ok = lastResult?.exitCode === 0;
        return { tool: 'complete_task', input: { summary: `Wrote tests/api.test.js covering create, list, update, delete, validation and 404s, and ran them in the sandbox: ${ok ? 'all passed' : `FAILED (exit ${lastResult?.exitCode}) — see the test report`}. ${DISCLOSURE}`, artifacts: ['tests/api.test.js'], tests: { command: 'node --test tests/api.test.js', exitCode: lastResult?.exitCode ?? -1, output: String(lastResult?.output ?? '') } } };
      },
      { text: 'Tests delivered.' },
    ];
  }
  return [
    { tool: 'write_file', input: { path: `notes/${env.me.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, content: `# Notes from ${env.me}\n\n${env.first.slice(0, 1500)}\n` } },
    { tool: 'complete_task', input: { summary: `Recorded the task brief and my notes. ${DISCLOSURE}`, artifacts: [`notes/${env.me.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`] } },
    { text: 'Done.' },
  ];
}

function securityReview(src) {
  const findings = [];
  const check = (cond, ok, bad) => findings.push(cond ? `- OK: ${ok}` : `- ISSUE: ${bad}`);
  check(/MAX_BODY|limit/i.test(src), 'request bodies are size-limited', 'no request body size limit');
  check(/typeof .*title.*string|title\.trim|validate/i.test(src), 'task titles are validated', 'inputs are not validated');
  check(!/eval\(|new Function|child_process/.test(src), 'no eval, dynamic code or shell execution', 'dynamic code execution present');
  check(/normalize|startsWith\(PUBLIC|path\.resolve/i.test(src), 'static file paths are confined to public/', 'static files may escape public/ (path traversal)');
  check(!/Access-Control-Allow-Origin', '\*'/.test(src), 'no wildcard CORS', 'wildcard CORS');
  findings.push('- NOTE: no authentication — acceptable for a local demo, required before exposing it to a network.');
  findings.push('- NOTE: data is kept in memory and lost on restart.');
  return [`Security review of server.js ${DISCLOSURE}.`, '', ...findings, '', `Verdict: ${findings.some((f) => f.startsWith('- ISSUE')) ? 'changes needed' : 'no blocking issues for local use'}.`].join('\n');
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

const OPENAPI = JSON.stringify({
  openapi: '3.0.3', info: { title: 'Tasks API', version: '1.0.0' },
  paths: {
    '/api/tasks': {
      get: { summary: 'List tasks', responses: { 200: { description: 'Tasks', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } } },
      post: { summary: 'Create a task', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewTask' } } } }, responses: { 201: { description: 'Created' }, 400: { description: 'Invalid' } } },
    },
    '/api/tasks/{id}': {
      patch: { summary: 'Update a task', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
      delete: { summary: 'Delete a task', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
  },
  components: { schemas: {
    Task: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, done: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' } }, required: ['id', 'title', 'done', 'createdAt'] },
    NewTask: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['title'] },
  } },
}, null, 2);

const SERVER_JS = `// Tasks API and static frontend. Run: node server.js  (PORT env, default 3000)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 16 * 1024;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function createServer() {
  const tasks = new Map();
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; let tooBig = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { if (!tooBig) { tooBig = true; reject(Object.assign(new Error('too large'), { code: 413 })); } } else chunks.push(c); });
    req.on('end', () => { if (tooBig) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
  });
  const validTitle = (t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 200;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, [...tasks.values()]);
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        const body = await readJson(req);
        if (!validTitle(body.title)) return send(res, 400, { error: 'title is required (1-200 chars)' });
        const task = { id: crypto.randomUUID(), title: body.title.trim(), done: false, createdAt: new Date().toISOString() };
        tasks.set(task.id, task);
        return send(res, 201, task);
      }
      const m = url.pathname.match(/^\\/api\\/tasks\\/([\\w-]+)$/);
      if (m) {
        const task = tasks.get(m[1]);
        if (!task) return send(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          const body = await readJson(req);
          if (body.title !== undefined && !validTitle(body.title)) return send(res, 400, { error: 'bad title' });
          if (body.done !== undefined && typeof body.done !== 'boolean') return send(res, 400, { error: 'done must be boolean' });
          Object.assign(task, body.title !== undefined ? { title: body.title.trim() } : {}, body.done !== undefined ? { done: body.done } : {});
          return send(res, 200, task);
        }
        if (req.method === 'DELETE') { tasks.delete(task.id); return send(res, 204); }
      }
      if (req.method === 'GET') {
        const file = path.resolve(PUBLIC, '.' + path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
      send(res, 405, { error: 'method not allowed' });
    } catch (err) {
      send(res, err.code === 413 ? 413 : 400, { error: err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log('Tasks app on http://localhost:' + port));
}
module.exports = { createServer };
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tasks</title><link rel="stylesheet" href="/style.css"></head>
<body>
  <main>
    <h1>Tasks</h1>
    <form id="add"><input id="title" placeholder="What needs doing?" maxlength="200" required><button>Add</button></form>
    <ul id="list"></ul>
  </main>
  <script src="/app.js"></script>
</body>
</html>
`;

const APP_JS = `// Talks to the Tasks API described in openapi.json.
const list = document.getElementById('list');
const api = (path, opts = {}) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then((r) => (r.status === 204 ? null : r.json()));

async function render() {
  const tasks = await api('/api/tasks');
  list.replaceChildren(...tasks.map((t) => {
    const li = document.createElement('li');
    li.className = t.done ? 'done' : '';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: t.done });
    box.onchange = () => api('/api/tasks/' + t.id, { method: 'PATCH', body: JSON.stringify({ done: box.checked }) }).then(render);
    const label = Object.assign(document.createElement('span'), { textContent: t.title });
    const del = Object.assign(document.createElement('button'), { textContent: 'Delete' });
    del.onclick = () => api('/api/tasks/' + t.id, { method: 'DELETE' }).then(render);
    li.append(box, label, del);
    return li;
  }));
}

document.getElementById('add').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('title');
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: input.value }) });
  input.value = '';
  render();
};
render();
`;

const STYLE_CSS = `body { font: 16px/1.5 system-ui, sans-serif; background: #f6f7f9; color: #1d2330; margin: 0; }
main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
form { display: flex; gap: 8px; }
input#title { flex: 1; padding: 10px 12px; border: 1px solid #c9ced8; border-radius: 8px; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: #3d6fd6; color: #fff; cursor: pointer; }
ul { list-style: none; padding: 0; }
li { display: flex; align-items: center; gap: 10px; background: #fff; margin: 8px 0; padding: 10px 12px; border-radius: 8px; }
li span { flex: 1; }
li.done span { text-decoration: line-through; color: #7a8290; }
li button { background: #e8ebf0; color: #1d2330; }
`;

const TEST_JS = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server.js');

test('tasks API: create, list, update, delete, validation', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const j = (p, o = {}) => fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...o });
  try {
    assert.deepStrictEqual(await (await j('/api/tasks')).json(), []);
    assert.strictEqual((await j('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '' }) })).status, 400);
    const created = await (await j('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Write tests' }) })).json();
    assert.strictEqual(created.title, 'Write tests');
    assert.strictEqual(created.done, false);
    const updated = await (await j('/api/tasks/' + created.id, { method: 'PATCH', body: JSON.stringify({ done: true }) })).json();
    assert.strictEqual(updated.done, true);
    assert.strictEqual((await j('/api/tasks/' + created.id, { method: 'PATCH', body: JSON.stringify({ done: 'yes' }) })).status, 400);
    assert.strictEqual((await j('/api/tasks/' + created.id, { method: 'DELETE' })).status, 204);
    assert.strictEqual((await j('/api/tasks/' + created.id, { method: 'DELETE' })).status, 404);
    assert.strictEqual((await j('/api/tasks', { method: 'POST', body: 'x'.repeat(20000) })).status, 413);
  } finally {
    server.close();
  }
});
`;

module.exports = { createScripted, DISCLOSURE };
