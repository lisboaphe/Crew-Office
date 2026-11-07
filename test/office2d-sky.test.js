import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockText, hostMinutes, phaseOf } from '../src/office2d/sky.js';

const at = (hour, minute = 0) => hour * 60 + minute;

test('the host\'s time comes from its report and its offset, not this browser', () => {
  const noon = Date.UTC(2026, 10, 7, 12, 0);
  assert.equal(hostMinutes({ hostNow: noon, offsetMinutes: 0 }), at(12));
  assert.equal(hostMinutes({ hostNow: noon, offsetMinutes: 60 }), at(13));
  assert.equal(hostMinutes({ hostNow: noon, offsetMinutes: -330 }), at(6, 30));
});

test('the host\'s time carries on from its last report, across midnight', () => {
  const late = Date.UTC(2026, 10, 7, 23, 59);
  assert.equal(hostMinutes({ hostNow: late, offsetMinutes: 0, sinceReport: 2 * 60_000 }), at(0, 1));
  const early = Date.UTC(2026, 10, 7, 0, 30);
  assert.equal(hostMinutes({ hostNow: early, offsetMinutes: -60 }), at(23, 30));
});

test('each part of the day has its window', () => {
  assert.equal(phaseOf(at(3)), 'night');
  assert.equal(phaseOf(at(6)), 'dawn');
  assert.equal(phaseOf(at(12)), 'day');
  assert.equal(phaseOf(at(19)), 'dusk');
  assert.equal(phaseOf(at(23)), 'night');
});

test('the clock reads as hours and minutes', () => {
  assert.equal(clockText(at(9, 5)), '09:05');
  assert.equal(clockText(at(23, 59) + 0.9), '23:59');
});
