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
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
    try { navigator.sendBeacon?.('/api/crew/client-error', new Blob([JSON.stringify({ context, message, stack, url: location.pathname })], { type: 'application/json' })); } catch {}
  };
  window.addEventListener('error', (e) => send(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => send(String(e.reason?.message ?? e.reason), e.reason?.stack));
}

export const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="12" fill="#3d6fd6"/><circle cx="18" cy="19" r="5.5" fill="#fff"/><circle cx="31" cy="19" r="5.5" fill="#cfe0ff"/><path d="M8.5 37c0-5.5 4.2-9 9.5-9s9.5 3.5 9.5 9" fill="#fff"/><path d="M21.5 37c0-5.5 4.2-9 9.5-9s9.5 3.5 9.5 9" fill="#cfe0ff"/></svg>`;
