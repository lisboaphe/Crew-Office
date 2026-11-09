// Talking to a project's agents in its channel: the player's own agents answer there, the ones they
// name or else the project's lead; anyone else's reads it later; and an agent knows its own words.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHost, player } = require('./lib/crew-harness.cjs');
const { makeCrew, room, agent } = require('./lib/crew-unit.cjs');

test('in a project’s channel, your own agents answer: the ones you name, or else its lead', { timeout: 60_000 }, async (t) => {
  const host = await startHost();
  const alice = player(host.url);
  const bob = player(host.url);
  t.after(async () => { alice.leaveAll(); bob.leaveAll(); await host.stop(); });
  await alice.post('/api/crew/register', { username: 'alice', password: 'alice-pass-1', displayName: 'Alice' });
  await bob.post('/api/crew/register', { username: 'bob', password: 'bob-pass-12', displayName: 'Bob' });
  const { room: rm } = await alice.post('/api/crew/rooms', { name: 'S', privacy: 'lan', maxPlayers: 4 });
  await bob.post('/api/crew/rooms/join', { code: rm.code });
  const R = `/api/crew/rooms/${rm.id}`;
  const mk = async (p, name) => (await p.post(`${R}/agents`, { name, role: 'Dev', provider: 'scripted', model: 'scripted' })).agent;
  const lead = await mk(alice, 'Leader');
  await mk(alice, 'Developer');
  await mk(bob, 'Boris');
  const { project } = await alice.post(`${R}/projects`, { name: 'Yomi', goal: 'g', managerAgentId: lead.id });
  await bob.post(`${R}/projects/${project.id}/join`);
  const channel = (await alice.get(`${R}/state`)).channels.find((c) => c.projectId === project.id);
  assert.ok(channel, 'the project has a channel');
  const say = (p, body) => p.post(`${R}/channels/${channel.id}/messages`, { body });

  const plain = await say(alice, 'How is the character coming along?');
  assert.deepEqual(plain.answering, ['Leader'], 'nobody named: the lead answers');
  assert.deepEqual(plain.inbox, []);

  const two = await say(alice, '@Developer and @Leader, can you two split the next step?');
  assert.deepEqual(two.answering.sort(), ['Developer', 'Leader'], 'everyone named answers');

  const others = await say(alice, '@Boris what do you think?');
  assert.deepEqual(others.answering, [], 'another player’s agent does not answer on their plan');
  assert.deepEqual(others.inbox, ['Boris'], 'it reads it on its next task');

  const fromBob = await say(bob, 'Anyone there?');
  assert.deepEqual(fromBob.answering, [], 'the lead is Alice’s, so Bob’s message does not spend her plan');
  assert.deepEqual(fromBob.inbox, ['Leader']);

  const ownForBob = await say(bob, '@Boris please look at this');
  assert.deepEqual(ownForBob.answering, ['Boris'], 'Bob’s own agent answers Bob');

  const history = await alice.get(`${R}/channels/${channel.id}/messages`);
  assert.equal(history.messages.length, 5, 'every message is in the channel, for everyone');
});

test('an agent answering in a channel sees who said what, and only its own words as its own', (t) => {
  const { crew, close } = makeCrew();
  t.after(close);
  const { alice, room: r } = room(crew);
  const leo = agent(crew, r.id, alice.id, 'Leader', 'Lead');
  const dev = agent(crew, r.id, alice.id, 'Developer', 'Dev');
  const pr = crew.work.createProject(r.id, alice.id, { name: 'Yomi', goal: 'g', managerAgentId: leo.id });
  const ch = crew.bus.channelsFor(r.id, alice.id).find((c) => c.projectId === pr.id);
  crew.bus.post({ roomId: r.id, channelId: ch.id, senderType: 'human', senderId: alice.id, kind: 'chat', body: 'Plan the next step.' });
  crew.bus.post({ roomId: r.id, channelId: ch.id, senderType: 'agent', senderId: leo.id, kind: 'chat', body: 'I will draft it.' });
  crew.bus.post({ roomId: r.id, channelId: ch.id, senderType: 'agent', senderId: dev.id, kind: 'chat', body: 'I can test it.' });
  const msg = crew.bus.post({ roomId: r.id, channelId: ch.id, senderType: 'human', senderId: alice.id, kind: 'chat', body: '@Developer go ahead.' });
  const job = crew.jobs.enqueue({ roomId: r.id, agentId: dev.id, type: 'chat', refId: msg.id, idemKey: `chat:${msg.id}:${dev.id}`, payload: { channelId: ch.id, userId: alice.id, projectId: pr.id } });
  const ctx = crew.work.buildContext(crew.db.get('SELECT * FROM jobs WHERE id = ?', job.id));
  assert.deepEqual(ctx.chat, { channel: ch.name, group: true, from: 'Alice' });
  assert.deepEqual(ctx.conversation.map((m) => [m.role, m.name]), [['user', 'Alice'], ['user', 'Leader'], ['assistant', 'Developer'], ['user', 'Alice']]);
});
