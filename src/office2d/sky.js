// What the host's time means for the view from the window. No drawing, so it can be tested alone.

/** Minutes past midnight at the host, from what the host reported and how long ago that was. */
export function hostMinutes({ hostNow, offsetMinutes, sinceReport = 0 }) {
  const minutes = (hostNow + sinceReport) / 60_000 + offsetMinutes;
  return ((minutes % 1440) + 1440) % 1440;
}

/** The part of the day, which picks the window's picture and how the room is lit. */
export function phaseOf(minutes) {
  const hour = minutes / 60;
  if (hour >= 5.5 && hour < 7.5) return 'dawn';
  if (hour >= 7.5 && hour < 18) return 'day';
  if (hour >= 18 && hour < 20) return 'dusk';
  return 'night';
}

/** Hours and minutes, for the clock's digits. */
export function clockText(minutes) {
  const whole = Math.floor(minutes);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
