import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cafeDayPhase,
  digestSlot,
  isSydneyRushTime,
  nextQuietTime,
  sydneyDayBounds,
  sydneyDate,
} from '../lib/owner-communication-model.ts';

test('café day phases and digest windows use Sydney local time', () => {
  const beforeOpen = new Date('2026-11-15T18:50:00.000Z');
  const afterClose = new Date('2026-11-16T05:10:00.000Z');
  assert.equal(sydneyDate(beforeOpen), '2026-11-16');
  assert.equal(cafeDayPhase(beforeOpen, '06:00', '16:00'), 'pre_open');
  assert.equal(digestSlot(beforeOpen, '06:00', '16:00'), 'pre_open');
  assert.equal(cafeDayPhase(afterClose, '06:00', '16:00'), 'wrap_up');
  assert.equal(digestSlot(afterClose, '06:00', '16:00'), 'wrap_up');
  assert.equal(digestSlot(new Date('2026-11-15T19:30:00.000Z'), '06:00', '16:00'), null);
});

test('rush-time decisions defer to the end of the active Sydney rush window', () => {
  const now = new Date('2026-11-15T21:15:00.000Z');
  const windows = [{ start: '07:00', end: '09:30' }, { start: '12:00', end: '13:30' }];
  assert.equal(isSydneyRushTime(now, windows), true);
  assert.equal(nextQuietTime(now, windows).toISOString(), '2026-11-15T22:30:00.000Z');
  assert.equal(isSydneyRushTime(new Date('2026-11-15T23:00:00.000Z'), windows), false);
});

test('Sydney day bounds account for daylight-saving offsets', () => {
  assert.deepEqual(sydneyDayBounds('2026-11-16'), {
    start: '2026-11-15T13:00:00.000Z',
    end: '2026-11-16T13:00:00.000Z',
  });
  assert.deepEqual(sydneyDayBounds('2026-06-01'), {
    start: '2026-05-31T14:00:00.000Z',
    end: '2026-06-01T14:00:00.000Z',
  });
});
