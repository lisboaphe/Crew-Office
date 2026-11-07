import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restingPose, workingPose } from '../src/office2d/desk-poses.js';

const sizes = JSON.parse(readFileSync(new URL('../assets/pixel-art/office/established/sprites.json', import.meta.url)));
const FRAMES_EACH = sizes.worker.frames / 6;

function over(pose, hash, seconds = 300) {
  const seen = new Map();
  for (let t = 0; t < seconds; t += 0.1) {
    const frame = pose(t, hash);
    seen.set(frame, (seen.get(frame) ?? 0) + 1);
  }
  return seen;
}

test('every pose is on the worker sheet', () => {
  for (const pose of [workingPose, restingPose]) {
    for (const frame of over(pose, 3).keys()) assert.ok(Number.isInteger(frame) && frame >= 0 && frame < FRAMES_EACH, String(frame));
  }
});

test('work is mostly typing, broken up by plenty of other things', () => {
  const seen = over(workingPose, 7);
  const total = [...seen.values()].reduce((a, b) => a + b, 0);
  const typing = (seen.get(5) ?? 0) + (seen.get(6) ?? 0);
  assert.ok(typing / total > 0.6 && typing / total < 0.9, String(typing / total));
  assert.ok(seen.size >= 8, `only ${seen.size} different frames`);
});

test('sitting back is not typing', () => {
  const seen = over(restingPose, 7);
  assert.ok(!seen.has(5) && !seen.has(6));
  assert.ok(seen.size >= 5);
});

test('nobody stays on one frame for long', () => {
  let last = null;
  let held = 0;
  let longest = 0;
  for (let t = 0; t < 300; t += 0.1) {
    const frame = workingPose(t, 11);
    held = frame === last ? held + 0.1 : 0;
    last = frame;
    longest = Math.max(longest, held);
  }
  assert.ok(longest < 3, String(longest));
});

test('people in one room are not moving in step', () => {
  let different = 0;
  for (let t = 0; t < 60; t += 0.5) if (workingPose(t, 1) !== workingPose(t, 2)) different += 1;
  assert.ok(different > 60);
});
