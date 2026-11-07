// The lobby: pick a name, Host Office, Join Office, and your offices.
//
// Like a game lobby, this page is served by whichever machine you opened it on. Hosting
// creates the office on *this* host and makes it reachable. Joining by a link or a code finds
// the office wherever it is, and sends this window to that host's own join page, where you pick
// a name for that host. Networking words stay under Advanced.

import { h, api, toast, avatar, modal, colourPicker, confirmDeleteOffice, updateNotice, BRAND, reportErrors } from './common.js';
import { hangingLamp } from './lamp.js';
import { openTutorial, tutorialOnFirstVisit } from './tutorial.js';

reportErrors('lobby');
const root = document.getElementById('lobby');
const params = new URLSearchParams(location.search);
let me = null;
let info = null;
let thisComputer = { owner: false, players: [] };
/** An invitation addressed to this host: { invite | shortCode, room, error } */
let invitation = null;
/** Text handed to the app by the operating system. Only ever shown; the person decides. */
let opened = null;

// The same rule as lib/relay/invitation.cjs, for what a page has to decide before asking anyone.
const shortCodeOf = (raw) => {
  const c = String(raw ?? '').trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(c) ? c : null;
};

/** The app's window arrives carrying this computer's key. Trade it for a cookie, and tidy the address. */
async function pairWithComputer() {
  const key = params.get('this-pc');
  opened = params.get('open');
  if (!key && !opened) return;
  params.delete('this-pc');
  params.delete('open');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  if (!key) return;
  try { await api('POST', '/api/crew/this-computer/pair', { key }); } catch { /* another host's key: carry on as anyone would */ }
}

async function readInvitation() {
  const invite = params.get('invite');
  const shortCode = shortCodeOf(params.get('code'));
  if (!invite && !shortCode) return;
  invitation = invite ? { invite } : { shortCode };
  try {
    const q = invite ? `invite=${encodeURIComponent(invite)}` : `code=${shortCode}`;
    ({ room: invitation.room } = await api('GET', `/api/crew/invitations/preview?${q}`));
  } catch (e) { invitation.error = e.message; }
}

async function boot() {
  await pairWithComputer();
  [{ user: me }, info, thisComputer] = await Promise.all([api('GET', '/api/crew/me'), api('GET', '/api/crew/host-info'), api('GET', '/api/crew/this-computer')]);
  document.title = `${BRAND} — Lobby`;
  await readInvitation();
  if (opened) view = 'join';
  await refreshInternet();
  render();
  if (me && !invitation) tutorialOnFirstVisit();
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
  root.replaceChildren(header(), invitation ? invited() : me ? lobby() : enter(), hangingLamp());
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

/** The join page: who invited you and to what, before you decide. */
function invited() {
  const leave = () => { invitation = null; history.replaceState(null, '', '/crew'); render(); };
  if (invitation.error) {
    return h('div.cr-enter.big', h('h2', 'This invitation does not work'), h('p.error', invitation.error),
      h('p.hint', 'Invitations can expire or be revoked. Ask whoever sent it for a new one.'),
      h('button.btn', { onclick: leave }, 'Go to the lobby'));
  }
  const room = invitation.room;
  const err = h('p.error');
  const name = h('input', { placeholder: 'Your name', maxLength: 40, autocomplete: 'nickname' });
  const colour = colourPicker();
  const pass = h('input', { type: 'password', placeholder: 'The office’s password', autocomplete: 'off' });
  const go = async () => {
    err.textContent = '';
    try {
      if (!me) ({ user: me } = await api('POST', '/api/crew/enter', { name: name.value, color: colour.value }));
      const { room: joined } = await api('POST', '/api/crew/rooms/join', { ...(invitation.invite ? { invite: invitation.invite } : { shortCode: invitation.shortCode }), password: pass.value || undefined });
      location.href = `/office/${joined.code}`;
    } catch (e) { err.textContent = e.message; }
  };
  const onEnter = (e) => { if (e.key === 'Enter') go(); };
  name.addEventListener('keydown', onEnter);
  pass.addEventListener('keydown', onEnter);
  setTimeout(() => (me ? pass : name).focus());
  const stopped = room.status !== 'open';
  const here = ['localhost', '127.0.0.1'].includes(location.hostname);
  return h('div.cr-enter.big',
    h('h2', 'You’re invited'),
    h('div.cr-invite-card', h('b', room.name), h('div.hint', `Hosted by ${room.hostName} · ${room.players} of ${room.maxPlayers} players`)),
    stopped ? h('p.cr-provider-note', 'The host has stopped this office for now. Ask them to start it again.') : null,
    me ? h('p.hint', `Joining as ${me.displayName}.`) : [h('label', 'Your name'), name, h('label', 'Colour'), colour],
    room.needsPassword ? [h('label', 'Password'), pass] : null,
    err,
    h('div.actions', h('button.btn', { onclick: leave }, 'Not now'), h('button.btn.primary', { onclick: go, disabled: stopped }, 'Join office')),
    h('p.hint', 'You only need this page to join. To bring your own AI agents, connect a worker from My Crew once you are in: they run on your computer with your own sign-ins, and the host never receives those.'),
    !here && invitation.invite ? h('p.hint', 'Have Crew Office installed? ', h('a', { href: `crewoffice://join?host=${encodeURIComponent(location.origin)}&invite=${encodeURIComponent(invitation.invite)}` }, 'Open this in the app.')) : null);
}

function enter() {
  const err = h('p.error');
  const name = h('input', { placeholder: 'Your name', maxLength: 40, autocomplete: 'nickname', autofocus: true });
  const colour = colourPicker();
  const go = async () => {
    err.textContent = '';
    try {
      ({ user: me } = await api('POST', '/api/crew/enter', { name: name.value, color: colour.value }));
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
      : [h('h2', 'Who are you?'),
        h('p.hint', 'A name and a colour are all you need. This browser remembers you.')],
    onHostNotPaired ? h('p.hint', h('b', 'Is this the computer hosting the office? '), 'Open Crew Office from its Desktop shortcut instead, so it recognises you. A name typed here makes a new player.') : null,
    name, h('label', 'Colour'), colour, err,
    h('button.btn.primary', { onclick: go }, 'Enter'),
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
  const tone = s?.state === 'online' ? 'ok' : s?.state === 'unavailable' ? 'bad' : ['connecting', 'verifying', 'reconnecting'].includes(s?.state) ? 'wait' : '';
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
      h('button.cr-bigaction', { onclick: () => { view = 'join'; draw(); } }, h('b', 'Join Office'), h('span.hint', 'Got an invitation? Paste the link or the room code.'))),
    myRooms(draw));
}

async function startHosting(room, draw) {
  await api('POST', `/api/crew/rooms/${room.id}/hosting`, { on: true });
  hostedRoom = room;
  view = 'hosted';
  draw();
}

function hostView(draw) {
  const err = h('p.error');
  const which = h('select', h('option', { value: '' }, 'A new office'));
  const name = h('input', { value: `${me.displayName}'s office`, maxLength: 40 });
  const privacy = h('select', h('option', { value: 'invite' }, 'Invitation only'), h('option', { value: 'password' }, 'Invitation, or room code and password'), h('option', { value: 'lan' }, 'Invitation, or anyone on my network'));
  const pass = h('input', { type: 'password', placeholder: 'At least 4 characters' });
  const passRow = h('div', { style: { display: 'none' } }, h('label', 'Password'), pass);
  const max = h('input', { type: 'number', min: 1, max: 32, value: 6, style: { width: '110px' } });
  const friends = h('p.hint', 'Friends who join will show up here.');
  const fresh = h('div', h('label', 'Office name'), name, h('label', 'Who can join'), privacy, passRow, h('label', 'Maximum players'), max);
  privacy.addEventListener('change', () => { passRow.style.display = privacy.value === 'password' ? '' : 'none'; });
  let mine = [];
  api('GET', '/api/crew/rooms').then(({ rooms }) => {
    mine = rooms.filter((r) => r.myRole === 'owner');
    which.replaceChildren(h('option', { value: '' }, 'A new office'), ...mine.map((r) => h('option', { value: r.id }, r.name)));
  }).catch(() => { /* a new office still works */ });
  which.addEventListener('change', async () => {
    const chosen = mine.find((r) => r.id === which.value);
    fresh.style.display = chosen ? 'none' : '';
    if (!chosen) { friends.textContent = 'Friends who join will show up here.'; return; }
    friends.textContent = `${chosen.players} of ${chosen.maxPlayers} players have joined this office.`;
  });
  const go = async () => {
    err.textContent = '';
    try {
      const chosen = mine.find((r) => r.id === which.value);
      const room = chosen ?? (await api('POST', '/api/crew/rooms', { name: name.value, privacy: privacy.value, password: pass.value || undefined, maxPlayers: Number(max.value) })).room;
      await startHosting(room, draw);
    } catch (e) { err.textContent = e.message; }
  };
  return h('div.big', back(draw), h('h2', { style: { marginTop: '10px' } }, 'Host Office'),
    h('label', 'Office'), which, fresh, h('label', 'Connected friends'), friends, err,
    h('div.actions', h('button.btn.primary', { onclick: go }, 'Host Office')),
    internetSetup(draw));
}

/** Nobody needs this for the normal path. It is for running your own relay, or your own network. */
function internetSetup(draw) {
  if (!thisComputer.owner) return null;
  const url = h('input', { placeholder: 'https://relay.example.org', value: internet?.relay ?? '' });
  const key = h('input', { type: 'password', placeholder: 'The key your relay was started with', autocomplete: 'off' });
  const note = h('p.hint');
  const save = async () => {
    try {
      internet = await api('PUT', '/api/crew/internet', { url: url.value, ...(key.value ? { key: key.value } : {}) });
      note.textContent = url.value ? 'Saved. Connecting…' : 'Saved. Back to the automatic service.';
      setTimeout(async () => { await refreshInternet(); draw(); }, 1500);
    } catch (e) { note.textContent = e.message; }
  };
  return h('details.cr-conn-group', h('summary', h('b', 'Advanced settings')),
    h('p.hint', internet?.manual ? 'This computer is using the relay below rather than the automatic service. Clear the address to go back.' : internet?.service ? 'Crew Office finds its internet service by itself. Set a relay here only if you run your own.' : 'This copy of Crew Office has no automatic internet service, so set a relay here to invite friends over the internet. It is a small program someone has to run on a server. It stores nothing, but it does see traffic pass through, so run it yourself or use one you trust.'),
    h('div.row', statusPill(internet), internet?.reason ? h('span.hint', internet.reason) : null),
    h('label', 'Relay address'), url, h('label', 'Relay key'), key, note,
    h('div.actions', h('button.btn', { onclick: save }, 'Save')),
    info.bind !== '127.0.0.1' && info.lanAddresses.length ? h('p.hint', `On your own network, this computer is ${info.lanAddresses.map((a) => `http://${a}:${info.port}`).join(', ')}.`) : h('p.hint', 'This office only listens on this computer.'),
    h('p.hint', 'Other ways in: a VPN mesh such as Tailscale, or your own tunnel. Forwarding a port exposes this computer, so prefer those.'));
}

function copier(what, text) {
  return () => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Select it and copy it by hand.'));
}

/** Waiting, or why not. Says nothing is ready until the host has proved that it is. */
function hostingProblem(s) {
  const i = s.internet;
  if (!thisComputer.owner) return h('p.cr-provider-note', 'Open Crew Office from its shortcut on the computer hosting this office to invite friends over the internet.');
  if (['connecting', 'verifying'].includes(i.state)) return h('p', 'Making this office reachable over the internet. Your invitation appears as soon as it has been checked from outside.');
  if (i.state === 'reconnecting') return h('p.cr-provider-note', `Trying to get back online. Friends already here will reconnect by themselves. ${i.reason ?? ''}`);
  if (i.state === 'unavailable') return h('p.cr-provider-note', i.reason ?? 'The internet service cannot be reached right now. Retrying.');
  return h('p.cr-provider-note', 'This office is on your computer only. Press Host Office to make it reachable.');
}

function hostedView(draw) {
  const room = hostedRoom;
  const body = h('div', h('h2', `“${room.name}”`), h('p.hint', 'Loading…'));
  let last = '';
  const refresh = async () => {
    const s = await api('GET', `/api/crew/rooms/${room.id}/hosting`);
    internet = s.internet;
    const seen = JSON.stringify(s);
    if (seen === last) return;
    last = seen;
    const players = s.players;
    const online = players.filter((p) => p.online).length;
    const revoke = async () => {
      if (!confirm('Revoke this invitation? The link and room code stop working at once. Friends already in the office stay.')) return;
      await api('DELETE', `/api/crew/rooms/${room.id}/invites/${encodeURIComponent(s.invite.code)}`);
      toast('Invitation revoked');
      await refresh();
    };
    const renew = async () => { await api('POST', `/api/crew/rooms/${room.id}/hosting`, { on: true }); await refresh(); };
    const expires = s.invite ? new Date(s.invite.expiresAt).toLocaleString() : '';
    body.replaceChildren(h('div',
      h('div.row', h('h2.grow', `“${s.room.name}”`), statusPill(s.internet), s.internet.transport === 'relay' ? h('span.cr-link', 'Relay connection') : null),
      s.link
        ? [h('p', 'Send this to your friends. They open it, pick a name, and they are in. Nothing to install.'),
          h('div.cr-invite-link', h('code', s.link), h('button.btn.small.primary', { onclick: copier('Invitation', s.link) }, 'Copy Invitation')),
          s.invite.shortCode ? h('div.cr-room-code', h('span.hint', 'Room code'), h('b', s.invite.shortCode), h('button.btn.small', { onclick: copier('Room code', s.invite.shortCode) }, 'Copy')) : null,
          h('p.hint', `Works until ${expires}, for ${s.invite.usesLeft} more ${s.invite.usesLeft === 1 ? 'person' : 'people'}.`)]
        : s.room.status !== 'open' ? h('p.cr-provider-note', 'This office is stopped. Press Host Office to open it again.')
          : s.invite ? hostingProblem(s) : h('p.cr-provider-note', 'This invitation was revoked. Make a new one when you want to invite someone.'),
      h('h3', `Connected players (${online} of ${players.length})`),
      h('div.cr-list', ...players.map((p) => h('div.cr-item.row', avatar(p.displayName, p.color), h('b.grow', p.displayName), h('span.cr-link', { class: p.online ? 'ok' : '' }, p.online ? 'Here' : 'Away')))),
      h('div.actions',
        h('button.btn', { onclick: () => { view = 'home'; draw(); } }, '← Lobby'),
        s.room.status !== 'open' ? h('button.btn.primary', { onclick: renew }, 'Host Office') : s.invite ? h('button.btn', { onclick: revoke }, 'Revoke Invitation') : h('button.btn', { onclick: renew }, 'New invitation'),
        s.room.status === 'open' ? h('button.btn.danger', { onclick: async () => { await api('POST', `/api/crew/rooms/${room.id}/hosting`, { on: false }); toast('Stopped hosting. Everything is kept.'); await refresh(); } }, 'Stop Hosting') : null,
        h('button.btn.primary', { onclick: () => { location.href = `/office/${s.room.code}`; } }, 'Enter office')),
      s.lanLink ? h('details.cr-conn-group', h('summary', h('b', 'On your own network')),
        h('p.hint', 'For someone on the same Wi-Fi or LAN. It connects directly, without encryption, so use it only on a network you trust.'),
        h('div.cr-invite-link', h('code', s.lanLink), h('button.btn.small', { onclick: copier('Link', s.lanLink) }, 'Copy'))) : null));
  };
  const timer = setInterval(() => { if (!body.isConnected) { clearInterval(timer); return; } refresh().catch(() => {}); }, 2000);
  refresh().catch((e) => body.append(h('p.error', e.message)));
  // Outside what the timer redraws, so it does not snap shut while someone is typing in it.
  return h('div.big', body, internetSetup(draw));
}

function joinView(draw) {
  const fromApp = opened;
  opened = null;
  const looksLikeCode = shortCodeOf(fromApp);
  const linkInput = h('input', { placeholder: 'https://…', value: fromApp && !looksLikeCode ? fromApp : '', autofocus: true, 'aria-label': 'Paste Invitation Link' });
  const codeInput = h('input.cr-code-input', { placeholder: 'ABCDE-FGHIJ', maxLength: 16, autocomplete: 'off', value: looksLikeCode ?? '', 'aria-label': 'Enter Room Code' });
  const steps = h('ul.cr-steps');
  const help = h('div');
  const lan = h('div.cr-list', h('p.hint', 'Looking on your network…'));

  const show = (lines) => steps.replaceChildren(...lines.map(([text, state]) => h('li', { class: state }, `${state === 'done' ? '✓' : state === 'bad' ? '✕' : '•'} ${text}`)));
  const trouble = (lines) => help.replaceChildren(h('div.cr-provider-note', h('b', 'If it will not connect'), h('ul', ...lines.map((l) => h('li', l)))));

  const go_to = (found) => {
    const label = found.room?.name ?? (found.origin ? new URL(found.origin).hostname : 'Office');
    if (found.origin) rememberOffice(label, `${found.origin}/crew`);
    location.href = found.url;
  };

  // Through a relay there is no local host to ask, so a page asks the service directly.
  const resolveFromPage = async (text) => {
    const code = shortCodeOf(text);
    if (code) {
      const r = await fetch(`/_relay/resolve/${code}`);
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? 'No office with that code.');
      return { url: `${out.url}/crew/join?code=${code}`, origin: out.url, transport: 'relay' };
    }
    const u = new URL(text);
    if (u.protocol !== 'https:' || !u.searchParams.get('invite')) throw new Error('That is not an invitation link or a room code.');
    return { url: `${u.origin}/crew/join?invite=${encodeURIComponent(u.searchParams.get('invite'))}`, origin: u.origin, transport: 'link' };
  };

  const go = async (confirmFirst = false) => {
    const text = (linkInput.value || codeInput.value).trim();
    help.replaceChildren();
    if (!text) { show([['Paste an invitation link, or enter a room code.', 'bad']]); return; }
    show([['Looking up the office…', 'on']]);
    try {
      const found = info.viaRelay ? await resolveFromPage(text) : await api('POST', '/api/crew/invitations/resolve', { text });
      const where = found.room ? `Found “${found.room.name}”, hosted by ${found.room.hostName}` : 'Found the office';
      if (confirmFirst) {
        // The operating system handed this over, so it may have come from anywhere: the person decides.
        show([[where, 'done']]);
        const place = found.origin ? new URL(found.origin).hostname : 'this computer';
        help.replaceChildren(h('div.cr-invite-card', h('b', found.room?.name ?? 'An office'), h('div.hint', `${found.room ? `Hosted by ${found.room.hostName} · ` : ''}at ${place}`),
          h('div.actions', h('button.btn.primary', { onclick: () => go_to(found) }, 'Join this office'))));
        return;
      }
      show([[where, 'done'], [found.transport === 'direct' ? 'Connecting directly on your network…' : 'Connecting…', 'on']]);
      go_to(found);
    } catch (e) {
      show([[e.message, 'bad']]);
      trouble(['Check the code, or paste the whole link your friend sent you.', 'Invitations expire, and can be revoked. Ask for a new one.', 'If the office is not online, its host has to open Crew Office first.']);
    }
  };
  for (const input of [linkInput, codeInput]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  if (fromApp) setTimeout(() => go(true));

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

  // Advanced: an address, or an office's keycard on this host, with its password.
  const address = h('input', { placeholder: 'http://192.168.1.20:8080' });
  const keycard = h('input', { placeholder: 'ABCD-1234', value: params.get('code') && !shortCodeOf(params.get('code')) ? params.get('code') : '' });
  const pass = h('input', { type: 'password', placeholder: 'Password, if it has one' });
  const advancedNote = h('p.error');
  const goAddress = () => {
    advancedNote.textContent = '';
    try {
      const u = new URL(address.value.trim());
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      rememberOffice(u.hostname, `${u.origin}/crew`);
      location.href = `${u.origin}/crew`;
    } catch { advancedNote.textContent = 'That is not an address. It looks like http://192.168.1.20:8080'; }
  };
  const goKeycard = async () => {
    advancedNote.textContent = '';
    try {
      const { room } = await api('POST', '/api/crew/rooms/join', { code: keycard.value.trim(), password: pass.value || undefined });
      rememberOffice(room.name, `/office/${room.code}`);
      location.href = `/office/${room.code}`;
    } catch (e) { advancedNote.textContent = e.message; }
  };

  const recent = recentOffices();
  return h('div.big', back(draw), h('h2', { style: { marginTop: '10px' } }, 'Join Office'),
    h('label', 'Paste Invitation Link'), linkInput,
    h('div.cr-or', 'or'),
    h('label', 'Enter Room Code'), codeInput,
    h('div.actions', h('button.btn.primary', { onclick: () => go() }, 'Join')), steps, help,
    recent.length ? [h('h3', 'Recent Offices'), h('div.cr-list', ...recent.map((r) => h('div.cr-item.click.row', { onclick: () => { location.href = r.url; } }, h('b.grow', r.name), h('span.hint', 'Open'))))] : null,
    h('details.cr-conn-group', { open: Boolean(keycard.value) }, h('summary', h('b', 'Advanced settings')),
      h('h3', 'On your network'), lan,
      h('h3', 'Another computer’s address'), h('div.row', h('div.grow', address), h('button.btn', { onclick: goAddress }, 'Go')),
      h('h3', 'An office on this computer'), h('label', 'Its keycard'), keycard, h('label', 'Password'), pass,
      h('div.actions', h('button.btn', { onclick: goKeycard }, 'Join')), advancedNote));
}

function myRooms(draw) {
  const list = h('div.cr-list', h('p.hint', 'Loading…'));
  api('GET', '/api/crew/rooms').then(({ rooms }) => {
    list.replaceChildren(...(rooms.length ? rooms.map((r) => h('div.cr-item.room',
      h('div.grow', h('b', r.name), h('div.hint', `${r.myRole} · ${r.players}/${r.maxPlayers} players`, r.status !== 'open' ? h('span.pill.warn', ' stopped') : r.internetHosted ? h('span.pill', ' hosting') : null)),
      r.myRole === 'owner' && !info.viaRelay ? h('button.btn.small', {
        onclick: async () => {
          try {
            if (r.internetHosted && r.status === 'open') { hostedRoom = r; view = 'hosted'; draw(); } else await startHosting(r, draw);
          } catch (e) { toast(e.message, 6000); }
        },
      }, r.internetHosted && r.status === 'open' ? 'Invite' : 'Host') : null,
      r.myRole === 'owner' ? h('button.btn.small', { onclick: async () => { await api('POST', `/api/crew/rooms/${r.id}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }); toast(r.status === 'open' ? 'Office stopped' : 'Office started'); render(); } }, r.status === 'open' ? 'Stop' : 'Start') : null,
      r.myRole === 'owner' ? h('button.btn.small.danger', { onclick: async () => { if (await confirmDeleteOffice(r)) { toast('Office deleted'); render(); } } }, 'Delete') : null,
      h('button.btn.small.primary', { onclick: () => { rememberOffice(r.name, `/office/${r.code}`); location.href = `/office/${r.code}`; } }, 'Enter'))) : [h('p.hint', 'No offices yet. Host one, or join a friend’s.')]));
  });
  return h('div.big', h('h2', 'Your offices'), list);
}

boot().catch((e) => { root.replaceChildren(h('p.error', `Could not load the lobby: ${e.message}`)); });
