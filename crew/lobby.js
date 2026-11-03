// The lobby: sign in on this host, Host Office, Join Office, and your offices.
//
// Like a game lobby, this page is served by whichever machine you opened it on. Hosting
// creates the office on *this* host; joining by code or invitation joins an office on this
// host; joining by address sends you to another host's lobby, where your account for that
// host lives.

import { h, api, toast, avatar, BRAND, reportErrors } from './common.js';

reportErrors('lobby');
const root = document.getElementById('lobby');
const params = new URLSearchParams(location.search);
let me = null;
let info = null;

async function boot() {
  [{ user: me }, info] = await Promise.all([api('GET', '/api/crew/me'), api('GET', '/api/crew/host-info')]);
  document.title = `${BRAND} — Lobby`;
  render();
}

function header() {
  // The office's own logo: the isometric room it opens onto.
  const brand = h('div.brand', h('img', { src: '/assets/logo-256.png', alt: '', width: 44, height: 44 }), BRAND);
  return h('div.top', brand, h('span.grow'),
    me ? h('div.row', avatar(me.displayName, me.color), h('b', me.displayName), h('span.muted', `@${me.username}`),
      h('button.btn.small', { onclick: async () => { await api('POST', '/api/crew/logout'); me = null; render(); } }, 'Sign out')) : null);
}

function render() {
  root.replaceChildren(header(), me ? lobby() : signIn());
}

function signIn() {
  const err = h('p.error');
  const user = h('input', { placeholder: 'username', autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: 'password (8+ characters)', autocomplete: 'current-password' });
  const name = h('input', { placeholder: 'Display name (optional)' });
  const color = h('input', { type: 'color', value: '#3d85c6', style: { width: '60px', height: '36px', padding: '2px' } });
  const go = async (mode) => {
    err.textContent = '';
    try {
      const body = { username: user.value.trim(), password: pass.value, displayName: name.value.trim() || undefined, color: color.value };
      ({ user: me } = await api('POST', mode === 'register' ? '/api/crew/register' : '/api/crew/login', body));
      render();
    } catch (e) { err.textContent = e.message; }
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('login'); });
  return h('div.grid2',
    h('div.big',
      h('h2', 'Sign in to this host'),
      h('p.hint', `Accounts live on the computer that hosts the office — like a game server's player list. If a friend is hosting, create your account on their host.`),
      h('label', 'Username'), user, h('label', 'Password'), pass,
      h('label', 'Display name and avatar colour (new accounts)'), h('div.row', h('div.grow', name), color),
      err,
      h('div.row', h('button.btn.primary', { onclick: () => go('login') }, 'Sign in'), h('button.btn', { onclick: () => go('register') }, 'Create account'))),
    h('div.big',
      h('h2', 'What is this?'),
      h('p', 'A shared office where every player brings their own team of AI employees. Host an office on your computer, invite friends, give the office a project, and watch the agents plan, talk to each other, write code, test and review it — on the office floor, in real time.'),
      h('p.hint', 'Your AI agents run on your own machine through a small worker program, with your own API keys. The host never receives your keys.'),
      h('p.hint', 'Based on The Roving Office (Apache-2.0).')));
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
  const privacy = h('select', h('option', { value: 'password' }, 'Password — anyone with the code and password'), h('option', { value: 'invite' }, 'Invite only — invitation links'), h('option', { value: 'lan' }, 'Open — anyone who can reach this host'));
  const pass = h('input', { type: 'password', placeholder: 'Room password' });
  const max = h('input', { type: 'number', min: 1, max: 32, value: 6 });
  privacy.addEventListener('change', () => { pass.disabled = privacy.value !== 'password'; });
  const go = async () => {
    err.textContent = '';
    try {
      const { room } = await api('POST', '/api/crew/rooms', { name: name.value, privacy: privacy.value, password: pass.value || undefined, maxPlayers: Number(max.value) });
      hosted(room);
    } catch (e) { err.textContent = e.message; }
  };
  return h('div.big',
    h('h2', 'Host Office'),
    h('p.hint', info.mode === 'dedicated' ? 'This is a dedicated server: the office stays up when you leave.' : 'The office runs on this computer while the app is running. Projects and messages are saved on this computer.'),
    h('label', 'Office name'), name,
    h('label', 'Privacy'), privacy,
    h('div.row', h('div.grow', h('label', 'Password'), pass), h('div', { style: { width: '110px' } }, h('label', 'Max players'), max)),
    err, h('button.btn.primary', { onclick: go }, 'Host Office'));
}

function hosted(room) {
  const links = info.lanAddresses.map((a) => `http://${a}:${info.port}/crew/join?code=${room.code}`);
  modalLike(h('div',
    h('h2', `“${room.name}” is open`),
    h('p', 'Room code: ', h('span.code', room.code)),
    links.length
      ? [h('p', 'Friends on your network join at:'), ...links.map((l) => h('p', h('code', l)))]
      : h('p.hint', 'This host only listens on this computer (127.0.0.1). To let friends join, restart it with HOST=0.0.0.0 (npm run host does this).'),
    h('p.hint', 'For friends outside your network, see “Playing over the internet” below.'),
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
  const invite = params.get('invite');

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
    invite ? h('div.card', { style: { marginBottom: '10px' } }, h('p', 'You have an invitation to an office on this host.'), h('button.btn.primary', { onclick: () => join({ invite }) }, 'Accept invitation')) : null,
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
    h('p.hint', 'Joining another host opens its lobby; you sign in there with an account on that host.'));
}

function myRooms() {
  const list = h('div.cr-list', h('p.hint', 'Loading…'));
  api('GET', '/api/crew/rooms').then(({ rooms }) => {
    list.replaceChildren(...(rooms.length ? rooms.map((r) => h('div.cr-item.room',
      h('div.grow', h('b', r.name), h('div.hint', h('span.code', r.code), ` · ${r.myRole} · ${r.players}/${r.maxPlayers} players · ${r.privacy}`, r.status !== 'open' ? h('span.pill.warn', ' stopped') : null)),
      r.myRole === 'owner' ? h('button.btn.small', {
        onclick: async () => { await api('POST', `/api/crew/rooms/${r.id}/status`, { status: r.status === 'open' ? 'stopped' : 'open' }); toast(r.status === 'open' ? 'Office stopped' : 'Office started'); render(); },
      }, r.status === 'open' ? 'Stop' : 'Start') : null,
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
