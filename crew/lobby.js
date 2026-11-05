// The lobby: pick a name, Host Office, Join Office, and your offices.
//
// Like a game lobby, this page is served by whichever machine you opened it on. Hosting
// creates the office on *this* host; joining by code or invitation joins an office on this
// host; joining by address sends you to another host's lobby, where you pick a name for
// that host.

import { h, api, toast, avatar, modal, colourPicker, confirmDeleteOffice, updateNotice, BRAND, reportErrors } from './common.js';
import { openTutorial, tutorialOnFirstVisit } from './tutorial.js';

reportErrors('lobby');
const root = document.getElementById('lobby');
const params = new URLSearchParams(location.search);
let me = null;
let info = null;
let thisComputer = { owner: false, players: [] };

/** The app's window arrives carrying this computer's key. Trade it for a cookie, and tidy the address. */
async function pairWithComputer() {
  const key = params.get('this-pc');
  if (!key) return;
  params.delete('this-pc');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  try { await api('POST', '/api/crew/this-computer/pair', { key }); } catch { /* another host's key: carry on as anyone would */ }
}

async function boot() {
  await pairWithComputer();
  [{ user: me }, info, thisComputer] = await Promise.all([api('GET', '/api/crew/me'), api('GET', '/api/crew/host-info'), api('GET', '/api/crew/this-computer')]);
  document.title = `${BRAND} — Lobby`;
  if (me && params.get('invite') && await acceptInvite()) return;
  await refreshInternet();
  render();
  if (me) tutorialOnFirstVisit();
}

/** An invitation link goes straight in: the link was the whole of the asking. */
async function acceptInvite() {
  try {
    const { room } = await api('POST', '/api/crew/rooms/join', { invite: params.get('invite') });
    location.href = `/office/${room.code}`;
    return true;
  } catch (e) { toast(e.message, 6000); return false; }
}

function header() {
  // The office's own logo: the isometric room it opens onto.
  const brand = h('div.brand', h('img', { src: '/assets/logo-256.png', alt: '', width: 44, height: 44 }), BRAND);
  return h('div.top', brand, h('span.grow'),
    updateNotice(),
    h('button.btn', { onclick: () => openTutorial(), title: 'A short tour of how the office works' }, '📘 How it works'),
    me ? h('button.btn.cr-me', { onclick: editProfile, title: 'Change your name or colour' }, avatar(me.displayName, me.color), h('b', me.displayName)) : null);
}

function render() {
  root.replaceChildren(header(), me ? lobby() : enter());
}

function editProfile() {
  modal('Your name and colour', (close) => {
    const name = h('input', { value: me.displayName, maxLength: 40 });
    const colour = colourPicker(me.color);
    const err = h('p.error');
    const save = async () => {
      try {
        ({ user: me } = await api('PATCH', '/api/crew/me', { displayName: name.value, color: colour.value }));
        close(); render();
      } catch (e) { err.textContent = e.message; }
    };
    return h('div', h('label', 'Name'), name, h('label', 'Colour'), colour, err,
      thisComputer.owner ? playersOnThisComputer(close) : null,
      h('div.actions', h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: save }, 'Save')));
  });
}

const offices = (n) => `${n} office${n === 1 ? '' : 's'}`;
const agents = (n) => `${n} agent${n === 1 ? '' : 's'}`;

async function continueAs(id) {
  ({ user: me } = await api('POST', '/api/crew/this-computer/player', { id }));
  thisComputer = await api('GET', '/api/crew/this-computer');
  render();
}

/** Only the host's own app sees this: switching is the machine's owner choosing who they are. */
function playersOnThisComputer(close) {
  const others = thisComputer.players.filter((p) => p.id !== me.id);
  if (!others.length) return null;
  return h('div', h('h3', 'Other players on this computer'), h('div.cr-list', ...others.map((p) => h('div.cr-item.row',
    avatar(p.displayName, p.color), h('div.grow', h('b', p.displayName), h('div.hint', `${offices(p.offices)} · ${agents(p.agents)}`)),
    h('button.btn.small', { onclick: async () => { close(); await continueAs(p.id); } }, 'Switch'),
    h('button.btn.small.danger', {
      onclick: async () => {
        if (!confirm(`Delete ${p.displayName}? ${p.offices ? `Their ${offices(p.offices)} and everything in them will be permanently deleted. ` : ''}This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/crew/this-computer/player/${p.id}`);
          thisComputer = await api('GET', '/api/crew/this-computer');
          close(); render(); toast(`${p.displayName} deleted`);
        } catch (e) { toast(e.message, 6000); }
      },
    }, 'Delete')))));
}

function enter() {
  const invited = Boolean(params.get('invite'));
  const err = h('p.error');
  const name = h('input', { placeholder: 'Your name', maxLength: 40, autocomplete: 'nickname', autofocus: true });
  const colour = colourPicker();
  const go = async () => {
    err.textContent = '';
    try {
      ({ user: me } = await api('POST', '/api/crew/enter', { name: name.value, color: colour.value }));
      if (invited && await acceptInvite()) return;
      render();
      tutorialOnFirstVisit();
    } catch (e) { err.textContent = e.message; name.focus(); }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => name.focus());
  const known = thisComputer.owner ? thisComputer.players : [];
  const onHostNotPaired = !thisComputer.owner && ['localhost', '127.0.0.1'].includes(location.hostname);
  return h('div.cr-enter.big',
    known.length
      ? [h('h2', 'Who’s using this computer?'),
        h('p.hint', 'Pick once and Crew Office remembers. You can switch later by pressing your name.'),
        h('div.cr-list', ...known.map((p) => h('button.cr-item.click.row.cr-player', {
          onclick: async () => { try { await continueAs(p.id); tutorialOnFirstVisit(); } catch (e) { err.textContent = e.message; } },
        }, avatar(p.displayName, p.color), h('span.grow', h('b', p.displayName)), h('span.hint', `${offices(p.offices)} · ${agents(p.agents)}`)))),
        h('h3', 'Or someone new')]
      : [h('h2', invited ? 'You’re invited' : 'Who are you?'),
        h('p.hint', invited ? 'Pick a name and a colour, and you’re in.' : 'A name and a colour are all you need. This browser remembers you.')],
    onHostNotPaired ? h('p.hint', h('b', 'Is this the computer hosting the office? '), 'Open Crew Office from its Desktop shortcut instead, so it recognises you. A name typed here makes a new player.') : null,
    name, h('label', 'Colour'), colour, err,
    h('button.btn.primary', { onclick: go }, invited ? 'Join office' : 'Enter'),
    h('p.hint', 'Your AI agents run on your own computer with your own sign-ins. The host never receives them.'),
    h('p.hint', 'Based on The Roving Office (Apache-2.0).'));
}

let view = 'home';
let hostedRoom = null;
let internet = null;

const recentKey = 'crew.recentOffices';
function recentOffices() { try { return JSON.parse(localStorage.getItem(recentKey)) ?? []; } catch { return []; } }
function rememberOffice(name, url) {
  try { localStorage.setItem(recentKey, JSON.stringify([{ name, url }, ...recentOffices().filter((r) => r.url !== url)].slice(0, 6))); } catch { /* it only saves typing */ }
}

function statusPill(s) {
  const tone = s?.state === 'online' ? 'ok' : s?.state === 'unavailable' ? 'bad' : ['connecting', 'reconnecting'].includes(s?.state) ? 'wait' : '';
  return h('span.cr-link', { class: tone }, s?.label ?? 'Hosting locally');
}

async function refreshInternet() {
  if (!thisComputer.owner) return null;
  internet = await api('GET', '/api/crew/internet').catch(() => null);
  return internet;
}

function lobby() {
  const box = h('div');
  const draw = () => box.replaceChildren(h('div.cr-fade', view === 'host' ? hostView(draw) : view === 'join' ? joinView(draw) : view === 'hosted' ? hostedView(draw) : homeView(draw)));
  draw();
  return box;
}

function back(draw) { return h('button.btn.small', { onclick: () => { view = 'home'; draw(); } }, '← Back'); }

function homeView(draw) {
  const viaRelay = info.viaRelay;
  return h('div',
    h('div.cr-two-actions',
      viaRelay ? null : h('button.cr-bigaction', { onclick: () => { view = 'host'; draw(); } }, h('b', 'Host Office'), h('span.hint', 'Make a room on this computer, and invite friends with a link.')),
      h('button.cr-bigaction', { onclick: () => { view = 'join'; draw(); } }, h('b', 'Join Office'), h('span.hint', 'Got an invitation? Paste it here, or just open the link.'))),
    myRooms(draw));
}

function hostView(draw) {
  const err = h('p.error');
  const name = h('input', { value: `${me.displayName}'s office`, maxLength: 40 });
  const privacy = h('select', h('option', { value: 'invite' }, 'Invite link: only people you send it to'), h('option', { value: 'password' }, 'Invite link, or code and password'), h('option', { value: 'lan' }, 'Open to my local network'));
  const pass = h('input', { type: 'password', placeholder: 'At least 4 characters' });
  const passRow = h('div', { style: { display: 'none' } }, h('label', 'Password'), pass);
  const max = h('input', { type: 'number', min: 1, max: 32, value: 6, style: { width: '110px' } });
  privacy.addEventListener('change', () => { passRow.style.display = privacy.value === 'password' ? '' : 'none'; });
  const go = async () => {
    err.textContent = '';
    try {
      const { room } = await api('POST', '/api/crew/rooms', { name: name.value, privacy: privacy.value, password: pass.value || undefined, maxPlayers: Number(max.value) });
      hostedRoom = room;
      view = 'hosted';
      draw();
    } catch (e) { err.textContent = e.message; }
  };
  return h('div.big', back(draw), h('h2', { style: { marginTop: '10px' } }, 'Host Office'),
    h('label', 'Office name'), name, h('label', 'Who can join'), privacy, passRow, h('label', 'Maximum players'), max, err,
    h('div.actions', h('button.btn.primary', { onclick: go }, 'Create')),
    internetSetup(draw));
}

/** Set up once. After that, hosting is just Create. */
function internetSetup(draw) {
  if (!thisComputer.owner) return null;
  const url = h('input', { placeholder: 'https://relay.example.com', value: internet?.relay ?? '' });
  const key = h('input', { type: 'password', placeholder: 'The key your relay was started with', autocomplete: 'off' });
  const note = h('p.hint');
  const save = async () => {
    try {
      internet = await api('PUT', '/api/crew/internet', { url: url.value, ...(key.value ? { key: key.value } : {}) });
      note.textContent = 'Saved. Connecting…';
      setTimeout(async () => { await refreshInternet(); draw(); }, 1500);
    } catch (e) { note.textContent = e.message; }
  };
  const box = h('details.cr-conn-group', h('summary', h('b', 'Advanced: networking')),
    h('p.hint', 'Internet invitations go through a relay: a small service that lets friends reach this computer with no port forwarding. Someone has to run it, on a cheap server of your own or a friend’s. It stores nothing, but it does see traffic pass through, so run it yourself or use one you trust.'),
    h('div.row', statusPill(internet), internet?.reason ? h('span.hint', internet.reason) : null),
    h('label', 'Relay address'), url, h('label', 'Relay key'), key, note,
    h('div.actions', h('button.btn', { onclick: save }, 'Save')),
    info.bind !== '127.0.0.1' && info.lanAddresses.length ? h('p.hint', `On your own network, this computer is ${info.lanAddresses.map((a) => `http://${a}:${info.port}`).join(', ')}.`) : h('p.hint', 'This office only listens on this computer.'),
    h('p.hint', 'Other ways in: a VPN mesh such as Tailscale, or your own tunnel. Forwarding a port exposes this computer, so prefer those.'));
  return box;
}

function hostedView(draw) {
  const room = hostedRoom;
  const box = h('div.big', h('h2', `“${room.name}” is open`), h('p.hint', 'Loading the invitation…'));
  (async () => {
    await refreshInternet();
    const { invite } = await api('POST', `/api/crew/rooms/${room.id}/invites`, { role: 'member', uses: 20 });
    const online = internet?.url ?? null;
    const lan = info.bind === '127.0.0.1' ? [] : info.lanAddresses.map((a) => `http://${a}:${info.port}`);
    const link = online ? `${online}/crew/join?invite=${invite.code}` : lan.length ? `http://${info.lanAddresses[0]}:${info.port}/crew/join?invite=${invite.code}` : null;
    const copy = (l) => navigator.clipboard?.writeText(l).then(() => toast('Invitation copied'), () => toast('Select the link and copy it by hand.'));
    let players = [];
    try { players = (await api('GET', `/api/crew/rooms/${room.id}/state`)).members ?? []; } catch { /* shown as none */ }
    box.replaceChildren(
      h('div.row', h('h2.grow', `“${room.name}” is open`), statusPill(internet)),
      online
        ? h('p', 'Send this to the people you want. They open it, pick a name, and they are in.')
        : h('p.cr-provider-note', `${link ? 'This link only works on your own network.' : 'This office only listens on this computer, so there is no link to share yet.'} ${internet?.configured ? `Internet hosting is not connected. ${internet?.reason ?? ''}` : 'To invite friends over the internet, set up a relay under Advanced.'}`),
      link ? h('div.cr-invite-link', h('code', link), h('button.btn.small.primary', { onclick: () => copy(link) }, 'Copy invitation')) : null,
      h('p.hint', `Works for 72 hours and 20 people. Revoke it any time under Security. Players here: ${players.map((m) => m.displayName).join(', ') || 'just you'} (of ${room.maxPlayers}).`),
      h('div.actions',
        h('button.btn', { onclick: () => { view = 'home'; draw(); } }, 'Room management'),
        h('button.btn.danger', { onclick: async () => { await api('POST', `/api/crew/rooms/${room.id}/status`, { status: 'stopped' }); toast('Stopped hosting. Everything is kept.'); view = 'home'; draw(); } }, 'Stop hosting'),
        h('button.btn.primary', { onclick: () => { location.href = `/office/${room.code}`; } }, 'Enter office')),
      internetSetup(draw));
  })().catch((e) => box.append(h('p.error', e.message)));
  return box;
}

function joinView(draw) {
  const input = h('input', { placeholder: 'Paste an invitation link', value: params.get('code') ?? '', autofocus: true });
  const pass = h('input', { type: 'password', placeholder: 'Password, if it has one' });
  const steps = h('ul.cr-steps');
  const help = h('div');
  const lan = h('div.cr-list', h('p.hint', 'Looking on your network…'));

  const show = (lines) => steps.replaceChildren(...lines.map(([text, state]) => h('li', { class: state }, `${state === 'done' ? '✓' : state === 'bad' ? '✕' : '•'} ${text}`)));
  const trouble = (lines) => help.replaceChildren(h('div.cr-provider-note', h('b', 'If it will not connect'), h('ul', ...lines.map((l) => h('li', l)))));

  const go = async () => {
    const raw = input.value.trim();
    help.replaceChildren();
    if (!raw) return;
    let link = null;
    try { const u = new URL(raw); if (['http:', 'https:'].includes(u.protocol)) link = u; } catch { /* a code */ }
    if (link) {
      if (!link.searchParams.get('invite') && !link.pathname.startsWith('/crew')) { show([['That does not look like an invitation link.', 'bad']]); return; }
      // Only ever opens a Crew Office join page. A pasted link cannot send this window elsewhere.
      const target = `${link.origin}/crew/join${link.search}`;
      show([['Going to the office…', 'on']]);
      rememberOffice(link.hostname, target);
      location.href = target;
      return;
    }
    show([['Looking for that office on this host…', 'on']]);
    try {
      const { room } = await api('POST', '/api/crew/rooms/join', { code: raw, password: pass.value || undefined });
      show([['Found it', 'done'], ['Entering…', 'on']]);
      rememberOffice(room.name, `/office/${room.code}`);
      location.href = `/office/${room.code}`;
    } catch (e) {
      show([[e.message, 'bad']]);
      trouble(['A room code only finds offices on this computer’s own host. For a friend’s office, paste the whole link they sent you.', 'Links expire after 72 hours, and can be revoked. Ask for a new one.', 'If the page says the office is not online, its host has to open Crew Office first.']);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  const refreshLan = async () => {
    if (info.viaRelay) { lan.replaceChildren(h('p.hint', 'Not available from here.')); return; }
    try {
      const { rooms } = await api('GET', '/api/crew/lan-rooms');
      const others = rooms.filter((r) => !r.local);
      lan.replaceChildren(...(others.length ? others.map((r) => h('div.cr-item.room.row', h('div.grow', h('b', r.name), h('div.hint', `${r.players}/${r.maxPlayers} players${r.hasPassword ? ' · password' : ''}`)), h('button.btn.small', { onclick: () => { location.href = `${r.host}/crew/join?code=${encodeURIComponent(r.code)}`; } }, 'Join'))) : [h('p.hint', 'None announced on this network right now.')]));
    } catch { /* discovery is optional */ }
  };
  refreshLan();
  const timer = setInterval(() => { if (lan.isConnected) refreshLan(); else clearInterval(timer); }, 5000);
  const recent = recentOffices();
  return h('div.big', back(draw), h('h2', { style: { marginTop: '10px' } }, 'Join Office'),
    h('label', 'Invitation link or room code'), input, h('label', 'Password'), pass,
    h('div.actions', h('button.btn.primary', { onclick: go }, 'Join')), steps, help,
    recent.length ? [h('h3', 'Recent offices'), h('div.cr-list', ...recent.map((r) => h('div.cr-item.click.row', { onclick: () => { location.href = r.url; } }, h('b.grow', r.name), h('span.hint', 'Open'))))] : null,
    h('h3', 'On your network'), lan);
}

function myRooms(draw) {
  const list = h('div.cr-list', h('p.hint', 'Loading…'));
  api('GET', '/api/crew/rooms').then(({ rooms }) => {
    list.replaceChildren(...(rooms.length ? rooms.map((r) => h('div.cr-item.room',
      h('div.grow', h('b', r.name), h('div.hint', `${r.myRole} · ${r.players}/${r.maxPlayers} players`, r.status !== 'open' ? h('span.pill.warn', ' stopped') : null)),
      r.myRole === 'owner' && !info.viaRelay ? h('button.btn.small', { onclick: () => { hostedRoom = r; view = 'hosted'; draw(); } }, 'Invite') : null,
      r.myRole === 'owner' ? h('button.btn.small', { onclick: async () => { await api('POST', `/api/crew/rooms/${r.id}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }); toast(r.status === 'open' ? 'Office stopped' : 'Office started'); render(); } }, r.status === 'open' ? 'Stop' : 'Start') : null,
      r.myRole === 'owner' ? h('button.btn.small.danger', { onclick: async () => { if (await confirmDeleteOffice(r)) { toast('Office deleted'); render(); } } }, 'Delete') : null,
      h('button.btn.small.primary', { onclick: () => { rememberOffice(r.name, `/office/${r.code}`); location.href = `/office/${r.code}`; } }, 'Enter'))) : [h('p.hint', 'No offices yet. Host one, or join a friend’s.')]));
  });
  return h('div.big', h('h2', 'Your offices'), list, thisComputer.owner ? h('div', { style: { marginTop: '10px' } }, internetSetup(() => render())) : null);
}

boot().catch((e) => { root.replaceChildren(h('p.error', `Could not load the lobby: ${e.message}`)); });
