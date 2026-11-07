'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHostConditions, weatherKind, parseCoordinates, locationOfZone } = require('../lib/crew/host-conditions.cjs');

const answering = (code, seen = []) => async (url) => {
  seen.push(url);
  return { ok: true, json: async () => ({ current: { weather_code: code } }) };
};

test('weather codes become the few kinds a window can show', () => {
  assert.equal(weatherKind(0), 'clear');
  assert.equal(weatherKind(3), 'cloudy');
  assert.equal(weatherKind(45), 'fog');
  assert.equal(weatherKind(61), 'rain');
  assert.equal(weatherKind(81), 'rain');
  assert.equal(weatherKind(73), 'snow');
  assert.equal(weatherKind(95), 'storm');
  assert.equal(weatherKind(undefined), null);
});

test('time zone table coordinates are read in both of their forms', () => {
  const lisbon = parseCoordinates('+3843-00908');
  assert.ok(Math.abs(lisbon.lat - 38.72) < 0.01 && Math.abs(lisbon.lon + 9.13) < 0.01);
  const longer = parseCoordinates('+404251-0740023');
  assert.ok(Math.abs(longer.lat - 40.71) < 0.01 && Math.abs(longer.lon + 74.01) < 0.01);
  assert.equal(parseCoordinates('nonsense'), null);
});

test('a time zone is found in the table, and an unknown one is not', () => {
  const readFile = () => '# comment\nPT\t+3843-00908\tEurope/Lisbon\tMadeira\n';
  assert.ok(locationOfZone('Europe/Lisbon', readFile));
  assert.equal(locationOfZone('Mars/Olympus', readFile), null);
  assert.equal(locationOfZone('Europe/Lisbon', () => { throw new Error('no table'); }), null);
});

test('the host reports its own time and its offset from UTC', () => {
  const now = () => 1_800_000_000_000;
  const read = createHostConditions({ env: { CREW_WEATHER: 'off' }, now }).read();
  assert.equal(read.now, 1_800_000_000_000);
  assert.equal(read.offsetMinutes, -new Date(1_800_000_000_000).getTimezoneOffset());
  assert.equal(read.weather, null);
});

test('only a rough location leaves this computer, and a set one wins over the time zone', async () => {
  const seen = [];
  const host = createHostConditions({ env: { CREW_WEATHER_LAT: '38.7223', CREW_WEATHER_LON: '-9.1393' }, fetchImpl: answering(61, seen) });
  await host.askForWeather();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /latitude=38\.7&longitude=-9\.1&current=weather_code$/);
  assert.equal(host.read().weather, 'rain');
});

test('it does not ask again for half an hour', async () => {
  const seen = [];
  let time = 0;
  const host = createHostConditions({ env: { CREW_WEATHER_LAT: '1', CREW_WEATHER_LON: '2' }, fetchImpl: answering(0, seen), now: () => time });
  await host.askForWeather();
  time = 29 * 60_000;
  await host.askForWeather();
  assert.equal(seen.length, 1);
  time = 31 * 60_000;
  await host.askForWeather();
  assert.equal(seen.length, 2);
});

test('CREW_WEATHER=off means no request at all', async () => {
  const seen = [];
  const host = createHostConditions({ env: { CREW_WEATHER: 'off', CREW_WEATHER_LAT: '1', CREW_WEATHER_LON: '2' }, fetchImpl: answering(0, seen) });
  await host.askForWeather();
  assert.equal(seen.length, 0);
});

test('a service that is down leaves the weather unknown and the time still answering', async () => {
  const host = createHostConditions({ env: { CREW_WEATHER_LAT: '1', CREW_WEATHER_LON: '2' }, fetchImpl: async () => { throw new Error('offline'); } });
  await host.askForWeather();
  assert.equal(host.read().weather, null);
  assert.ok(host.read().now > 0);
});
