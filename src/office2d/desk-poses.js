// What somebody at a desk does from moment to moment, so nobody looks like a picture of a person.
// Only which frame to show at a given time: no drawing, and nothing to do with the agent's real work.
//
// Frames are numbered as they are on the worker sheet.

const TYPE_A = 5;
const TYPE_B = 6;
const BEHIND = 4;
const GLANCE_RIGHT = 7;
const GLANCE_LEFT = 10;
const LEAN_IN = 11;
const LOOK_UP = 12;
const STRETCH = 13;
const SIP = 14;
const SCRATCH = 15;

const TYPING_FPS = 6;
const typing = (seconds, fps = TYPING_FPS) => ({ seconds, frames: [TYPE_A, TYPE_B], fps });
const holding = (seconds, ...frames) => ({ seconds, frames, fps: frames.length / seconds });

// Mostly at the keyboard, with the small things people do between bursts of it.
const WORKING = [
  typing(7),
  holding(1.6, LEAN_IN),
  typing(5),
  holding(1.2, GLANCE_LEFT),
  typing(9, 8),
  holding(2.4, LOOK_UP, LOOK_UP, GLANCE_RIGHT),
  typing(4),
  holding(2.6, SIP),
  typing(8),
  holding(1.8, SCRATCH, BEHIND),
  typing(6, 4),
  holding(1.4, LEAN_IN),
  typing(10),
  holding(2.8, STRETCH, STRETCH, BEHIND),
];

// Sitting back: nothing much, in no hurry.
const RESTING = [
  holding(3, BEHIND),
  holding(1.6, GLANCE_RIGHT),
  holding(2.2, BEHIND),
  holding(2.8, SIP),
  holding(2, GLANCE_LEFT),
  holding(2.6, STRETCH, BEHIND),
  holding(2, LOOK_UP),
];

const lengthOf = (script) => script.reduce((sum, step) => sum + step.seconds, 0);

function frameIn(script, time) {
  let at = time % lengthOf(script);
  for (const step of script) {
    if (at < step.seconds) return step.frames[Math.floor(at * step.fps) % step.frames.length];
    at -= step.seconds;
  }
  return script[0].frames[0];
}

/** Each person is somewhere of their own in the routine, so a room does not move in step. */
const offsetOf = (hash, script) => (hash * 7.3) % lengthOf(script);

/** The frame for somebody at work, at a time in seconds. */
export function workingPose(time, hash) {
  return frameIn(WORKING, time + offsetOf(hash, WORKING));
}

/** The frame for somebody sitting back, at a time in seconds. */
export function restingPose(time, hash) {
  return frameIn(RESTING, time + offsetOf(hash, RESTING));
}
