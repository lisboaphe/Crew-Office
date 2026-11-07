// What it is like where the office is hosted: the time there and the weather outside, so the office's
// clock and windows match the host's computer, whoever is looking at them.
//
// Weather means asking Open-Meteo, a free service with no key, for the current conditions at a rough
// location, to one decimal place, and nothing else about this computer. The location is
// CREW_WEATHER_LAT and CREW_WEATHER_LON if they are set, otherwise a guess from the time zone. With
// no location, with CREW_WEATHER=off, or if the service cannot be reached, the weather is simply
// unknown and the window shows a clear sky.

'use strict';

const fs = require('fs');

const WEATHER_EVERY = 30 * 60_000;
const ZONE_TABLES = ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab'];

/** WMO weather codes, as Open-Meteo reports them, in the few kinds a window can show. */
function weatherKind(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return null;
}

/** ISO 6709 as the time zone tables write it, like +4043-07400, to decimal degrees. */
function parseCoordinates(text) {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(text);
  if (!match) return null;
  const degrees = (sign, d, m, s) => (sign === '-' ? -1 : 1) * (Number(d) + Number(m) / 60 + Number(s ?? 0) / 3600);
  return { lat: degrees(match[1], match[2], match[3], match[4]), lon: degrees(match[5], match[6], match[7], match[8]) };
}

/** Roughly where a time zone is, from the table most Unix systems carry. Null elsewhere. */
function locationOfZone(timeZone, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  for (const file of ZONE_TABLES) {
    let table;
    try { table = readFile(file); } catch { continue; }
    for (const line of table.split('\n')) {
      if (line.startsWith('#')) continue;
      const [, coordinates, zone] = line.split('\t');
      if (zone === timeZone) return parseCoordinates(coordinates);
    }
  }
  return null;
}

function createHostConditions({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, readFile } = {}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let weather = null;
  let askedAt = -Infinity;

  function location() {
    const lat = Number(env.CREW_WEATHER_LAT);
    const lon = Number(env.CREW_WEATHER_LON);
    if (env.CREW_WEATHER_LAT && env.CREW_WEATHER_LON && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    return locationOfZone(timeZone, readFile);
  }

  async function askForWeather() {
    if (env.CREW_WEATHER === 'off' || !fetchImpl) return;
    if (now() - askedAt < WEATHER_EVERY) return;
    askedAt = now();
    const place = location();
    if (!place) return;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(1)}&longitude=${place.lon.toFixed(1)}&current=weather_code`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      weather = weatherKind((await res.json()).current?.weather_code);
    } catch { /* the window can do without */ }
  }

  return {
    /** The host's time, and the weather as last heard. A slow answer never holds up the time. */
    read() {
      askForWeather();
      return { now: now(), offsetMinutes: -new Date(now()).getTimezoneOffset(), timeZone, weather };
    },
    askForWeather,
  };
}

module.exports = { createHostConditions, weatherKind, parseCoordinates, locationOfZone };
