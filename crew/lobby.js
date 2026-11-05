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

function lobby() {
  const box = h('div');
  const hero = h('div.hero', hostCard(), joinCard());
  box.append(hero, h('div.grid2', myRooms(), connectHelp()));
  return box;
}

function hostCard() {
  const err = h('p.error');
  const name = h('input', { placeholder: `${me.displayName}'s office`, value: `${me.displayName}'s office` });
  const privacy = h('select', h('option', { value: 'invite' }, 'Invite link — only people you send it to'), h('option', { value: 'password' }, 'Password — anyone with the code and password'), h('option', { value: 'lan' }, 'Open — anyone who can reach this host'));
  const pass = h('input', { type: 'password', placeholder: 'Room password' });
  const passRow = h('div.grow', { style: { display: 'none' } }, h('label', 'Password'), pass);
  const max = h('input', { type: 'number', min: 1, max: 32, value: 6 });
  privacy.addEventListener('change', () => { passRow.style.display = privacy.value === 'password' ? '' : 'none'; });
  const go = async () => {
    err.textContent = '';
    try {
      const { room } = await api('POST', '/api/crew/rooms', { name: name.value, privacy: privacy.value, password: pass.value || undefined, maxPlayers: Number(max.value) });
      await hosted(room);
    } catch (e) { err.textContent = e.message; }
  };
  return h('div.big',
    h('h2', 'Host Office'),
    h('p.hint', info.mode === 'dedicated' ? 'This is a dedicated server: the office stays up when you leave.' : 'The office runs on this computer while the app is running. Projects and messages are saved on this computer.'),
    h('label', 'Office name'), name,
    h('label', 'Privacy'), privacy,
    h('div.row', passRow, h('div', { style: { width: '110px' } }, h('label', 'Max players'), max)),
    err, h('button.btn.primary', { onclick: go }, 'Host Office'));
}

async function hosted(room) {
  // The link is how people get in, so hosting makes one rather than leaving it as a chore.
  const { invite } = await api('POST', `/api/crew/rooms/${room.id}/invites`, { role: 'member', uses: 20 });
  const links = info.bind === '127.0.0.1' ? [] : info.lanAddresses.map((a) => `http://${a}:${info.port}/crew/join?invite=${invite.code}`);
  const copy = (l) => navigator.clipboard?.writeText(l).then(() => toast('Link copied'), () => toast('Select the link and copy it by hand.'));
  modalLike(h('div',
    h('h2', `“${room.name}” is open`),
    links.length
      ? [h('p', 'Send this link to the people you want to join. It works on your network for 72 hours and 20 people, and you can make more in the office.'),
        ...links.map((l) => h('div.row', h('code.grow', l), h('button.btn.small', { onclick: () => copy(l) }, 'Copy')))]
      : h('p.hint', 'This office only listens on this computer. To let people join, start Crew Office without “this computer only”.'),
    h('p.hint', 'For people outside your network, see “Playing over the internet” in the lobby.'),
    h('div.row', h('button.btn.primary', { onclick: () => { location.href = `/office/${room.code}`; } }, 'Enter office'), h('button.btn', { onclick: () => render() }, 'Back to lobby'))));
}

function modalLike(content) {
  root.replaceChildren(header(), h('div.big', content));
}

function joinCard() {
  const err = h('p.error');
  const code = h('input', { placeholder: 'ABCD-1234', value: params.get('code') ?? '', style: { textTransform: 'uppercase' } });
  const pass = h('input', { type: 'password', placeholder: 'Password, if the office has one' });
  const address = h('input', { placeholder: 'http://192.168.1.20:8080' });
  const lan = h('div.cr-list', h('p.hint', 'Looking for offices on your network…'));

  const join = async (body) => {
    err.textContent = '';
    try {
      const { room } = await api('POST', '/api/crew/rooms/join', body);
      location.href = `/office/${room.code}`;
    } catch (e) { err.textContent = e.message; }
  };

  const refreshLan = async () => {
    try {
      const { rooms } = await api('GET', '/api/crew/lan-rooms');
      lan.replaceChildren(...(rooms.length ? rooms.filter((r) => !r.local).map((r) => h('div.cr-item.room',
        h('div.grow', h('b', r.name), h('div.hint', `${r.players}/${r.maxPlayers} players · ${r.host}${r.hasPassword ? ' · password' : ''}`)),
        h('button.btn.small', { onclick: () => { location.href = `${r.host}/crew/join?code=${encodeURIComponent(r.code)}`; } }, 'Join'))) : [h('p.hint', 'No offices announced on this network right now. (Discovery works on the same Wi-Fi or switch only.)')]));
      if (rooms.length && !rooms.some((r) => !r.local)) lan.replaceChildren(h('p.hint', 'Only this computer’s own offices are announced right now.'));
    } catch { /* discovery is optional */ }
  };
  refreshLan();
  const timer = setInterval(refreshLan, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer));

  return h('div.big',
    h('h2', 'Join Office'),
    h('p.hint', 'Got an invitation link? Just open it. Otherwise:'),
    h('label', 'Room code (an office on this host)'), code,
    h('label', 'Password'), pass,
    h('div.row', { style: { marginTop: '8px' } }, h('button.btn.primary', { onclick: () => join({ code: code.value.trim(), password: pass.value || undefined }) }, 'Join')),
    err,
    h('label', 'On your network'), lan,
    h('label', 'Another host’s address'),
    h('div.row', h('div.grow', address), h('button.btn', {
      onclick: () => {
        const a = address.value.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(a)) { err.textContent = 'Addresses start with http:// or https://'; return; }
        location.href = `${a}/crew/join${code.value.trim() ? `?code=${encodeURIComponent(code.value.trim())}` : ''}`;
      },
    }, 'Go')),
    h('p.hint', 'Joining another host opens its lobby, where you pick a name for that host.'));
}

function myRooms() {
  const list = h('div.cr-list', h('p.hint', 'Loading…'));
  api('GET', '/api/crew/rooms').then(({ rooms }) => {
    list.replaceChildren(...(rooms.length ? rooms.map((r) => h('div.cr-item.room',
      h('div.grow', h('b', r.name), h('div.hint', h('span.code', r.code), ` · ${r.myRole} · ${r.players}/${r.maxPlayers} players · ${r.privacy}`, r.status !== 'open' ? h('span.pill.warn', ' stopped') : null)),
      r.myRole === 'owner' ? h('button.btn.small', {
        onclick: async () => { await api('POST', `/api/crew/rooms/${r.id}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }); toast(r.status === 'open' ? 'Office stopped' : 'Office started'); render(); },
      }, r.status === 'open' ? 'Stop' : 'Start') : null,
      r.myRole === 'owner' ? h('button.btn.small.danger', {
        onclick: async () => { if (await confirmDeleteOffice(r)) { toast('Office deleted'); render(); } },
      }, 'Delete') : null,
      h('button.btn.small.primary', { onclick: () => { location.href = `/office/${r.code}`; } }, 'Enter'))) : [h('p.hint', 'No offices yet — host one, or join a friend’s.')]));
  });
  return h('div.big', h('h2', 'Your offices on this host'), list);
}

function connectHelp() {
  const lanLine = info.lanAddresses.length && info.bind !== '127.0.0.1'
    ? h('p', 'This host is reachable on your network at ', ...info.lanAddresses.map((a) => h('code', `http://${a}:${info.port}`)), '.')
    : h('p', 'This host is listening only on this computer. Start it with ', h('code', 'npm run host'), ' to accept players from your network.');
  return h('div.big',
    h('h2', 'Playing over the internet'),
    lanLine,
    h('p.hint', 'On the same Wi-Fi or LAN, friends join with the address above — nothing else to set up.'),
    h('p.hint', 'From outside your network a direct connection is usually impossible without help, because your router hides this computer. Pick one:'),
    h('ul.hint',
      h('li', h('b', 'A VPN mesh'), ' such as Tailscale or ZeroTier: everyone installs it, and friends use your VPN address. Easiest and private.'),
      h('li', h('b', 'Port forwarding'), ` on your router to port ${info.port} of this computer, then share your public IP. Exposes this host to the internet: use a strong room password, and preferably HTTPS through a reverse proxy.`),
      h('li', h('b', 'A tunnel'), ' (e.g. Cloudflare Tunnel, ngrok) that gives this host a public HTTPS address.'),
      h('li', h('b', 'A dedicated server'), ' on a VPS or home server (Docker supported) that stays up when you are offline.')),
    h('p.hint', 'There is no built-in relay yet: nothing in this app connects through a third-party service.'));
}

boot().catch((e) => { root.replaceChildren(h('p.error', `Could not load the lobby: ${e.message}`)); });
