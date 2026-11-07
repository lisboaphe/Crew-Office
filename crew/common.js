// Small shared helpers for the lobby and the in-office overlay. No framework: a DOM
// builder, an API client, toasts, modals, and the browser half of crash reporting.

export const BRAND = 'Crew Office';

/** h('div.card', {onclick}, child, …) — strings become text nodes, never HTML. */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; } }
    else if (k === 'class') el.className += ` ${v}`;
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Crew': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

let toastWrap = null;
export function toast(text, ms = 3500) {
  if (!toastWrap) { toastWrap = h('div.cr.cr-toast-wrap'); document.body.append(toastWrap); }
  const t = h('div.cr-toast', text);
  toastWrap.append(t);
  setTimeout(() => t.remove(), ms);
}

/** A modal dialog. `build(close)` returns its content; resolves when closed. */
export function modal(title, build) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') close(null); };
    const box = h('div.cr-modal', { role: 'dialog', 'aria-label': title }, h('h2', title), build(close));
    const back = h('div.cr.cr-modal-back', { onclick: (e) => { if (e.target === back) close(null); } }, box);
    document.addEventListener('keydown', esc);
    document.body.append(back);
    box.querySelector('input,textarea,select')?.focus();
  });
}

const COLOURS = ['#e07a5f', '#f15bb5', '#9b5de5', '#3d85c6', '#00bbf9', '#2a9d8f', '#81b29a', '#f2cc8f'];

/** A row of colour swatches. Read the choice from the element's `.value`. */
export function colourPicker(initial) {
  const row = h('div.cr-swatches', { role: 'radiogroup', 'aria-label': 'Colour' });
  row.value = initial && COLOURS.includes(initial) ? initial : COLOURS[Math.floor(Math.random() * COLOURS.length)];
  const paint = () => { for (const b of row.children) { const on = b.dataset.colour === row.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } };
  row.append(...COLOURS.map((c) => h('button', { type: 'button', role: 'radio', 'aria-label': c, 'data-colour': c, style: { background: c }, onclick: () => { row.value = c; paint(); } })));
  paint();
  return row;
}

/** A small “?” that explains something on hover or keyboard focus. */
export function helpTip(title, lines) {
  return h('span.cr-help', { tabIndex: 0, role: 'button', 'aria-label': `Help: ${title}` }, '?',
    h('span.cr-help-tip', { role: 'tooltip' }, h('b', title), h('ol', ...lines.map((l) => h('li', l)))));
}

const ICONS = {
  office: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 10h.01M15 10h.01"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.9c1.6.8 2.6 2.4 3 5.1"/>',
  orchestrator: '<circle cx="5" cy="6" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 6c5 0 4 6 9 6M7.5 18c5 0 4-6 9-6"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  connections: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  workspace: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  ai: '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 7V3M9 12v2M15 12v2M2 12v3M22 12v3"/>',
  multiplayer: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.8M18 14.5c1.9.9 3 2.9 3 5.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  building: '<path d="M4 21V6l8-3 8 3v15M4 21h16M9 9h.01M15 9h.01M9 13h.01M15 13h.01M10 21v-4h4v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M6 8h0M12 8h0M18 8h0"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  git: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M18 11.4c0 3-3 3.6-6 4-2 .3-3.6.6-4.6 1.5"/>',
  memory: '<path d="M12 4c-3 0-5 2-5 4.5C5 9 4 10.5 4 12s1 3 3 3.5C7 18 9 20 12 20s5-2 5-4.5c2-.5 3-2 3-3.5s-1-3-3-3.5C17 6 15 4 12 4z"/><path d="M12 4v16M8 11h4M12 14h4"/>',
  door: '<path d="M5 21V4a1 1 0 0 1 1-1h9v18M3 21h16M19 8v13M11 12h.01"/>',
  plugin: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
  rules: '<path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  graph: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8.5 7h7M7.5 9l8 7.5M6 9.5v5M8.5 17h6"/>',
};

export function icon(name) {
  const box = h('span.cr-icon', { 'aria-hidden': 'true' });
  box.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
  return box;
}

/** Deleting an office cannot be undone, so the name has to be typed. Resolves true if it went. */
export function confirmDeleteOffice(room) {
  return modal('Delete this office?', (close) => {
    const name = h('input', { placeholder: room.name, autocomplete: 'off' });
    const err = h('p.error');
    const go = async () => {
      err.textContent = '';
      try {
        await api('POST', `/api/crew/rooms/${room.id}/delete`, { confirm: name.value });
        close(true);
      } catch (e) { err.textContent = e.message; }
    };
    return h('div',
      h('p', 'This permanently deletes the office and everything in it: its projects, tasks, messages, files, Git repositories and agents. Everyone in it is sent back to the lobby. It cannot be undone.'),
      h('p.hint', 'Want to keep a copy? Press Export office under Dashboard → Office first.'),
      h('label', `Type “${room.name}” to confirm`), name, err,
      h('div.actions', h('button.btn', { onclick: () => close(false) }, 'Keep it'), h('button.btn.danger', { onclick: go }, 'Delete office')));
  });
}

let updateCheck = null;

/**
 * The update option, on the computer that hosts and nowhere else. It is always there, and turns
 * into “Update available” once there is one, so finding out never depends on being told.
 */
export function updateNotice() {
  const slot = h('span.cr-update');
  updateCheck ??= api('GET', '/api/crew/update').catch(() => null);
  updateCheck.then((u) => {
    if (!u || (u.available === false && u.enabled === undefined)) return; // Not the hosting computer.
    slot.replaceChildren(u.available
      ? h('button.btn.primary', { onclick: () => updateDialog(u), title: `Build ${u.latest.build} is ready to install` }, 'Update available')
      : h('button.btn.small', { onclick: () => updateDialog(u), title: 'Check GitHub for a newer version' }, 'Check for updates'));
  });
  return slot;
}

function updateDialog(first) {
  modal('Update Crew Office', (close) => {
    const body = h('div');
    const err = h('p.error');
    const install = async (u) => {
      err.textContent = '';
      try {
        await api('POST', '/api/crew/update/install');
        close();
        waitForUpdate(u.current.build);
      } catch (e) { err.textContent = e.message; }
    };
    const check = async () => {
      body.replaceChildren(h('p.hint', 'Asking GitHub…'));
      try { draw(await api('GET', '/api/crew/update?force=1')); } catch (e) { body.replaceChildren(h('p.error', e.message)); }
    };
    const cancel = (label) => h('button.btn', { onclick: () => close() }, label);
    const again = () => h('button.btn', { onclick: check }, 'Check again');
    const draw = (u) => {
      if (!u.enabled) { body.replaceChildren(h('p', u.reason), h('div.actions', cancel('Close'))); return; }
      const have = `You have build ${u.current.build}${u.current.commit ? ` (${String(u.current.commit).slice(0, 7)})` : ''}.`;
      if (u.needsSignIn) {
        body.replaceChildren(h('p', 'This app’s updates come from a private repository, so GitHub needs to know it is you.'),
          h('p.hint', `${have} Sign in once with an account that can see ${u.repo}. It uses the official GitHub CLI, in its own window, and nothing here sees your password.`), err,
          h('div.actions', cancel('Not now'), again(), h('button.btn.primary', { onclick: async () => { err.textContent = ''; try { const r = await api('POST', '/api/crew/update/sign-in'); err.textContent = r.command ? `Run this in a terminal, then press Check again: ${r.command}` : 'A black window opened with a one-time code. Copy the code, press Enter there, and paste it into the GitHub page that opens. Then press Check again. If no window opened, install GitHub CLI from cli.github.com first.'; } catch (e) { err.textContent = e.message; } } }, 'Sign in to GitHub')));
        return;
      }
      if (u.error) { body.replaceChildren(h('p', 'Could not check for updates.'), h('p.hint', u.error), h('div.actions', cancel('Close'), again())); return; }
      if (!u.available) { body.replaceChildren(h('p', u.latest ? 'You are up to date.' : 'No version has been published yet.'), h('p.hint', `${have}${u.latest ? ` The newest published is build ${u.latest.build}.` : ''}`), h('div.actions', cancel('Close'), again())); return; }
      body.replaceChildren(h('p', `Build ${u.latest.build} is ready. ${have}`), ...(u.canInstall
        ? [h('p.hint', 'It downloads from GitHub, is checked against its published checksum, and installs over this one. The office stops for a moment and everyone in it is disconnected until it is back. Your offices, projects and sign-ins are kept. Close any worker window first: it runs from the same folder as the app.'),
          err, h('div.actions', cancel('Not now'), h('button.btn.primary', { onclick: () => install(u) }, 'Update now'))]
        : [h('p.hint', u.reason), h('div.actions', cancel('Close'), h('a.btn.primary', { href: u.latest.url, target: '_blank', rel: 'noopener' }, 'Open the download page'))]));
    };
    draw(first);
    check();
    return body;
  });
}

function waitForUpdate(from) {
  const note = h('p.hint', 'Installing. This usually takes under a minute.');
  const back = h('div.cr.cr-modal-back', h('div.cr-modal', h('h2', 'Updating Crew Office…'), note));
  document.body.append(back);
  const started = Date.now();
  const poll = setInterval(async () => {
    let info = null;
    try { info = await api('GET', '/api/crew/host-info'); } catch { /* still restarting */ }
    if (info && info.build !== from) { clearInterval(poll); location.reload(); return; }
    if (Date.now() - started > 180_000) {
      clearInterval(poll);
      note.textContent = info ? 'The update did not install, so you are still on the old build. The reason is in update.log in the Crew Office data folder.' : 'The office has not come back. Start Crew Office from its shortcut.';
      back.firstChild.append(h('div.actions', h('button.btn', { onclick: () => back.remove() }, 'Close')));
    }
  }, 2000);
}

export function initials(name) {
  return String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export function avatar(name, color, { ai = false, online = false, title } = {}) {
  return h('span.avatar', { class: ai ? 'ai' : '', style: { background: color || '#8d99ae' }, title: title ?? name }, initials(name), online ? h('span.on') : null);
}

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const money = (usd) => `$${Number(usd || 0).toFixed(usd < 1 ? 4 : 2)}`;

/** Errors in the page become crash logs on the host, rate-limited there. */
export function reportErrors(context) {
  const send = (message, stack) => {
    fetch('/api/crew/client-error', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Crew': '1' }, body: JSON.stringify({ context, message, stack, url: location.pathname }) }).catch(() => {});
  };
  window.addEventListener('error', (e) => send(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => send(String(e.reason?.message ?? e.reason), e.reason?.stack));
}

