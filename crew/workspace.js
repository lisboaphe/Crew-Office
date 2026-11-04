// The dashboard tabs for shared work: Git / Sync, Office files, and Rules. They read and write
// the host's real state; nothing here is decorative.

import { h, api, toast, modal, ago } from './common.js';

// --- Git / Sync --------------------------------------------------------------------------

const STATUS_WORDS = {
  open: 'in review', changes_requested: 'changes requested', approved: 'approved', awaiting_merge_approval: 'waiting for merge approval',
  merged: 'merged', conflict: 'merge conflict', needs_reviewer: 'needs a reviewer', needs_human: 'needs a human decision',
};

export function gitTab(body, ctx) {
  const { S, roomId, ui, render } = ctx;
  const p = S.projects.find((x) => x.id === ui.projectId) ?? S.projects[0];
  if (!p) { body.append(h('p.hint', 'No projects yet. Create one under Projects.')); return; }
  ui.projectId = p.id;
  if (!S.gitAvailable) body.append(h('p.error', 'Git is not installed on the host computer, so shared repositories are unavailable. Install Git and restart the host.'));
  const load = () => api('GET', `/api/crew/rooms/${roomId}/projects/${p.id}/git`).then((d) => { ui.git = { projectId: p.id, ...d }; render(); }).catch((e) => toast(e.message));
  ui.reloadGit = load;
  body.append(h('div.row', h('select', { onchange: (e) => { ui.projectId = e.target.value; ui.git = null; render(); } }, ...S.projects.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name))),
    h('span.grow'), p.members.includes(S.me.id) ? h('button.btn.primary', { onclick: () => newRepo(p, ctx) }, 'New repository') : null));
  if (ui.git?.projectId !== p.id) { body.append(h('p.hint', 'Loading…')); load(); return; }
  const { repos, merges, links } = ui.git;
  if (!repos.length) {
    body.append(h('p.hint', 'No repositories yet. A repository lives on this host: agents clone it, work on their own branches, and changes reach main only through review. GitHub is not needed.'));
    return;
  }
  body.append(syncModeControl(p, ctx));
  const open = merges.filter((m) => m.status !== 'merged');
  body.append(h('h3', `Merge requests (${open.length} open)`));
  body.append(h('div.cr-list', ...(merges.length ? merges.map((m) => mergeView(m, ctx)) : [h('p.hint', 'None yet. An agent opens one when its branch is ready.')])));
  for (const r of repos) body.append(repoView(r, p, ctx));
  if (links.length) {
    body.append(h('h3', 'Contract dependencies'));
    for (const l of links) body.append(h('p.hint', `${S.projects.find((x) => x.id === l.dependentProjectId)?.name ?? '?'} depends on ${l.repoName}/${l.contractPath}`, l.lastCommit ? ` (last seen ${l.lastCommit.slice(0, 8)})` : ''));
  }
  if (p.createdBy === S.me.id) body.append(h('div.row', { style: { marginTop: '8px' } }, h('button.btn', { onclick: () => linkContract(p, ctx) }, 'Depend on a contract in another project')));
}

function syncModeControl(p, ctx) {
  const { S, roomId } = ctx;
  const mine = p.createdBy === S.me.id;
  const words = { smart: 'Smart: tests, then commit and push', live: 'Live: drafts pushed as they change, kept apart from reviewed work', manual: 'Manual: commit locally; publish when told' };
  const sel = h('select', { disabled: !mine, onchange: async (e) => { await api('PUT', `/api/crew/rooms/${roomId}/rules/project/${p.id}`, { rules: { ...(ctx.ui.projectRules?.[p.id] ?? {}), syncMode: e.target.value } }).catch((err) => toast(err.message)); toast('Sync mode saved'); } },
    ...Object.entries(words).map(([k, v]) => h('option', { value: k }, v)));
  api('GET', `/api/crew/rooms/${roomId}/rules?projectId=${p.id}`).then((r) => { sel.value = r.effective.syncMode.value; }).catch(() => {});
  return h('div.row', { style: { margin: '8px 0' } }, h('b', 'Sync mode'), sel);
}

function mergeView(m, ctx) {
  const { S } = ctx;
  const words = STATUS_WORDS[m.status] ?? m.status;
  const cls = m.status === 'merged' ? 'ok' : ['conflict', 'needs_human'].includes(m.status) ? 'bad' : 'warn';
  return h('div.cr-item',
    h('div.row', h('b.grow', `${m.repoName}: ${m.branch}`), h('span.pill', { class: cls }, words), m.tests ? h('span.pill', { class: m.tests === 'passed' ? 'ok' : 'warn' }, `tests ${m.tests}`) : null),
    h('p.hint', `${m.authorName}${m.reviewerName ? ` · reviewer ${m.reviewerName}` : ''} · ${ago(m.updatedAt)}${m.mergeCommit ? ` · ${m.mergeCommit.slice(0, 10)}` : ''}`),
    h('p', { style: { margin: '4px 0' } }, m.summary),
    m.comments.length ? h('details', h('summary', `${m.comments.length} review comment(s)`), ...m.comments.map((c) => h('p.hint', `${c.authorName}${c.verdict ? ` [${c.verdict.replace('_', ' ')}]` : ''}${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body}`))) : null,
    h('div.row', h('button.btn.small', { onclick: () => showDiff(m.repoId, m.branch, ctx) }, 'View diff'), m.taskId && S.tasks.find((t) => t.id === m.taskId) ? h('button.btn.small', { onclick: () => ctx.taskDetail(S.tasks.find((t) => t.id === m.taskId)) }, 'Task') : null));
}

function repoView(r, p, ctx) {
  const { S, roomId } = ctx;
  const cloneUrl = `${location.origin}${r.url}`;
  return h('div', { style: { marginTop: '12px' } },
    h('h3', `Repository: ${r.name}`),
    h('p.hint', 'Clone: ', h('code', cloneUrl), ' ', h('button.btn.small', { onclick: () => gitToken(ctx) }, 'Get a Git password')),
    h('div.cr-list', ...r.branches.map((b) => h('div.cr-item.row',
      h('code.grow', b.name), b.protected ? h('span.pill.ok', 'protected') : null,
      b.protected ? null : h('span.muted', `${b.ahead} ahead, ${b.behind} behind`), h('span.hint', b.subject?.slice(0, 40) ?? ''),
      b.protected ? null : h('button.btn.small', { onclick: () => showDiff(r.id, b.name, ctx) }, 'Diff')))),
    h('details', { style: { marginTop: '8px' } }, h('summary', `History (${r.events.length})`),
      ...r.events.map((e) => h('p.hint', `${ago(e.createdAt)} · ${e.kind} ${String(e.ref ?? '').replace('refs/heads/', '')} ${String(e.new ?? '').slice(0, 8)}${e.agentId ? ` · ${S.agents.find((a) => a.id === e.agentId)?.name ?? 'agent'}` : ''}${e.tests ? ` · tests ${e.tests}` : ''}${e.files.length ? ` · ${e.files.length} file(s)` : ''}`))),
    h('div.row', { style: { marginTop: '8px' } },
      h('button.btn.small', { onclick: async () => { await api('POST', `/api/crew/rooms/${roomId}/repos/${r.id}/snapshots`, { label: 'manual' }).catch((e) => toast(e.message)); toast('Snapshot saved'); ctx.ui.reloadGit?.(); } }, 'Save snapshot'),
      r.snapshots.length && p.createdBy === S.me.id ? h('select', { onchange: async (e) => {
        if (!e.target.value) return;
        if (confirm(`Make main look like ${e.target.value} again? This adds a new commit; nothing is deleted.`)) { await api('POST', `/api/crew/rooms/${roomId}/repos/${r.id}/rollback`, { tag: e.target.value }).catch((err) => toast(err.message)); ctx.ui.reloadGit?.(); }
        e.target.value = '';
      } }, h('option', { value: '' }, 'Roll back to…'), ...r.snapshots.map((s) => h('option', { value: s.tag }, s.tag))) : null));
}

async function showDiff(repoId, branch, ctx) {
  try {
    const d = await api('GET', `/api/crew/rooms/${ctx.roomId}/repos/${repoId}/diff?branch=${encodeURIComponent(branch)}`);
    modal(`Diff: ${branch}`, (close) => h('div', h('pre', d.stat || 'No changes.'), h('pre', d.patch), h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'))));
  } catch (e) { toast(e.message); }
}

function newRepo(p, ctx) {
  return modal('New repository', (close) => {
    const name = h('input', { placeholder: 'website, bot, desktop-app…' });
    const err = h('p.error');
    const save = async () => {
      try { await api('POST', `/api/crew/rooms/${ctx.roomId}/projects/${p.id}/repos`, { name: name.value }); close(); ctx.ui.git = null; ctx.render(); toast('Repository created. Agents with Git permission can now work in it.'); } catch (e) { err.textContent = e.message; }
    };
    return h('div', h('label', 'Name'), name, h('p.hint', 'It is hosted on this office’s host. `main` is protected: changes reach it only through review.'), err, h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Create')));
  });
}

async function gitToken(ctx) {
  try {
    const { token } = await api('POST', `/api/crew/rooms/${ctx.roomId}/git-tokens`, { label: 'Personal' });
    modal('Your Git password', (close) => h('div', h('p', 'Use any username and this as the password, with your own Git client. It is shown once.'), h('pre', token), h('p.hint', 'You can push only to user/… branches and your own agents’ branches.'), h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'))));
  } catch (e) { toast(e.message); }
}

function linkContract(p, ctx) {
  const { S } = ctx;
  const others = (S.repos ?? []).filter((r) => r.projectId !== p.id);
  if (!others.length) { toast('No other project has a repository yet.'); return null; }
  return modal(`What does “${p.name}” depend on?`, (close) => {
    const repo = h('select', ...others.map((r) => h('option', { value: r.id }, `${S.projects.find((x) => x.id === r.projectId)?.name}: ${r.name}`)));
    const file = h('input', { value: 'openapi.json' });
    const err = h('p.error');
    const save = async () => {
      try { await api('POST', `/api/crew/rooms/${ctx.roomId}/contracts`, { dependentProjectId: p.id, providerRepoId: repo.value, contractPath: file.value }); close(); ctx.ui.git = null; ctx.render(); toast('Linked. A merge changing that file now notifies this project.'); } catch (e) { err.textContent = e.message; }
    };
    return h('div', h('label', 'Repository'), repo, h('label', 'Contract file'), file, h('p.hint', 'When a merge changes this file, this project gets a summary, the new contract, and a task to adapt. It is not sent the other project’s code.'), err, h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Link')));
  });
}

// --- Office files --------------------------------------------------------------------------

export function filesTab(body, ctx) {
  const { S, roomId, ui, render } = ctx;
  const p = S.projects.find((x) => x.id === ui.projectId) ?? S.projects[0];
  if (!p) { body.append(h('p.hint', 'No projects yet.')); return; }
  ui.projectId = p.id;
  const U = `/api/crew/rooms/${roomId}/projects/${p.id}`;
  const load = () => api('GET', `${U}/blobs`).then((d) => { ui.blobs = { projectId: p.id, ...d }; render(); }).catch((e) => toast(e.message));
  ui.reloadFiles = load;
  const input = h('input', { type: 'file', style: { display: 'none' }, onchange: (e) => { const f = e.target.files[0]; if (f) uploadBrowser(f, U, ctx).then(load); e.target.value = ''; } });
  body.append(h('div.row', h('select', { onchange: (e) => { ui.projectId = e.target.value; ui.blobs = null; render(); } }, ...S.projects.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name))), h('span.grow'),
    p.members.includes(S.me.id) ? h('button.btn.primary', { onclick: () => input.click() }, 'Upload a file') : null, input));
  body.append(h('p.hint', 'Releases, images, designs and other binaries. Source code belongs in Git / Sync. Transfers resume if the connection drops, and files are verified before anyone is told they are ready.'));
  if (ui.upload) body.append(h('div.cr-item', h('b', ui.upload.name), h('div.cr-progress', h('div', { style: { width: `${ui.upload.pct}%` } })), h('div.hint', ui.upload.note)));
  if (ui.blobs?.projectId !== p.id) { body.append(h('p.hint', 'Loading…')); load(); return; }
  const { files, usedBytes, quotaBytes } = ui.blobs;
  const mb = (n) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;
  body.append(h('p.hint', `${mb(usedBytes)} of ${mb(quotaBytes)} used`));
  body.append(h('div.cr-list', ...(files.length ? files.map((f) => h('div.cr-item',
    h('div.row', h('code.grow', f.path), h('span.pill', `v${f.version}`), h('span.muted', `${mb(f.size)} · ${f.byName} · ${ago(f.createdAt)}`), h('a.btn.small', { href: `${U}/blobs/${f.id}`, download: '' }, 'Download')),
    f.note ? h('p.hint', f.note) : null,
    f.history.length > 1 ? h('details', h('summary', `${f.history.length} versions`), ...f.history.map((v) => h('div.row.hint', `v${v.version} · ${mb(v.size)} · ${v.byName} · ${ago(v.createdAt)} · ${v.sha256.slice(0, 12)}`, h('a.btn.small', { href: `${U}/blobs/${v.id}`, download: '' }, 'Download')))) : null)) : [h('p.hint', 'No files yet.')])));
}

/** SHA-256 in plain JS for plain-http LAN pages, where crypto.subtle does not exist. */
function sha256Fallback(bytes) {
  const K = [];
  const isPrime = (n) => { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) | 0;
  const H = [];
  for (let n = 2; K.length < 64; n++) if (isPrime(n)) { if (H.length < 8) H.push(frac(n ** (1 / 2))); K.push(frac(n ** (1 / 3))); }
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(len / 2 ** 29));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getInt32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      w[t] = (w[t - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[t - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

async function sha256Hex(buffer) {
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(new Uint8Array(buffer));
}

/** Chunked upload from the browser. A dropped connection waits and resumes from what arrived. */
async function uploadBrowser(file, U, ctx) {
  const { ui, render } = ctx;
  const progress = (pct, note) => { ui.upload = { name: file.name, pct, note }; render(); };
  try {
    progress(0, 'Checking the file…');
    const buffer = await file.arrayBuffer();
    const sha256 = await sha256Hex(buffer);
    const begun = await api('POST', `${U}/uploads`, { path: `uploads/${file.name.replace(/[^\w.-]+/g, '_')}`, size: file.size, sha256 });
    if (begun.done) { ui.upload = null; toast('The host already had these bytes: published as a new version, nothing sent.'); return; }
    let received = new Set(begun.received);
    for (let i = 0; i < begun.chunks; i++) {
      if (received.has(i)) continue;
      const part = buffer.slice(i * begun.chunkSize, (i + 1) * begun.chunkSize);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`${U}/uploads/${begun.uploadId}/chunks/${i}`, { method: 'PUT', headers: { 'X-Crew': '1', 'Content-Type': 'application/octet-stream' }, body: part });
          if (res.status >= 400 && res.status < 500) throw Object.assign(new Error((await res.json().catch(() => ({}))).error ?? `Refused (${res.status})`), { final: true });
          if (!res.ok) throw new Error(`Host error ${res.status}`);
          break;
        } catch (e) {
          if (e.final) throw e;
          progress(Math.round((i / begun.chunks) * 100), `Connection lost; retrying (attempt ${attempt + 1}). Nothing already sent is lost.`);
          await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
          try { received = new Set((await api('GET', `${U}/uploads/${begun.uploadId}`)).received); if (received.has(i)) break; } catch { /* still offline */ }
        }
      }
      progress(Math.round(((i + 1) / begun.chunks) * 100), `${i + 1} of ${begun.chunks} parts sent`);
    }
    await api('POST', `${U}/uploads/${begun.uploadId}/finalize`);
    ui.upload = null;
    toast('Uploaded and verified.');
  } catch (e) {
    ui.upload = null;
    toast(e.message, 6000);
  }
}

// --- Rules ---------------------------------------------------------------------------------

export function rulesTab(body, ctx) {
  const { S, roomId, ui, render } = ctx;
  const scopes = [];
  if (['owner', 'admin'].includes(S.room.myRole)) scopes.push({ key: 'office', id: roomId, label: 'Office defaults' });
  for (const p of S.projects.filter((x) => x.createdBy === S.me.id)) scopes.push({ key: 'project', id: p.id, label: `Project: ${p.name}`, q: `projectId=${p.id}` });
  scopes.push({ key: 'team', id: S.me.id, label: 'My team', q: `ownerId=${S.me.id}` });
  for (const a of S.agents.filter((x) => x.ownerId === S.me.id)) scopes.push({ key: 'agent', id: a.id, label: `Agent: ${a.name}`, q: `agentId=${a.id}` });
  const cur = scopes.find((s) => `${s.key}:${s.id}` === ui.ruleScope) ?? scopes[0];
  ui.ruleScope = `${cur.key}:${cur.id}`;
  body.append(h('p.hint', 'Rules are inherited: Office → Project → Team → Agent → Task. The most specific setting wins, and each line shows where its value came from. Enforced rules are checked by the host; the others are instructions to the agent.'));
  body.append(h('div.row', h('select', { onchange: (e) => { ui.ruleScope = e.target.value; ui.rules = null; render(); } }, ...scopes.map((s) => h('option', { value: `${s.key}:${s.id}`, selected: s === cur }, s.label)))));
  if (ui.rules?.scope !== ui.ruleScope) {
    body.append(h('p.hint', 'Loading…'));
    api('GET', `/api/crew/rooms/${roomId}/rules?${cur.q ?? ''}`).then((r) => { ui.rules = { scope: ui.ruleScope, eff: r.effective, draft: {} }; render(); }).catch((e) => toast(e.message));
    return;
  }
  const { eff, draft } = ui.rules;
  const row = (k, r) => {
    const value = draft[k] !== undefined ? draft[k] : r.value;
    const def = S.rulesCatalog[k];
    let input;
    if (def.type === 'bool') input = h('input', { type: 'checkbox', checked: Boolean(value), onchange: (e) => { draft[k] = e.target.checked; } });
    else if (def.type === 'enum') input = h('select', { onchange: (e) => { draft[k] = e.target.value; } }, ...def.values.map((v) => h('option', { value: v, selected: v === value }, v)));
    else input = h('input', { value: value ?? '', placeholder: 'none', onchange: (e) => { draft[k] = e.target.value; } });
    return h('div.cr-item.row', { style: { padding: '6px 10px' } }, input, h('span.grow', r.label), def.optional ? h('span.pill', 'optional') : null,
      h('span.pill', { class: r.enforced ? 'ok' : '', title: r.enforced ? 'The host checks this' : 'An instruction to the agent' }, r.enforced ? 'enforced' : 'instruction'), h('span.hint', `from ${r.source}`));
  };
  body.append(h('div.cr-list', { style: { marginTop: '8px' } }, ...Object.entries(eff).map(([k, r]) => row(k, r))));
  body.append(h('div.row', { style: { marginTop: '10px' } },
    h('button.btn.primary', { onclick: async () => {
      if (!Object.keys(draft).length) { toast('Nothing changed'); return; }
      try { await api('PUT', `/api/crew/rooms/${roomId}/rules/${cur.key}/${cur.id}`, { rules: draft }); toast('Saved as a new version'); ui.rules = null; render(); } catch (e) { toast(e.message, 6000); }
    } }, `Save for ${cur.label}`),
    h('button.btn', { onclick: async () => {
      const { history } = await api('GET', `/api/crew/rooms/${roomId}/rules/${cur.key}/${cur.id}/history`);
      modal('Rule history', (close) => h('div', ...(history.length ? history.map((v) => h('p.hint', `v${v.version} · ${v.updatedBy} · ${ago(v.updatedAt)}: ${JSON.stringify(v.rules)}`)) : [h('p.hint', 'No changes at this level yet.')]), h('div.actions', h('button.btn', { onclick: () => close() }, 'Close'))));
    } }, 'History')));
  const modes = S.riskTable;
  body.append(h('h3', 'What each approval mode asks a human'));
  body.append(h('div.cr-list', ...Object.values(modes).map((r) => h('div.row.hint', h('span.grow', r.label), r.always ? h('span.pill.warn', 'always asks') : h('span', ['manual', 'balanced', 'autonomous'].filter((m) => r[m]).join(', ') || 'never')))));
}
